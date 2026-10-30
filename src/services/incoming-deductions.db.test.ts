import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { addDeduction, deleteDeduction, listDeductions } from './incoming-deductions.js';
import { markPaid, paymentList, paymentRemittance } from './purchasing.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();
const SUP = '00000000-0000-4000-8000-00000000de01';

describe.skipIf(!available)('Abzüge bei der Prüfung einer Eingangsrechnung', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.suppliers (id, supplier_no, name, kind) values (${SUP}, '79811', 'Abzug Sub GmbH', 'nachunternehmer')`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('mindert Zahlbetrag und Kosten, USt anteilig, doppelt = nichts, bezahlt = fest', async () => {
    const [site] = await sql<{ id: string }[]>`select id from app.sites order by site_no limit 1`;
    const inv = randomUUID();
    await sql`insert into app.incoming_invoices (id, supplier_id, invoice_no, invoice_date, due_date, service_month, site_id,
                                                 net_cents, vat_cents, gross_cents, category, status, created_by)
              values (${inv}, ${SUP}, 'AB-1', '2026-10-01', '2026-10-15', '2026-10-01', ${site!.id},
                      100000, 19000, 119000, 'nachunternehmer', 'freigegeben', 't')`;
    await sql`insert into app.cost_allocations (id, incoming_invoice_id, site_id, month, net_cents, auto, created_by)
              values (${randomUUID()}, ${inv}, ${site!.id}, '2026-10-01', 100000, true, 't')`;
    const key = randomUUID();
    const p = {
      kind: 'nicht_gereinigt' as const,
      reason: '16.10. nicht gereinigt',
      from: '2026-10-16',
      to: null,
      amount: 10000n,
      isGross: false,
    };
    expect(await addDeduction(sql, key, inv, p, 't')).toBe(true);
    expect(await addDeduction(sql, key, inv, p, 't')).toBe(false);
    const [d] = await listDeductions(sql, inv);
    expect(d!.vat_cents).toBe(1900n);
    expect(d!.gross_cents).toBe(11900n);
    expect(d!.site_id).toBe(site!.id);
    const row = (await paymentList(sql, '2026-10-10')).find((x) => x.invoice.id === inv)!;
    expect(row.amount).toBe(107100n);
    expect(paymentRemittance(row.invoice, row.skonto)).toBe(
      'Rechnung AB-1 vom 01.10.2026 abzgl. Abzug 119,00 € (16.10. nicht gereinigt)',
    );
    const [cost] = await sql<{ net: bigint }[]>`
      select sum(net_cents)::bigint as net from app.incoming_cost_lines where incoming_invoice_id = ${inv}`;
    expect(cost!.net).toBe(90000n);
    await expect(addDeduction(sql, randomUUID(), inv, { ...p, amount: 200000n }, 't')).rejects.toThrow(
      /übersteigen/,
    );

    const extra = randomUUID();
    await addDeduction(sql, extra, inv, { ...p, amount: 1190n, isGross: true }, 't');
    await deleteDeduction(sql, extra, 't');
    expect((await listDeductions(sql, inv)).length).toBe(1);

    await markPaid(
      sql,
      { ids: [inv], date: '2026-10-10', method: 'ueberweisung', note: null, skonto: false },
      't',
    );
    const [paid] = await sql<{ paid_amount_cents: bigint }[]>`
      select paid_amount_cents from app.incoming_invoices where id = ${inv}`;
    expect(paid!.paid_amount_cents).toBe(107100n);
    await expect(deleteDeduction(sql, d!.id, 't')).rejects.toThrow(/bezahlt/);
  });
});
