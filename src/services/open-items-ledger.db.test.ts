import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { parseEuro, parseQuantity } from '../domain/money/money.js';
import { issue, saveDraft } from './invoices.js';
import { bookPayment, openItemLedger } from './payments.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Offene Posten (Soll/Haben je Kunde)', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Soll = Rechnung, Haben = Zahlungen, Saldo, je Kunde summiert', async () => {
    const mk = async (price: string) => {
      const id = await saveDraft(
        sql,
        randomUUID(),
        {
          customerId: DEMO.authority,
          siteId: DEMO.siteSchool,
          kind: 'invoice',
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          orderReference: null,
          introText: null,
          closingText: null,
          lines: [
            {
              description: 'Reinigung',
              quantity: parseQuantity('1'),
              unitCode: 'MON',
              unitPrice: parseEuro(price),
              vatRate: 1900,
            },
          ],
        },
        't',
      );
      await issue(sql, id, 't', '2026-09-15');
      return id;
    };
    const a = await mk('100,00'); // 119,00 brutto
    const b = await mk('200,00'); // 238,00 brutto
    await bookPayment(
      sql,
      randomUUID(),
      a,
      { amount: parseEuro('50,00'), paid_on: '2026-09-20', method: 'ueberweisung', reference: 'Teil' },
      't',
    );
    const [g] = await openItemLedger(sql, { customerId: DEMO.authority });
    expect(g!.open_cents).toBe(6900n + 23800n);
    const ia = g!.items.find((i) => i.invoice_id === a)!;
    expect(ia).toMatchObject({ payable_cents: 11900n, open_cents: 6900n });
    expect(ia.haben).toEqual([
      { date: '2026-09-20', label: 'Zahlung (Teil)', cents: 5000n, href: null, skonto: false },
    ]);
    expect(g!.items.find((i) => i.invoice_id === b)!.haben).toEqual([]);
    expect((await openItemLedger(sql, { q: 'gibt es nicht' })).length).toBe(0);
  });
});
