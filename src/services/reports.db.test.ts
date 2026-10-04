import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { requestAbsence } from './absences.js';
import { employeeInput, saveEmployee } from './employees.js';
import { createCancellation, getInvoice, issue, runMonthly } from './invoices.js';
import { saveService, serviceInput } from './masterdata.js';
import { bookPayment, paymentInput } from './payments.js';
import { hourlyRates, invoiceStatistics, revenueForecast, sickDays, toCsv } from './reports.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Auswertungen', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Rechnungs-Statistik: Storno mindert den Monat, Zahlungsdauer, Kunden nach Umsatz', async () => {
    const run = await runMonthly(sql, '2026-09', 't', { siteIds: [DEMO.siteSchool, DEMO.siteHq] });
    expect(run.created.length).toBe(2);
    const [a, b] = run.created.map((x) => x.invoiceId) as [string, string];
    await issue(sql, a, 't', '2026-09-15');
    await issue(sql, b, 't', '2026-09-15');
    const st = await createCancellation(sql, b, 't');
    await issue(sql, st, 't', '2026-10-02');
    const inv = (await getInvoice(sql, a))!.invoice;
    await bookPayment(
      sql,
      randomUUID(),
      a,
      paymentInput.parse({
        amount: (Number(inv.payable_cents) / 100).toFixed(2).replace('.', ','),
        paid_on: '2026-09-29',
        method: 'ueberweisung',
        reference: '',
        note: '',
      }),
      't',
    );
    const s = await invoiceStatistics(sql, 2026);
    const sep = s.months.find((m) => m.month === '2026-09')!;
    const oct = s.months.find((m) => m.month === '2026-10')!;
    const netA = inv.net_cents;
    const netB = (await getInvoice(sql, b))!.invoice.net_cents;
    expect(sep.invoices).toBe(2);
    expect(sep.net).toBe(netA + netB);
    expect(oct.reversals).toBe(1);
    expect(oct.net).toBe(-netB);
    expect(s.total).toBe(netA);
    expect(s.payment.paid).toBe(1);
    expect(s.payment.avg_days).toBe(14);
    expect(s.payment.late).toBe(0);
    expect(s.customers[0]!.net).toBe(netA);
  });

  it('Umsatz-Vorschau: Zyklus quartalsweise und Ende der Gültigkeit', async () => {
    const before = await revenueForecast(sql, '2026-10', 6);
    await saveService(
      sql,
      randomUUID(),
      DEMO.siteHq,
      serviceInput.parse({
        kind: 'monthly_flat',
        description: 'Glas quartalsweise',
        unit_code: 'LS',
        quantity: '1',
        unit_price: '600,00',
        vat_rate_bp: '1900',
        valid_from: '2026-07-01',
        valid_to: '2027-01-31',
        note: '',
        billing_cycle: 'quartalsweise',
        version: '',
      }),
      't',
    );
    const after = await revenueForecast(sql, '2026-10', 6);
    const diff = after.totals.map((v, i) => v - before.totals[i]!);
    // fällig Okt 26 und Jan 27; Apr 27 liegt nach dem Ende → nicht mehr
    expect(diff).toEqual([60000n, 0n, 0n, 60000n, 0n, 0n]);
    expect(after.total - before.total).toBe(120000n);
    expect(after.months).toEqual(['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03']);
  });

  it('Krankheitstage über Monatsgrenzen, halbe Tage, Kind krank', async () => {
    const id = randomUUID();
    await saveEmployee(
      sql,
      id,
      employeeInput.parse({
        personnel_no: '3001',
        first_name: 'Kim',
        last_name: 'Krank',
        employment_type: 'vollzeit',
        entry_date: '2024-01-01',
        exit_date: '',
        weekly_hours: '40',
        hourly_wage: '15,00',
        phone: '',
        email: '',
        languages: '',
        version: '',
        private_version: '',
      }),
      't',
    );
    const abs = (kind: 'krank' | 'kind_krank', start: string, end: string, halfDay = false) =>
      requestAbsence(sql, {
        id: randomUUID(),
        employeeId: id,
        kind,
        start,
        end,
        halfDay,
        note: null,
        actor: 't',
        approved: true,
      });
    await abs('krank', '2025-01-30', '2025-02-04'); // Do, Fr | Mo, Di
    await abs('kind_krank', '2025-03-12', '2025-03-12', true);
    const [r] = (await sickDays(sql, 2025)).filter((x) => x.id === id);
    expect(r!.months.slice(0, 3)).toEqual([2, 2, 0.5]);
    expect(r!.total).toBe(4.5);
    expect(r!.child).toBe(0.5);
    expect(r!.cases).toBe(2);
  });

  it('Stundensätze: Erlös je Objekt aus Rechnungspositionen', async () => {
    const rows = await hourlyRates(sql, '2026-09', '2026-09');
    const school = rows.find((r) => r.site_id === DEMO.siteSchool)!;
    expect(school.revenue).toBeGreaterThan(0n);
    expect(school.per_hour).toBeNull(); // keine Ist-Stunden
  });

  it('CSV: Formeln entschärft, Zahlen bleiben', () => {
    const csv = toCsv(
      ['a', 'b'],
      [
        ['=HYPERLINK("x")', '-1,50'],
        ['x;y', 3],
      ],
    );
    expect(csv).toContain(`"'=HYPERLINK(""x"")";-1,50`);
    expect(csv).toContain('"x;y";3');
  });
});
