import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { saveSupplier } from './inventory.js';
import {
  createCreditNote,
  invoiceFromStatement,
  listCreditNotes,
  nuStatement,
  sendCreditNote,
  setSelfBilling,
  skipStatement,
} from './nu-statement.js';
import { DEMO } from './seed.js';
import { cancelSubcontract, revokeCancellation } from './subcontract-cancel.js';
import { addSubcontractHours } from './subcontract-hours.js';
import { saveSubcontract, setSubcontractStatus } from './subcontractors.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();

describe.skipIf(!available)('NU-Abrechnung je Monat', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  let files: { sql: Sql; filesDir: string; maxBytes: number };
  const nu = randomUUID();
  const flat = randomUUID();
  const day = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    const dir = await mkdtemp(join(tmpdir(), 'viva-files-'));
    const d = await testDeps(sql);
    deps = Object.assign(d, { env: { ...d.env, FILES_DIR: dir } });
    files = { sql, filesDir: dir, maxBytes: 50_000_000 };
    await saveSupplier(
      sql,
      nu,
      {
        supplier_no: '70500',
        name: 'Sub Abrechnung GmbH',
        kind: 'nachunternehmer',
        payment_terms_days: '14',
        email: 'sub@example.org',
        active: 'on',
      },
      null,
      't',
    );
    const base = {
      supplierId: nu,
      siteId: DEMO.siteSchool,
      serviceKind: 'Unterhaltsreinigung',
      frequency: 'monatlich',
      maxHours: null,
      validFrom: '2026-10-01',
      validTo: null,
      description: null,
      note: null,
    };
    await saveSubcontract(sql, flat, { ...base, billing: 'pauschale_monat', priceCents: 100000n }, 't');
    await saveSubcontract(sql, day, { ...base, siteId: DEMO.siteOffice, billing: 'tag', priceCents: 5000n }, 't');
    await sql`update app.subcontracts set regie_rate_cents = 3000 where id = ${flat}`;
    for (const id of [flat, day]) await setSubcontractStatus(sql, id, 'erteilt', 't', { acceptMissing: true });
    // 2 Personen × 1,5 Std. Regie im November
    await addSubcontractHours(sql, {
      id: randomUUID(),
      subcontractId: flat,
      workDate: '2026-11-12',
      persons: 2,
      minutesPerPerson: 90,
      note: null,
      actor: 't',
      regie: true,
    });
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Blatt: Pauschale, je Tag (Arbeitstage ohne Feiertage) und Regie', async () => {
    const st = await nuStatement(sql, nu, '2026-11');
    const byKey = new Map(st.lines.map((l) => [l.key, l]));
    expect(byKey.get(`${flat}|grund`)!.amount).toBe(100000n);
    // November 2026: 21 Werktage Mo–Fr (Allerheiligen fällt auf Sonntag)
    expect(byKey.get(`${day}|grund`)!.amount).toBe(5000n * 21n);
    expect(byKey.get(`${flat}|regie`)!.amount).toBe(9000n);
    expect(st.lines.every((l) => l.state === 'offen')).toBe(true);
    expect(st.openTotal).toBe(100000n + 105000n + 9000n);
  });

  it('Rechnung des NU erfassen: Beträge je Bestellung ergeben den Rechnungsbetrag, Monat danach abgerechnet', async () => {
    const st = await nuStatement(sql, nu, '2026-11');
    const id = randomUUID();
    const picked = st.lines.map((l) => ({ key: l.key, amount: l.amount! }));
    const p = {
      id,
      supplierId: nu,
      month: '2026-11',
      picked,
      invoiceNo: 'R-2026-11',
      invoiceDate: '2026-12-02',
      dueDate: null,
      net: 210000n, // weicht ab (4.000 € weniger)
      vat: 0n,
      reverseCharge: true,
      note: null,
      file: null,
    };
    await invoiceFromStatement(files, p, 't');
    await invoiceFromStatement(files, p, 't'); // doppelt → nichts
    const links = await sql<{ net_cents: bigint }[]>`
      select net_cents from app.incoming_invoice_subcontracts where incoming_invoice_id = ${id}`;
    expect(links.length).toBe(2);
    expect(links.reduce((a, l) => a + BigInt(l.net_cents), 0n)).toBe(210000n);
    const [inv] = await sql<{ note: string | null; category: string }[]>`
      select note, category from app.incoming_invoices where id = ${id}`;
    expect(inv!.note).toMatch(/Abweichung/);
    const after = await nuStatement(sql, nu, '2026-11');
    expect(after.lines.every((l) => l.state === 'abgerechnet')).toBe(true);
    // Kostenstellen: auf beide Objekte verteilt
    const alloc = await sql<{ n: number }[]>`
      select count(distinct site_id)::int as n from app.cost_allocations where incoming_invoice_id = ${id}`;
    expect(alloc[0]!.n).toBe(2);
  });

  it('Gutschrift nur mit Vereinbarung und Steuernummer; Nummer GS, § 13b, freigegeben, doppelt = einmal', async () => {
    const st = await nuStatement(sql, nu, '2026-12');
    const picked = st.lines.map((l) => ({ key: l.key, amount: l.amount! }));
    const p = {
      id: randomUUID(),
      supplierId: nu,
      month: '2026-12',
      picked,
      extras: [{ text: 'Abzug 03.12. nicht gereinigt', amount: -5000n }],
      date: '2026-12-31',
      note: null,
    };
    await expect(createCreditNote(files, p, 't')).rejects.toThrow(/kein Gutschriftverfahren/);
    await expect(
      setSelfBilling(sql, nu, { since: '2026-12-01', vat: '13b', taxNo: null, vatId: null }, 't'),
    ).rejects.toThrow(/Steuernummer/);
    await setSelfBilling(sql, nu, { since: '2026-12-01', vat: '13b', taxNo: '143/123/45678', vatId: null }, 't');
    const r = await createCreditNote(files, p, 't');
    expect(r.number).toMatch(/^GS-2026-\d{4}$/);
    const again = await createCreditNote(files, p, 't');
    expect(again.number).toBe(r.number);
    const [inv] = await sql<
      { status: string; net_cents: bigint; vat_cents: bigint; reverse_charge: boolean; invoice_no: string }[]
    >`select status, net_cents, vat_cents, reverse_charge, invoice_no from app.incoming_invoices where id = ${p.id}`;
    const sum = picked.reduce((a, x) => a + x.amount, 0n) - 5000n;
    expect(inv).toMatchObject({ status: 'freigegeben', vat_cents: 0n, reverse_charge: true, invoice_no: r.number });
    expect(BigInt(inv!.net_cents)).toBe(sum);
    expect((await listCreditNotes(sql, { supplierId: nu })).length).toBe(1);
    const sent = await sendCreditNote(deps, p.id, 't');
    expect(sent.length).toBe(1);
    expect(deps.mailer.sent.at(-1)!.attachments[0]!.filename).toMatch(/Gutschrift_GS-/);
  });

  it('keine Rechnung vermerken; einzelne Bestellung kündigen und zurücknehmen', async () => {
    const st = await nuStatement(sql, nu, '2027-01');
    const n = await skipStatement(sql, nu, '2027-01', [st.lines[0]!.key], 'Objekt geschlossen', 't');
    expect(n).toBe(1);
    expect((await nuStatement(sql, nu, '2027-01')).lines[0]!.state).toBe('keine');

    await cancelSubcontract(
      files,
      day,
      { date: '2027-03-31', reason: 'Kunde kündigt', reasonInLetter: false, note: null },
      't',
    );
    const [sc] = await sql<{ valid_to: string; cancel_file_id: string | null; status: string }[]>`
      select valid_to::text, cancel_file_id, status from app.subcontracts where id = ${day}`;
    expect(sc!.valid_to).toBe('2027-03-31');
    expect(sc!.cancel_file_id).not.toBeNull();
    await expect(
      cancelSubcontract(files, day, { date: '2027-04-30', reason: null, reasonInLetter: false, note: null }, 't'),
    ).rejects.toThrow(/schon gekündigt/);
    await revokeCancellation(sql, day, 't');
    const [back] = await sql<{ valid_to: string | null; cancelled_on: string | null }[]>`
      select valid_to::text, cancelled_on::text from app.subcontracts where id = ${day}`;
    expect(back).toMatchObject({ valid_to: null, cancelled_on: null });
  });
});
