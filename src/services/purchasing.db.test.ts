import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { type Cents, parseEuro, parseQuantity } from '../domain/money/money.js';
import { addDays } from '../domain/time/holidays.js';
import { siteCosting } from './costing.js';
import {
  buildExtf,
  collectBookings,
  encodeCp1252,
  getAccountingSettings,
  saveAccountingSettings,
} from './datev.js';
import { saveArticle } from './inventory.js';
import { issue, saveDraft } from './invoices.js';
import {
  buildPain001,
  createPaymentRun,
  decideIncoming,
  getOrder,
  paymentProposal,
  paymentRunXml,
  receiveOrder,
  renderOrderPdf,
  saveIncoming,
  saveOrder,
  sepaText,
  setOrderStatus,
  skontoFor,
  validIbanFormat,
} from './purchasing.js';
import { getSeller } from './masterdata.js';
import { DEMO } from './seed.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import { officeSave } from './time.js';
import type { Deps } from './workflow.js';

describe('SEPA-Hilfen', () => {
  it('IBAN-Prüfziffer und SEPA-Zeichensatz', () => {
    expect(validIbanFormat('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(validIbanFormat('DE89 3704 0044 0532 0130 01')).toBe(false);
    expect(sepaText('Müller & Söhne – Glasreinigung „Süd“', 70)).toBe(
      'Mueller + Soehne - Glasreinigung Sued',
    );
  });
  it('Skonto nur bis zum Skontodatum, Cent-genau', () => {
    const i = { gross_cents: 119_00n, skonto_until: '2026-10-10', skonto_percent_bp: 200 };
    expect(skontoFor(i, '2026-10-10')).toBe(238n);
    expect(skontoFor(i, '2026-10-11')).toBe(0n);
  });
  it('pain.001.001.09 mit Kontrollsumme', () => {
    const xml = buildPain001({
      messageId: 'M1',
      createdAt: new Date('2026-10-03T08:00:00Z'),
      executionDate: '2026-10-05',
      debtorName: 'Viva-Deluxe Gebäudereinigung GmbH',
      debtorIban: 'DE39701900000003297837',
      debtorBic: 'GENODEF1M01',
      items: [
        {
          endToEnd: 'E1',
          amount: 12345n,
          name: 'A',
          iban: 'DE89370400440532013000',
          bic: null,
          remittance: 'R1',
        },
        {
          endToEnd: 'E2',
          amount: 55n,
          name: 'B <x>',
          iban: 'DE89370400440532013000',
          bic: 'COBADEFFXXX',
          remittance: 'R2',
        },
      ],
    });
    expect(xml).toContain('urn:iso:std:iso:20022:tech:xsd:pain.001.001.09');
    expect(xml).toContain('<CtrlSum>124.00</CtrlSum>');
    expect(xml).toContain('<NbOfTxs>2</NbOfTxs>');
    expect(xml).toContain('<Nm>Viva-Deluxe Gebaeudereinigung GmbH</Nm>');
    expect(xml).not.toContain('<x>');
  });
  it('DATEV-Datei in Windows-1252', () => {
    expect([...encodeCp1252('ä€–')]).toEqual([0xe4, 0x80, 0x96]);
  });
});

const available = await dbAvailable();

describe.skipIf(!available)('Einkauf, Zahlungslauf, DATEV, Nachkalkulation (Datenbank)', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  const sup = randomUUID();
  const sub = randomUUID();
  const art = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
    await sql`insert into app.suppliers (id, supplier_no, name, kind, iban, bic, payment_terms_days)
              values (${sup}, '70001', 'Reinigungsbedarf Süd GmbH', 'lieferant', 'DE89370400440532013000', 'COBADEFFXXX', 14),
                     (${sub}, '70002', 'Glas & Fassade UG', 'nachunternehmer', 'DE02120300000000202051', null, 30)`;
    await saveArticle(
      sql,
      art,
      { article_no: '1001', name: 'Allzweckreiniger', unit: 'Kanister', min_stock: '2', active: 'on' },
      null,
      'test',
    );
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Bestellung: Nummer BE-JJJJ-NNNN, Wareneingang bucht Lager genau einmal', async () => {
    const id = randomUUID();
    await saveOrder(
      sql,
      id,
      {
        supplierId: sup,
        siteId: null,
        orderDate: '2026-10-02',
        deliveryDate: null,
        note: null,
        lines: [
          {
            articleId: art,
            description: 'Allzweckreiniger 10 l',
            quantity: parseQuantity('12'),
            unit: 'Kanister',
            unitPrice: parseEuro('28,90'),
          },
          {
            articleId: null,
            description: 'Versand',
            quantity: parseQuantity('1'),
            unit: 'pauschal',
            unitPrice: parseEuro('9,90'),
          },
        ],
        expectedVersion: null,
      },
      'test',
    );
    const o = (await getOrder(sql, id))!.order;
    expect(o.number).toMatch(/^BE-2026-\d{4}$/);
    expect(o.net_cents).toBe(35670n);
    await expect(receiveOrder(sql, id, 'test')).rejects.toThrow(/nur für bestellte/);
    await setOrderStatus(sql, id, 'bestellt', 'test');
    await receiveOrder(sql, id, 'test');
    await receiveOrder(sql, id, 'test');
    const [a] = await sql<
      { stock_milli: bigint; purchase_price_cents: bigint }[]
    >`select stock_milli, purchase_price_cents from app.articles where id = ${art}`;
    expect(a!.stock_milli).toBe(12000n);
    expect(a!.purchase_price_cents).toBe(2890n);
    const { pdf } = await renderOrderPdf(sql, id);
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-');
  });

  const inc = (over: Partial<Parameters<typeof saveIncoming>[2]> = {}) => ({
    supplierId: sup,
    invoiceNo: 'R-4711',
    invoiceDate: todayBerlin(),
    dueDate: null,
    serviceMonth: null,
    net: parseEuro('100,00'),
    vat: parseEuro('19,00'),
    reverseCharge: false,
    category: 'material' as const,
    siteId: DEMO.siteSchool,
    purchaseOrderId: null,
    skontoUntil: addDays(todayBerlin(), 10),
    skontoPercentBp: 200,
    note: null,
    expectedVersion: null,
    ...over,
  });

  it('Rechnungseingang: Dublette abgelehnt, § 13b ohne USt, Plausibilität', async () => {
    const a = randomUUID();
    await saveIncoming(sql, a, inc(), 'test');
    await expect(saveIncoming(sql, randomUUID(), inc(), 'test')).rejects.toThrow(/schon erfasst/);
    await expect(
      saveIncoming(sql, randomUUID(), inc({ invoiceNo: 'X', vat: parseEuro('5,00') }), 'test'),
    ).rejects.toThrow(/weder zu 7/);
    await expect(
      saveIncoming(
        sql,
        randomUUID(),
        inc({ supplierId: sub, invoiceNo: 'GF-1', reverseCharge: true, vat: parseEuro('19,00') }),
        'test',
      ),
    ).rejects.toThrow(/§ 13b/);
    await saveIncoming(
      sql,
      randomUUID(),
      inc({
        supplierId: sub,
        invoiceNo: 'GF-1',
        reverseCharge: true,
        vat: 0n as Cents,
        net: parseEuro('800,00'),
        category: 'nachunternehmer',
        skontoUntil: null,
        skontoPercentBp: null,
      }),
      'test',
    );
    const [d] = await sql<{ due_date: string }[]>`select due_date from app.incoming_invoices where id = ${a}`;
    expect(d!.due_date).toBe(addDays(todayBerlin(), 14)); // Zahlungsziel des Lieferanten
  });

  it('Zahlungslauf: nur freigegebene, Skonto, SEPA-Datei, jede Rechnung nur einmal', async () => {
    const all = await sql<{ id: string }[]>`select id from app.incoming_invoices order by invoice_no`;
    expect(await paymentProposal(sql, todayBerlin())).toHaveLength(0); // nichts freigegeben
    for (const r of all) await decideIncoming(sql, r.id, 'freigegeben', 'chef');
    const prop = await paymentProposal(sql, addDays(todayBerlin(), 1));
    const material = prop.find((p) => p.invoice.invoice_no === 'R-4711')!;
    expect(material.skonto).toBe(238n);
    expect(material.amount).toBe(11662n);
    const run = randomUUID();
    const iban = (await getSeller(sql)).bankAccounts[0]!.iban;
    await createPaymentRun(deps, {
      id: run,
      invoiceIds: all.map((r) => r.id),
      executionDate: addDays(todayBerlin(), 1),
      debtorIban: iban,
      actor: 'chef',
    });
    await createPaymentRun(deps, {
      id: run,
      invoiceIds: all.map((r) => r.id),
      executionDate: addDays(todayBerlin(), 1),
      debtorIban: iban,
      actor: 'chef',
    });
    const xml = await paymentRunXml(sql, run);
    expect(xml).toContain('<NbOfTxs>2</NbOfTxs>');
    expect(xml).toContain('<CtrlSum>916.62</CtrlSum>'); // 116,62 + 800,00
    const [st] = await sql<
      { n: number }[]
    >`select count(*)::int as n from app.incoming_invoices where status = 'bezahlt'`;
    expect(st!.n).toBe(2);
    await expect(
      createPaymentRun(deps, {
        id: randomUUID(),
        invoiceIds: [all[0]!.id],
        executionDate: addDays(todayBerlin(), 2),
        debtorIban: iban,
        actor: 'chef',
      }),
    ).rejects.toThrow(/nicht \(mehr\) freigegeben/);
    await expect(
      sql`update app.incoming_invoices set net_cents = 1 where id = ${all[0]!.id}`,
    ).rejects.toThrow(/abgeschlossen/);
  });

  it('DATEV: Ausgangsrechnung, Eingangsrechnung, § 13b-Hinweis, Kopfzeile', async () => {
    const id = randomUUID();
    await saveDraft(
      sql,
      id,
      {
        customerId: DEMO.company,
        siteId: DEMO.siteHq,
        kind: 'invoice',
        periodStart: null,
        periodEnd: null,
        orderReference: null,
        introText: null,
        closingText: null,
        lines: [
          {
            description: 'Unterhaltsreinigung',
            quantity: parseQuantity('1'),
            unitCode: 'LS',
            unitPrice: parseEuro('1.000,00'),
            vatRate: 1900,
          },
          {
            description: 'Sonderleistung 7 %',
            quantity: parseQuantity('1'),
            unitCode: 'C62',
            unitPrice: parseEuro('100,00'),
            vatRate: 700,
          },
        ],
      },
      'test',
    );
    const number = await issue(sql, id, 'test', todayBerlin());
    const from = `${todayBerlin().slice(0, 7)}-01`;
    const { bookings, warnings } = await collectBookings(sql, {
      from,
      to: todayBerlin(),
      outgoing: true,
      incoming: true,
      payments: true,
    });
    const out = bookings.filter((b) => b.doc === number);
    expect(out.map((b) => [b.amount, b.contra])).toEqual(
      expect.arrayContaining([
        [119000n, '8400'],
        [10700n, '8300'],
      ]),
    );
    expect(out[0]!.account).toBe('29902');
    expect(bookings.find((b) => b.doc === 'GF-1' && b.kind === 'eingang')!.taxKey).toBe('94');
    expect(bookings.find((b) => b.doc === 'R-4711' && b.kind === 'eingang')!.taxKey).toBe('9');
    expect(warnings.some((w) => w.includes('§ 13b'))).toBe(true);
    const s = await getAccountingSettings(sql);
    expect(() => buildExtf(s, { from, to: todayBerlin() }, bookings)).toThrow(/Berater- und Mandantennummer/);
    await saveAccountingSettings(sql, { ...s, datev_consultant_no: '12345', datev_client_no: '678' }, 'test');
    const csv = buildExtf(await getAccountingSettings(sql), { from, to: todayBerlin() }, bookings);
    expect(csv.split('\r\n')[0]).toMatch(/^"EXTF";700;21;"Buchungsstapel";13;\d{17};;"RE";"";"";12345;678;/);
    expect(csv).toContain('1190,00;"S";"EUR";;;"";29902;8400;"";');
  });

  it('Nachkalkulation: Erlös − Lohn (mit Zuschlag) − Material − Nachunternehmer', async () => {
    const month = todayBerlin().slice(0, 7);
    const emp = randomUUID();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, hourly_wage_cents)
              values (${emp}, '3001', 'Kalk', 'Test', '2026-01-01', 1500)`;
    await sql`insert into app.employee_sites (employee_id, site_id) values (${emp}, ${DEMO.siteSchool})`;
    // 10 Stunden à 15,00 € → 150,00 € × 1,45 = 217,50 €
    await officeSave(sql, {
      id: randomUUID(),
      employeeId: emp,
      siteId: DEMO.siteSchool,
      date: `${month}-01`,
      start: '06:00',
      end: '16:30',
      breakMinutes: 30,
      reason: 'Test',
      expectedVersion: null,
      actor: 'test',
    });
    const inv = randomUUID();
    await saveDraft(
      sql,
      inv,
      {
        customerId: DEMO.authority,
        siteId: DEMO.siteSchool,
        kind: 'invoice',
        periodStart: `${month}-01`,
        periodEnd: `${month}-28`,
        orderReference: null,
        introText: null,
        closingText: null,
        lines: [
          {
            description: 'Unterhaltsreinigung',
            quantity: parseQuantity('1'),
            unitCode: 'LS',
            unitPrice: parseEuro('1.500,00'),
            vatRate: 1900,
          },
        ],
      },
      'test',
    );
    await issue(sql, inv, 'test', todayBerlin());
    const { rows } = await siteCosting(sql, month, DEMO.siteSchool);
    const r = rows[0]!;
    expect(r.revenue).toBe(150000n);
    expect(r.actual_minutes).toBe(600);
    expect(r.labor).toBe(21750n);
    expect(r.material).toBe(10000n); // Eingangsrechnung Material 100,00 netto
    expect(r.subcontractor).toBe(80000n); // § 13b-Rechnung Nachunternehmer am selben Objekt
    expect(r.margin).toBe(150000n - 21750n - 10000n - 80000n);
  });
});
