import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import type { Cents } from '../domain/money/money.js';
import {
  OTHER_ORDER,
  billingTracking,
  expectedInvoices,
  periodsOf,
  skipExpected,
  unskipExpected,
} from './expected-invoices.js';
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
    let exp = await expectedInvoices(sql, { today, from: '2000-01' });
    expect(exp.map((e) => `${e.number}/${e.period}`)).toEqual([
      'BE-2026-0901/2026-08',
      'BE-2026-0901/2026-09',
    ]); // quartalsweise = nach Ausführung, keine Meldung (Ahmed 09.10.: laufend sind nur monatliche)
    expect(exp[0]!.expectedNet).toBe(100000n);

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
    exp = await expectedInvoices(sql, { today, from: '2000-01' });
    expect(exp.map((e) => `${e.number}/${e.period}`)).toEqual(['BE-2026-0901/2026-09']);
    // Kosten automatisch je Objekt verteilt
    const alloc = await sql<{ site_id: string; net_cents: bigint }[]>`
      select site_id, net_cents from app.cost_allocations where incoming_invoice_id = ${inv} order by net_cents`;
    expect(alloc.map((a) => [a.site_id, a.net_cents])).toEqual([
      [DEMO.siteOffice, 50000n],
      [DEMO.siteSchool, 100000n],
    ]);

    await skipExpected(sql, scA, '2026-09', 'Objekt geschlossen', 't');
    expect(await expectedInvoices(sql, { today, from: '2000-01' })).toEqual([]);

    // Rechnungsverfolgung je Bestellung: laufender Zeitraum (Oktober) wird mit angezeigt
    const tr = await billingTracking(sql, [scA, scB], { today, from: '2000-01' });
    expect(tr.get(scA)!.map((p) => `${p.start}:${p.state}`)).toEqual([
      '2026-10:laufend',
      '2026-09:keine',
      '2026-08:abgerechnet',
    ]);
    expect(tr.get(scA)![2]!.invoices.map((i) => i.invoice_no)).toEqual(['R-77']);
    expect(tr.get(scB)!.map((p) => `${p.start}:${p.state}`)).toEqual([
      '2026-10:bedarf',
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

  it('selbst prüfen: Rechnung am Auftrag oder gleicher NU + Objekt deckt den Monat ab (Ahmed 09.10.)', async () => {
    const scC = randomUUID();
    await sql`insert into app.subcontracts (id, number, supplier_id, site_id, service_kind, frequency, billing, price_cents, valid_from, status, created_by)
              values (${scC}, 'BE-2026-0903', ${sup}, ${DEMO.siteHq}, 'Unterhaltsreinigung', 'monatlich', 'pauschale_monat', 70000, '2026-08-01', 'erteilt', 't')`;
    const open = async () =>
      (await expectedInvoices(sql, { today, from: '2000-01' }))
        .filter((e) => e.subcontract_id === scC)
        .map((e) => e.period);
    expect(await open()).toEqual(['2026-08', '2026-09']);
    const base = {
      supplierId: sup,
      invoiceDate: '2026-09-05',
      dueDate: null,
      net: 70000n as Cents,
      vat: 0n as Cents,
      reverseCharge: true,
      category: 'nachunternehmer' as const,
      purchaseOrderId: null,
      skontoUntil: null,
      skontoPercentBp: null,
      note: null,
      expectedVersion: null,
    };
    // ohne Auftrag, aber gleicher NU + Objekt, Leistungsmonat August
    await saveIncoming(
      sql,
      randomUUID(),
      {
        ...base,
        invoiceNo: 'R-81',
        serviceMonth: '2026-08',
        siteId: DEMO.siteHq,
        subcontractId: null,
        links: [],
      },
      't',
    );
    expect(await open()).toEqual(['2026-09']);
    // „gehört nicht dazu“ (Ahmed 29.10.): vermutete Rechnung ausblenden – Zeitraum wieder offen, nicht „keine Rechnung“
    await skipExpected(sql, scC, '2026-08', OTHER_ORDER, 't');
    expect(await open()).toEqual(['2026-08', '2026-09']);
    const aug = (await billingTracking(sql, [scC], { today, from: '2000-01' }))
      .get(scC)!
      .find((p) => p.start === '2026-08')!;
    expect(aug.state).toBe('offen');
    expect(aug.invoices).toEqual([]);
    expect(aug.noted).toBe(OTHER_ORDER);
    await unskipExpected(sql, scC, '2026-08', 't');
    expect(await open()).toEqual(['2026-09']);
    // am Auftrag erfasst, ohne Leistungsmonat → Rechnungsdatum zählt
    await saveIncoming(
      sql,
      randomUUID(),
      {
        ...base,
        invoiceNo: 'R-82',
        invoiceDate: '2026-09-30',
        serviceMonth: null,
        siteId: DEMO.siteHq,
        subcontractId: scC,
        links: [],
      },
      't',
    );
    expect(await open()).toEqual([]);
  });

  it('mehrere Bestellungen ohne Beträge: Kosten automatisch nach Preis auf die Objekte (Ahmed 20.10.)', async () => {
    const [x] = await sql<{ id: string; a: string; b: string }[]>`
      select s.supplier_id as id, a.id::text as a, b.id::text as b
        from app.subcontracts s
        join app.subcontracts a on a.number = 'BE-2026-0901'
        join app.subcontracts b on b.number = 'BE-2026-0902'
       where s.number = 'BE-2026-0901'`;
    const inv = randomUUID();
    await saveIncoming(
      sql,
      inv,
      {
        supplierId: x!.id,
        invoiceNo: 'R-AUTO-1',
        invoiceDate: '2026-11-02',
        dueDate: null,
        serviceMonth: '2026-10',
        net: 90000n as Cents,
        vat: 0n as Cents,
        reverseCharge: true,
        category: 'nachunternehmer',
        siteId: null,
        purchaseOrderId: null,
        subcontractId: null,
        links: [
          { subcontractId: x!.a, month: '2026-10', net: null },
          { subcontractId: x!.b, month: '2026-10', net: null },
        ],
        skontoUntil: null,
        skontoPercentBp: null,
        note: null,
        expectedVersion: null,
      },
      't',
    );
    const alloc = await sql<{ site_id: string; net_cents: bigint }[]>`
      select site_id, net_cents from app.cost_allocations where incoming_invoice_id = ${inv} order by net_cents`;
    // Preise 1.000 € / 500 € → 2/3 zu 1/3
    expect(alloc.map((a) => [a.site_id, a.net_cents])).toEqual([
      [DEMO.siteOffice, 30000n],
      [DEMO.siteSchool, 60000n],
    ]);
  });
  it('Sammelbestellung: Zeile nur für ein Objekt (Regie/Zusatzarbeiten, Ahmed 30.10.)', async () => {
    const [x] = await sql<{ id: string; a: string }[]>`
      select supplier_id as id, id::text as a from app.subcontracts where number = 'BE-2026-0901'`;
    await sql`insert into app.subcontract_sites (subcontract_id, site_id, created_by)
              values (${x!.a}, ${DEMO.siteOffice}, 't'), (${x!.a}, ${DEMO.siteSchool}, 't') on conflict do nothing`;
    const base = {
      supplierId: x!.id,
      invoiceDate: '2026-11-03',
      dueDate: null,
      serviceMonth: '2026-10',
      vat: 0n as Cents,
      reverseCharge: true,
      category: 'nachunternehmer' as const,
      siteId: null,
      purchaseOrderId: null,
      subcontractId: null,
      skontoUntil: null,
      skontoPercentBp: null,
      note: null,
      expectedVersion: null,
    };
    // ohne Betrag bei mehreren Zeilen → Fehler
    await expect(
      saveIncoming(
        sql,
        randomUUID(),
        {
          ...base,
          invoiceNo: 'R-REGIE-0',
          net: 90000n as Cents,
          links: [
            { subcontractId: x!.a, month: '2026-10', net: null },
            { subcontractId: x!.a, month: '2026-10', net: null, siteId: DEMO.siteOffice },
          ],
        },
        't',
      ),
    ).rejects.toThrow(/Betrag netto/);
    const inv = randomUUID();
    await saveIncoming(
      sql,
      inv,
      {
        ...base,
        invoiceNo: 'R-REGIE-1',
        net: 90000n as Cents,
        links: [
          { subcontractId: x!.a, month: '2026-10', net: 80000n },
          { subcontractId: x!.a, month: '2026-10', net: 10000n, siteId: DEMO.siteOffice },
        ],
      },
      't',
    );
    const alloc = await sql<{ site_id: string; net_cents: bigint }[]>`
      select site_id, sum(net_cents)::bigint as net_cents from app.cost_allocations
       where incoming_invoice_id = ${inv} group by site_id`;
    const by = new Map(alloc.map((a) => [a.site_id, BigInt(a.net_cents)]));
    expect((by.get(DEMO.siteOffice) ?? 0n) + (by.get(DEMO.siteSchool) ?? 0n)).toBe(90000n);
    // Regie-Zeile ganz beim Büro, der Rest wie die Sammelbestellung verteilt
    expect((by.get(DEMO.siteOffice) ?? 0n) - (by.get(DEMO.siteSchool) ?? 0n)).toBe(10000n);
    // fremdes Objekt wird abgelehnt
    await expect(
      saveIncoming(
        sql,
        randomUUID(),
        {
          ...base,
          invoiceNo: 'R-REGIE-2',
          net: 1000n as Cents,
          links: [{ subcontractId: x!.a, month: '2026-10', net: null, siteId: randomUUID() }],
        },
        't',
      ),
    ).rejects.toThrow(/gehört nicht/);
  });
});
