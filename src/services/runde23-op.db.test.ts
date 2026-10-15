import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openItemLedger, settleOpenItem } from './payments.js';
import { createReductionVoucher } from './reduction-vouchers.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Runde 23: Offene Posten – Teilzahlung und Skonto (Datenbank)', () => {
  let sql: Sql;
  const cust = randomUUID();
  const today = todayBerlin();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.customers (id, customer_no, name, street, postal_code, city)
              values (${cust}, '29977', 'OP Test GmbH', 'Weg 1', '80331', 'München')`;
  });
  afterAll(async () => {
    await sql?.end();
  });
  const legacy = (no: string, gross: bigint) =>
    sql`insert into app.legacy_invoices (id, number, issue_date, due_date, customer_id, customer_no, net_cents,
                                         gross_cents, paid, ft_root_id)
        values (${randomUUID()}, ${no}, ${addDays(today, -40)}, ${addDays(today, -20)}, ${cust}, '29977',
                ${(gross * 100n) / 119n}, ${gross}, false, ${`r${no}`}) returning id`.then(
      (r) => r[0]!.id as string,
    );

  it('Fortytools-Rechnung: Teilzahlung lässt Rest offen, Skonto bucht Rest aus, doppelt absenden bucht nichts', async () => {
    const a = await legacy('9700001', 100000n);
    const b = await legacy('9700002', 50000n);
    const batch = randomUUID();
    const base = { batchId: batch, legacy: true, date: today, reference: 'KA 1', actor: 't' };
    await settleOpenItem(sql, { ...base, invoiceId: a, amount: 40000n, rest: 'offen' });
    await settleOpenItem(sql, { ...base, invoiceId: b, amount: 48500n, rest: 'skonto' });
    // doppelt
    await settleOpenItem(sql, { ...base, invoiceId: a, amount: 40000n, rest: 'offen' });
    const [g] = await openItemLedger(sql, { customerId: cust });
    expect(g!.items.map((i) => [i.number, i.open_cents])).toEqual([['9700001', 60000n]]);
    expect(g!.items[0]!.haben.map((h) => h.cents)).toEqual([40000n]);
    const [pb] = await sql<{ paid: boolean }[]>`select paid from app.legacy_invoices where id = ${b}`;
    expect(pb!.paid).toBe(true);
    const sk = await sql<{ method: string; amount_cents: bigint }[]>`
      select method, amount_cents from app.legacy_payments where invoice_id = ${b} order by method desc`;
    expect(sk.map((x) => [x.method, x.amount_cents])).toEqual([
      ['zahlung', 48500n],
      ['skonto', 1500n],
    ]);
    await expect(
      settleOpenItem(sql, { ...base, batchId: randomUUID(), invoiceId: a, amount: 70000n, rest: 'offen' }),
    ).rejects.toThrow(/höher/);
    await expect(sql`delete from app.legacy_payments`).rejects.toThrow();
  });
  it('Kürzung: Rest wird mit Grund ausgebucht (ohne Beleg an den Kunden), ohne Grund abgelehnt', async () => {
    const c = await legacy('9700003', 20000n);
    const base = { batchId: randomUUID(), legacy: true, date: today, reference: null, actor: 't' };
    await expect(
      settleOpenItem(sql, { ...base, invoiceId: c, amount: 15000n, rest: 'kuerzung' }),
    ).rejects.toThrow(/Grund/);
    await settleOpenItem(sql, {
      ...base,
      invoiceId: c,
      amount: 15000n,
      rest: 'kuerzung',
      reason: 'Mängelabzug',
    });
    const rows = await sql<{ method: string; amount_cents: bigint }[]>`
      select method, amount_cents from app.legacy_payments where invoice_id = ${c} order by amount_cents desc`;
    expect(rows.map((x) => [x.method, x.amount_cents])).toEqual([
      ['zahlung', 15000n],
      ['kuerzung', 5000n],
    ]);
    const [pc] = await sql<{ paid: boolean }[]>`select paid from app.legacy_invoices where id = ${c}`;
    expect(pc!.paid).toBe(true);
    // interner Buchungsbeleg (PDF) für den Steuerberater, doppelt anlegen legt nichts doppelt an
    const dir = await mkdtemp(join(tmpdir(), 'viva-kb-'));
    try {
      const p = {
        key: 'k1',
        invoiceId: c,
        legacy: true,
        grossCents: 5000n,
        date: today,
        reason: 'Mängelabzug',
        actor: 't',
      };
      const v1 = await createReductionVoucher(sql, { dir, maxBytes: 5e7 }, p);
      const v2 = await createReductionVoucher(sql, { dir, maxBytes: 5e7 }, p);
      expect(v1.number).toMatch(/^KB-\d{4}-0001$/);
      expect(v2.id).toBe(v1.id);
      expect(v1.net_cents + v1.vat_cents).toBe(5000n);
      expect(v1.net_cents).toBe(4202n);
      const [f] =
        await sql`select 1 from app.file_links where file_id = ${v1.file_id} and entity_type = 'customer'`;
      expect(f).toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
