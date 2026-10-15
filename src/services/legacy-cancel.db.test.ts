import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  copyLegacyToDraft,
  createLegacyCancellation,
  createLegacyCorrection,
  getInvoice,
  loadDocument,
} from './invoices.js';
import { writeOffPart } from './payments.js';
import { createReductionVoucher } from './reduction-vouchers.js';
import { DEMO } from './seed.js';
import { type FakeMailer, dbAvailable, freshDatabase, kositAvailable, testDeps } from './testing.js';
import { type Deps, issueInvoice } from './workflow.js';

const available = (await kositAvailable()) && (await dbAvailable());

describe.skipIf(!available)('Storno einer Rechnung von vor der Umstellung (Fortytools)', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  const legacy = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
    await sql`insert into app.legacy_invoices (id, number, issue_date, due_date, customer_id, net_cents, gross_cents, paid)
              values (${legacy}, '1038200', '2026-09-30', '2026-10-14', ${DEMO.authority}, 100000, 119000, false)`;
    await sql`insert into app.legacy_invoice_lines (id, invoice_id, position, title, quantity_milli, unit, unit_price_cents,
                                                   net_cents, period_start, period_end, site_id)
              values (${randomUUID()}, ${legacy}, 1, 'Unterhaltsreinigung September', 1000, 'pauschal', 100000, 100000,
                      '2026-09-01', '2026-09-30', ${DEMO.siteSchool})`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Stornorechnung mit neuer Nummer, Verweis auf die alte Nummer, KoSIT-gültig, offener Posten ausgeglichen', async () => {
    const [before] = await sql<{ open_cents: bigint }[]>`
      select open_cents from app.legacy_open_items where invoice_id = ${legacy}`;
    expect(before!.open_cents).toBe(119000n);
    const id = await createLegacyCancellation(sql, legacy, 't');
    expect(await createLegacyCancellation(sql, legacy, 't')).toBe(id); // doppelt → derselbe Entwurf
    const doc = await loadDocument(sql, id);
    expect(doc.kind).toBe('cancellation');
    expect(doc.lines[0]!.quantity).toBe(-1000n);
    await issueInvoice(deps, id, 't');
    const inv = (await getInvoice(sql, id))!;
    expect(inv.invoice.status).toBe('issued');
    expect(inv.original?.number).toBe('1038200');
    expect(inv.invoice.number).not.toBe('1038200');
    const [after] = await sql<{ open_cents: bigint }[]>`
      select open_cents from app.legacy_open_items where invoice_id = ${legacy}`;
    expect(after!.open_cents).toBe(0n);
  });

  it('neu ausstellen = Entwurf mit den Positionen der alten Rechnung', async () => {
    const id = await copyLegacyToDraft(sql, legacy, 't');
    const d = (await getInvoice(sql, id))!;
    expect(d.invoice.status).toBe('draft');
    expect(d.lines[0]!.description).toBe('Unterhaltsreinigung September');
    expect(d.lines[0]!.net_cents).toBe(100000n);
    expect(d.invoice.site_id).toBe(DEMO.siteSchool);
  });

  it('Kürzung und Rechnungskorrektur zu einer zweiten alten Rechnung', async () => {
    const l2 = randomUUID();
    await sql`insert into app.legacy_invoices (id, number, issue_date, due_date, customer_id, net_cents, gross_cents, paid)
              values (${l2}, '1038201', '2026-09-30', '2026-10-14', ${DEMO.authority}, 100000, 119000, false)`;
    await sql`insert into app.legacy_invoice_lines (id, invoice_id, position, title, quantity_milli, unit, unit_price_cents,
                                                   net_cents, period_start, period_end, site_id)
              values (${randomUUID()}, ${l2}, 1, 'Unterhaltsreinigung September', 1000, 'pauschal', 100000, 100000,
                      '2026-09-01', '2026-09-30', ${DEMO.siteSchool})`;
    const open = async () =>
      (
        await sql<
          { open_cents: bigint }[]
        >`select open_cents from app.legacy_open_items where invoice_id = ${l2}`
      )[0]!.open_cents;
    // interne Kürzung 119 € brutto, doppelt abgeschickt → einmal gebucht, ein Beleg
    const p = {
      key: 'k1',
      invoiceId: l2,
      legacy: true,
      amount: 11900n,
      date: '2026-10-15',
      reason: 'Mängel',
      actor: 't',
    };
    expect(await writeOffPart(sql, p)).toBe(true);
    expect(await writeOffPart(sql, p)).toBe(false);
    expect(await open()).toBe(107100n);
    const dir = await mkdtemp(join(tmpdir(), 'viva-kb-'));
    const v = await createReductionVoucher(sql, { dir, maxBytes: 5e7 }, { ...p, grossCents: 11900n });
    expect(v.number).toMatch(/^KB-\d{4}-\d{4}$/);
    await expect(writeOffPart(sql, { ...p, key: 'k2', amount: 200000n })).rejects.toThrow(/höher/);
    // Rechnungskorrektur 100 € netto → nach Ausstellen offen −119 €
    await expect(createLegacyCorrection(sql, l2, { netCents: 200000n, reason: 'x' }, 't')).rejects.toThrow(
      /höher/,
    );
    const id = await createLegacyCorrection(
      sql,
      l2,
      { netCents: 10000n, reason: 'Fenster nicht gereinigt' },
      't',
    );
    const doc = await loadDocument(sql, id);
    expect(doc.kind).toBe('correction');
    expect(doc.lines[0]!.quantity).toBe(-1000n);
    await issueInvoice(deps, id, 't');
    expect((await getInvoice(sql, id))!.original?.number).toBe('1038201');
    expect(await open()).toBe(95200n);
  });
});
