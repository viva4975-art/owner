import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import { collectBookings } from './datev.js';
import { markPaid, paymentList, undoPaid } from './purchasing.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();
const SUPPLIER = '00000000-0000-4000-8000-000000000221';

describe.skipIf(!available)('Zahlungsliste', () => {
  let sql: Sql;
  const today = todayBerlin();
  const id = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.suppliers (id, supplier_no, name, iban) values (${SUPPLIER}, '79001', 'Test Lieferant', 'DE02120300000000202051')
              on conflict (id) do nothing`;
    await sql`insert into app.incoming_invoices (id, supplier_id, invoice_no, invoice_date, due_date, net_cents, vat_cents,
                gross_cents, category, skonto_until, skonto_percent_bp, status, created_by)
              values (${id}, ${SUPPLIER}, 'ZL-1', ${today}, ${addDays(today, 30)}, 10000, 1900, 11900, 'material',
                      ${addDays(today, 5)}, 200, 'freigegeben', 't')`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Skonto bis Skontodatum, bezahlt festhalten, doppelt = nichts, zurücknehmen, DATEV', async () => {
    const [p] = (await paymentList(sql, today)).filter((x) => x.invoice.id === id);
    expect(p).toMatchObject({ skonto: 238n, amount: 11662n });
    expect((await paymentList(sql, addDays(today, 6))).find((x) => x.invoice.id === id)!.skonto).toBe(0n);
    await expect(
      markPaid(
        sql,
        { ids: [id], date: addDays(today, 1), method: 'ueberweisung', note: null, skonto: true },
        't',
      ),
    ).rejects.toThrow(/Zukunft/);
    expect(
      await markPaid(sql, { ids: [id], date: today, method: 'ueberweisung', note: null, skonto: true }, 't'),
    ).toBe(1);
    expect(
      await markPaid(sql, { ids: [id], date: today, method: 'ueberweisung', note: null, skonto: true }, 't'),
    ).toBe(0);
    const [r] =
      await sql`select status, paid_amount_cents, paid_skonto_cents from app.incoming_invoices where id = ${id}`;
    expect(r).toEqual({ status: 'bezahlt', paid_amount_cents: 11662n, paid_skonto_cents: 238n });
    await expect(sql`update app.incoming_invoices set net_cents = 1 where id = ${id}`).rejects.toThrow(
      /abgeschlossen/,
    );
    const { bookings } = await collectBookings(sql, {
      from: today,
      to: today,
      outgoing: false,
      incoming: true,
      payments: true,
    });
    expect(
      bookings.some((b) => b.kind === 'zahlungsausgang' && b.amount === 11662n && b.doc === 'ZL-1'),
    ).toBe(true);
    await undoPaid(sql, id, 't');
    expect(
      (await sql`select status, paid_amount_cents from app.incoming_invoices where id = ${id}`)[0],
    ).toEqual({
      status: 'freigegeben',
      paid_amount_cents: null,
    });
  });
});
