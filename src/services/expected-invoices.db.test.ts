import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import type { Cents } from '../domain/money/money.js';
import { billingTracking, expectedInvoices, periodsOf, skipExpected } from './expected-invoices.js';
import { saveIncoming } from './purchasing.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe('Rechnung erwartet: Zeiträume', () => {
  it('monatlich, quartalsweise, einmalig; nur abgelaufene Zeiträume', () => {
    expect(periodsOf('monatlich', '2026-07-15', null, '2026-10-07').map((p) => p.start)).toEqual([
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
    expect(
      periodsOf('quartalsweise', '2026-01-01', null, '2026-10-07').map((p) => `${p.start}/${p.end}`),
    ).toEqual(['2026-01/2026-03-31', '2026-04/2026-06-30', '2026-07/2026-09-30']);
    expect(periodsOf('monatlich', '2026-07-01', '2026-08-15', '2026-10-07').map((p) => p.end)).toEqual([
      '2026-07-31',
      '2026-08-15',
    ]);
    expect(periodsOf('einmalig', '2026-09-10', null, '2026-10-07')).toEqual([
      { start: '2026-09', end: '2026-09-30', months: 1 },
    ]);
    expect(periodsOf('einmalig', '2026-10-01', null, '2026-10-07')).toEqual([]);
  });
});

describe.skipIf(!available)('Rechnung erwartet (Datenbank)', () => {
  let sql: Sql;
  const sup = randomUUID();
  const scA = randomUUID();
  const scB = randomUUID();
  const today = '2026-10-07';
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.suppliers (id, supplier_no, name, kind) values (${sup}, '79001', 'Glas-NU GmbH', 'nachunternehmer')`;
    await sql`insert into app.subcontracts (id, number, supplier_id, site_id, service_kind, frequency, billing, price_cents, valid_from, status, created_by)
              values (${scA}, 'BE-2026-0901', ${sup}, ${DEMO.siteSchool}, 'Unterhaltsreinigung', 'monatlich', 'pauschale_monat', 100000, '2026-08-01', 'erteilt', 't'),
                     (${scB}, 'BE-2026-0902', ${sup}, ${DEMO.siteOffice}, 'Glasreinigung', 'quartalsweise', 'pauschale_einsatz', 50000, '2026-07-01', 'erteilt', 't')`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('erwartet je Zeitraum, eine Rechnung für mehrere Aufträge, „keine Rechnung“', async () => {
    let exp = await expectedInvoices(sql, { today });
    expect(exp.map((e) => `${e.number}/${e.period}`)).toEqual([
      'BE-2026-0901/2026-08',
      'BE-2026-0901/2026-09',
      'BE-2026-0902/2026-07',
    ]);
    expect(exp[0]!.expectedNet).toBe(100000n);
    expect(exp[2]!.expectedNet).toBeNull(); // je Einsatz = nach Aufwand

    // eine Rechnung: Unterhaltsreinigung August + Glasreinigung Q3 (zwei Objekte)
    const inv = randomUUID();
    await saveIncoming(
      sql,
      inv,
      {
        supplierId: sup,
        invoiceNo: 'R-77',
        invoiceDate: '2026-10-02',
        dueDate: null,
        serviceMonth: null,
        net: 150000n as Cents,
        vat: 0n as Cents,
        reverseCharge: true,
        category: 'nachunternehmer',
        siteId: null,
        purchaseOrderId: null,
        subcontractId: null,
        links: [
          { subcontractId: scA, month: '2026-08', net: 100000n },
          { subcontractId: scB, month: '2026-07', net: 50000n },
        ],
        skontoUntil: null,
        skontoPercentBp: null,
        note: null,
        expectedVersion: null,
      },
      't',
    );
    exp = await expectedInvoices(sql, { today });
    expect(exp.map((e) => `${e.number}/${e.period}`)).toEqual(['BE-2026-0901/2026-09']);
    // Kosten automatisch je Objekt verteilt
    const alloc = await sql<{ site_id: string; net_cents: bigint }[]>`
      select site_id, net_cents from app.cost_allocations where incoming_invoice_id = ${inv} order by net_cents`;
    expect(alloc.map((a) => [a.site_id, a.net_cents])).toEqual([
      [DEMO.siteOffice, 50000n],
      [DEMO.siteSchool, 100000n],
    ]);

    await skipExpected(sql, scA, '2026-09', 'Objekt geschlossen', 't');
    expect(await expectedInvoices(sql, { today })).toEqual([]);

    // Rechnungsverfolgung je Bestellung: laufender Zeitraum (Oktober) wird mit angezeigt
    const tr = await billingTracking(sql, [scA, scB], { today });
    expect(tr.get(scA)!.map((p) => `${p.start}:${p.state}`)).toEqual([
      '2026-10:laufend',
      '2026-09:keine',
      '2026-08:abgerechnet',
    ]);
    expect(tr.get(scA)![2]!.invoices.map((i) => i.invoice_no)).toEqual(['R-77']);
    expect(tr.get(scB)!.map((p) => `${p.start}:${p.state}`)).toEqual([
      '2026-10:laufend',
      '2026-07:abgerechnet',
    ]);

    // Summe der Zeilen muss zum Netto passen
    await expect(
      saveIncoming(
        sql,
        randomUUID(),
        {
          supplierId: sup,
          invoiceNo: 'R-78',
          invoiceDate: '2026-10-02',
          dueDate: null,
          serviceMonth: null,
          net: 100n as Cents,
          vat: 0n as Cents,
          reverseCharge: true,
          category: 'nachunternehmer',
          siteId: null,
          purchaseOrderId: null,
          subcontractId: null,
          links: [
            { subcontractId: scA, month: '2026-10', net: 60n },
            { subcontractId: scB, month: '2026-10', net: 60n },
          ],
          skontoUntil: null,
          skontoPercentBp: null,
          note: null,
          expectedVersion: null,
        },
        't',
      ),
    ).rejects.toThrow(/angleichen/);
  });
});
