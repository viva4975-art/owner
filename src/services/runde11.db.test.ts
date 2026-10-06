import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { requestAbsence } from './absences.js';
import { payrollCsv, getPayrollSettings, payrollMonth } from './payroll.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Runde 11: Lohnarten und Urlaubsanspruch (Datenbank)', () => {
  let sql: Sql;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, hourly_wage_cents, pay_model, annual_leave_days)
              values (${emp}, '4001', 'Nina', 'Lohn', '2024-01-01', 1500, 'individuell', 2)`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  const entry = async (day: string, from: string, to: string, brk = 0) =>
    sql`insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source, status, created_by)
        values (${randomUUID()}, ${emp}, ${DEMO.siteSchool}, ${day},
                (${day}::date + ${from}::time) at time zone 'Europe/Berlin',
                (${day}::date + ${to}::time + case when ${to}::time <= ${from}::time then interval '1 day' else interval '0' end) at time zone 'Europe/Berlin',
                ${brk}, 'buero', 'erfasst', 'test')`;

  it('Normalstunden, Nacht- und Sonntagszuschlag, Beträge, CSV', async () => {
    await entry('2026-10-07', '22:00', '02:00'); // Mi Nacht 4 Std.
    await entry('2026-10-11', '06:00', '10:00'); // So 4 Std.
    await entry('2026-10-03', '08:00', '10:00'); // Feiertag (Sa) 2 Std.
    const [r] = await payrollMonth(sql, '2026-10', emp);
    expect(r!.minutes.normal).toBe(600);
    expect(r!.minutes.nacht).toBe(240);
    expect(r!.minutes.sonntag).toBe(240);
    expect(r!.minutes.feiertag).toBe(120);
    expect(r!.surchargeCents.nacht).toBe(1500n); // 4 × 15 € × 25 %
    expect(r!.surchargeCents.sonntag).toBe(4800n); // 4 × 15 € × 80 %
    expect(r!.surchargeCents.feiertag).toBe(2400n); // 2 × 15 € × 80 %
    await sql`update app.employees set regular_sunday_work = true where id = ${emp}`;
    const [r2] = await payrollMonth(sql, '2026-10', emp);
    expect(r2!.surchargeCents.sonntag).toBe(4500n); // 75 %
    const csv = payrollCsv([r2!], await getPayrollSettings(sql), '2026-10');
    expect(csv).toContain('2026-10;4001;Lohn, Nina;;Zuschlag Sonntagsarbeit;4,00;75;15,00;45,00');
  });

  it('Urlaub ohne ausreichenden Anspruch wird abgelehnt', async () => {
    await expect(
      requestAbsence(sql, {
        id: randomUUID(),
        employeeId: emp,
        kind: 'urlaub',
        start: '2026-11-02',
        end: '2026-11-04',
        halfDay: false,
        note: null,
        actor: 'buero',
        approved: true,
      }),
    ).rejects.toThrow(/Kein ausreichender Urlaubsanspruch 2026: Rest 2 Tage, beantragt 3 Tage/);
    await requestAbsence(sql, {
      id: randomUUID(),
      employeeId: emp,
      kind: 'urlaub',
      start: '2026-11-02',
      end: '2026-11-03',
      halfDay: false,
      note: null,
      actor: 'buero',
      approved: true,
    });
    // Krank geht immer
    await requestAbsence(sql, {
      id: randomUUID(),
      employeeId: emp,
      kind: 'krank',
      start: '2026-11-09',
      end: '2026-11-13',
      halfDay: false,
      note: null,
      actor: 'buero',
      approved: true,
    });
  });
});
