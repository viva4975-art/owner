import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import {
  assignCustomerPick,
  assignInvoices,
  getTransaction,
  openCorrectionCredits,
  separableCorrections,
} from './bank.js';
import { createReductionCorrection } from './invoices.js';
import { DEMO } from './seed.js';
import { type FakeMailer, dbAvailable, freshDatabase, kositAvailable, testDeps } from './testing.js';
import { type Deps, issueInvoice } from './workflow.js';

const available = (await kositAvailable()) && (await dbAvailable());

// Ahmed 20.10.: Kunde zahlt die Rechnung voll, zieht die Rechnungskorrektur erst mit der nächsten Zahlung ab.
describe.skipIf(!available)('Rechnungskorrektur separat verrechnen', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  const a = randomUUID();
  const b = randomUUID();
  const imp = randomUUID();
  const legacy = async (id: string, no: string, gross: number) => {
    await sql`insert into app.legacy_invoices (id, number, issue_date, due_date, customer_id, net_cents, gross_cents, paid)
              values (${id}, ${no}, '2026-09-30', '2026-10-14', ${DEMO.authority}, ${Math.round(gross / 1.19)}, ${gross}, false)`;
    await sql`insert into app.legacy_invoice_lines (id, invoice_id, position, title, quantity_milli, unit, unit_price_cents,
                                                   net_cents, period_start, period_end, site_id)
              values (${randomUUID()}, ${id}, 1, 'Unterhaltsreinigung', 1000, 'pauschal', ${Math.round(gross / 1.19)},
                      ${Math.round(gross / 1.19)}, '2026-09-01', '2026-09-30', ${DEMO.siteSchool})`;
  };
  const bankTx = async (amount: number) => {
    const id = randomUUID();
    await sql`insert into app.bank_transactions (id, import_id, account_iban, booking_date, amount_cents, counterparty_name, purpose)
              values (${id}, ${imp}, 'DE39701900000003297837', '2026-10-20', ${amount}, 'Stadt', 'Zahlung')`;
    return id;
  };
  const open = async (id: string) =>
    (
      await sql<{ o: bigint }[]>`select open_cents as o from app.legacy_open_items where invoice_id = ${id}`
    )[0]?.o ?? 0n;
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
    await legacy(a, '1038300', 119000);
    await legacy(b, '1038301', 238000);
    await sql`insert into app.bank_imports (id, filename, format, file_path, file_sha256, line_count, new_count, created_by)
              values (${imp}, 'test.csv', 'csv', ${`x/${imp}`}, ${randomUUID()}, 2, 2, 't')`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('volle Zahlung → Korrektur als Guthaben, nächste Zahlung zieht es ab', async () => {
    const k = await createReductionCorrection(sql, a, { grossCents: 50690n, reason: 'Mängel' }, 't');
    await issueInvoice(deps, k, 't');
    expect(await open(a)).toBe(68310n);
    expect((await separableCorrections(sql, DEMO.authority)).map((x) => x.id)).toEqual([k]);

    // Monat 1: Kunde zahlt 1.190,00 € (Korrektur nicht abgezogen) – ohne Korrektur = Überzahlung
    const t1 = (await getTransaction(sql, await bankTx(119000)))!;
    await expect(assignCustomerPick(sql, t1, [`L:${a}`], false, 't')).rejects.toThrow(/Überzahlung: 506,90/);
    await assignCustomerPick(sql, t1, [`L:${a}`, `K:${k}`], false, 't');
    expect(await open(a)).toBe(0n);
    expect(await separableCorrections(sql, DEMO.authority)).toHaveLength(0);
    const [g] = await openCorrectionCredits(sql, DEMO.authority);
    expect(g!.remaining_cents).toBe(50690n);

    // Monat 2: Kunde zahlt 2.380,00 − 506,90 = 1.873,10 €
    const t2 = (await getTransaction(sql, await bankTx(187310)))!;
    await assignCustomerPick(sql, t2, [`L:${b}`, `G:${g!.id}`], false, 't');
    await assignCustomerPick(sql, t2, [`L:${b}`, `G:${g!.id}`], false, 't'); // doppelt → nichts doppelt
    expect(await openCorrectionCredits(sql, DEMO.authority)).toHaveLength(0);
    const [paid] = await sql<{ paid: boolean }[]>`select paid from app.legacy_invoices where id = ${b}`;
    expect(paid!.paid).toBe(true);
  });

  it('Summe muss stimmen, Korrektur nur einmal als Guthaben', async () => {
    const t3 = await bankTx(1000);
    await expect(
      assignInvoices(sql, t3, [{ invoiceId: b, legacy: true, amount: 500n, skonto: 0n }], 't'),
    ).rejects.toThrow(/Summe/);
  });

  it('„Komplett bezahlt“: 5 % gelten für die Summe, Differenz anteilig verteilt', async () => {
    const c = randomUUID();
    const d = randomUUID();
    await legacy(c, '1038310', 1000000); // 10.000,00
    await legacy(d, '1038311', 100000); // 1.000,00
    // Kunde zahlt 11.000 − 50,00 (0,45 % gesamt, aber 5 % auf die kleinere Rechnung allein)
    const t = (await getTransaction(sql, await bankTx(1095000)))!;
    await assignCustomerPick(sql, t, [`L:${c}`, `L:${d}`], true, 't');
    expect(await open(c)).toBe(0n);
    expect(await open(d)).toBe(0n);
    const sk = await sql<{ s: bigint }[]>`
      select coalesce(sum(amount_cents), 0)::bigint as s from app.legacy_payments
       where method = 'skonto' and invoice_id in (${c}, ${d})`;
    expect(sk[0]!.s).toBe(5000n);
    const t2 = (await getTransaction(sql, await bankTx(50000)))!;
    const e = randomUUID();
    await legacy(e, '1038312', 100000);
    await expect(assignCustomerPick(sql, t2, [`L:${e}`], true, 't')).rejects.toThrow(/mehr als 5 %/);
  });
});
