import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, holidayName, isoWeekday } from '../domain/time/holidays.js';
import { leaveDaysOf, listAbsenceHours, listAbsences, requestAbsence } from './absences.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { saveShiftPlan } from './time.js';

const available = await dbAvailable();

// Ahmed 09.11.: Urlaub am Samstag ging nicht („keine Arbeitstage“), obwohl samstags ein Einsatz geplant ist.
describe.skipIf(!available)('Urlaub an einem Samstag mit Einsatz (Datenbank)', () => {
  let sql: Sql;
  const emp = randomUUID();
  let sat = '';
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, hourly_wage_cents, weekly_hours, employment_type)
              values (${emp}, '3201', 'Test', 'Samstag', '2024-01-01', 1500, 4, 'minijob')`;
    await sql`insert into app.employee_sites (employee_id, site_id) values (${emp}, ${DEMO.siteSchool})`;
    const from = addDays(todayBerlin(), 7);
    await saveShiftPlan(
      sql,
      randomUUID(),
      {
        employeeId: emp,
        siteId: DEMO.siteSchool,
        weekdays: [6],
        startTime: '08:00',
        endTime: '12:00',
        breakMinutes: 0,
        validFrom: from,
        validUntil: null,
        note: null,
      },
      'buero',
    );
    sat = from;
    while (isoWeekday(sat) !== 6 || holidayName(sat)) sat = addDays(sat, 1);
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('zählt den Samstag als Urlaubstag und rechnet die Stunden aus dem Einsatz', async () => {
    expect(await leaveDaysOf(sql, emp, sat, sat, false)).toBe(1);
    const id = randomUUID();
    await requestAbsence(sql, {
      id,
      employeeId: emp,
      kind: 'urlaub',
      start: sat,
      end: sat,
      halfDay: false,
      note: null,
      actor: 'buero',
      approved: true,
      allowNoLeave: true,
    });
    const h = await listAbsenceHours(sql, { absenceId: id });
    expect(h.reduce((a, x) => a + x.minutes, 0)).toBe(240);
    // Liste zeigt 1 Arbeitstag statt 0
    const [row] = await listAbsences(sql, { employeeId: emp });
    expect(row?.days).toBe(1);
  });

  it('ohne Einsatz bleibt der Sonntag gesperrt', async () => {
    const sun = addDays(sat, 1);
    await expect(
      requestAbsence(sql, {
        id: randomUUID(),
        employeeId: emp,
        kind: 'urlaub',
        start: sun,
        end: sun,
        halfDay: false,
        note: null,
        actor: 'buero',
        approved: true,
        allowNoLeave: true,
      }),
    ).rejects.toThrow(/keine Arbeitstage/);
  });
});
