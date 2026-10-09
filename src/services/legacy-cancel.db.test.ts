import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { copyLegacyToDraft, createLegacyCancellation, getInvoice, loadDocument } from './invoices.js';
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
});
