import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { payrollLexwareAscii, payrollMonth, unpaidDeduction } from './payroll.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

it('Gehaltsabzug unbezahlt: Gehalt ÷ Soll × Ausfall, höchstens das Gehalt', () => {
  expect(unpaidDeduction(58500n, 360, 2520, null)).toBe(8357n);
  expect(unpaidDeduction(58500n, 3000, 2520, null)).toBe(58500n);
  expect(unpaidDeduction(58500n, 0, 2520, null)).toBe(0n);
  // ohne Einsatzplan: Stundensatz aus dem Gehalt
  expect(unpaidDeduction(58500n, 360, 0, 1351n)).toBe(8106n);
});

describe.skipIf(!available)('Lohnexport mit Abwesenheiten (Datenbank)', () => {
  let sql: Sql;
  const hourly = randomUUID();
  const mini = randomUUID();
  const plans: Record<string, string[]> = { [hourly]: [], [mini]: [] };
  const absence = async (
    emp: string,
    kind: string,
    from: string,
    to: string,
    days: [string, number][],
    paid: boolean,
    half = false,
  ) => {
    const id = randomUUID();
    await sql`insert into app.absences (id, employee_id, kind, start_date, end_date, half_day, status, requested_by)
              values (${id}, ${emp}, ${kind}, ${from}, ${to}, ${half}, 'genehmigt', 't')`;
    for (const [d, min] of days) {
      const wd = (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7;
      await sql`insert into app.absence_hours (id, absence_id, employee_id, work_date, shift_plan_id, site_id, minutes, paid)
                values (${randomUUID()}, ${id}, ${emp}, ${d}, ${plans[emp]![wd]!}, ${DEMO.siteSchool}, ${min}, ${paid})`;
    }
  };
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, hourly_wage_cents)
              values (${hourly}, '7701', 'Stunden', 'Lohn', '2024-01-01', 1500)`;
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type, pay_model,
                                         monthly_salary_cents, weekly_hours)
              values (${mini}, '7702', 'Mini', 'Gehalt', '2024-01-01', 'minijob', 'festgehalt', 58500, 10)`;
    for (const [emp, st, en] of [
      [hourly, '06:00', '14:00'],
      [mini, '10:00', '12:00'],
    ] as const)
      for (let wd = 1; wd <= 5; wd++) {
        const id = randomUUID();
        plans[emp]![wd - 1] = id;
        await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, valid_from, created_at)
                  values (${id}, ${emp}, ${DEMO.siteSchool}, ${wd}, ${st}, ${en}, '2026-01-01', '2026-01-01 12:00+01')`;
      }
    // Stundenlohn: Mo 02.11. Urlaub ganzer Tag, Di 03.11. halber Tag
    await absence(hourly, 'urlaub', '2026-11-02', '2026-11-02', [['2026-11-02', 480]], true);
    await absence(hourly, 'urlaub', '2026-11-03', '2026-11-03', [['2026-11-03', 240]], true, true);
    // Minijob mit 585 € Festgehalt: 3 Tage unbezahlt
    await absence(
      mini,
      'unbezahlt',
      '2026-11-04',
      '2026-11-06',
      [
        ['2026-11-04', 120],
        ['2026-11-05', 120],
        ['2026-11-06', 120],
      ],
      false,
    );
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Plan bis Monatsende: Urlaub wird von den Normalstunden abgezogen (auch halber Tag)', async () => {
    const [r] = await payrollMonth(sql, '2026-11', hourly, { cutoff: '2026-10-31' });
    // 21 Arbeitstage × 8 Std. = 168 Std.; davon 12 Std. Urlaub
    expect(r!.minutes.urlaub).toBe(720);
    expect(r!.minutes.normal).toBe(168 * 60 - 720);
    expect(r!.unpaidDeductionCents).toBe(0n);
  });

  it('Festgehalt mit unbezahlter Abwesenheit: Abzug als eigene Lohnart (Minusbetrag)', async () => {
    const [r] = await payrollMonth(sql, '2026-11', mini, { cutoff: '2026-10-31' });
    expect(r!.salary).toEqual({ type: 'aushilfsgehalt', cents: 58500n });
    expect(r!.unpaidMinutes).toBe(360);
    // 585 € ÷ (21 × 2 Std.) × 6 Std. = 83,57 €
    expect(r!.unpaidDeductionCents).toBe(8357n);
    const { text } = payrollLexwareAscii(
      [r!],
      { wage_type_numbers: { aushilfsgehalt: '400', unbezahlt: '990' }, overtime_bp: 2500 } as never,
      '2026-11',
    );
    expect(text).toBe('2026;11;7702;400;585,00\r\n2026;11;7702;990;-83,57\r\n');
  });
});
