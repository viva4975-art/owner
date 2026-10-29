import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, holidayName, isoWeekday } from '../domain/time/holidays.js';
import { listAbsenceHours, requestAbsence, saveAbsenceHours } from './absences.js';
import { payrollMonth } from './payroll.js';
import { saveException } from './planning.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { saveShiftPlan } from './time.js';
import { monthRange } from './timesheet.js';

const available = await dbAvailable();

// Ahmed 29.10.: „Audi zwei Tage krank, aber nur 8,5 Std.“ – Krank-/Urlaubsstunden müssen immer zum Einsatzplan passen.
describe.skipIf(!available)('Urlaub/Krank-Stunden folgen dem Einsatzplan (Datenbank)', () => {
  let sql: Sql;
  const emp = randomUUID();
  const sub = randomUUID();
  let mon = '';
  let month = '';
  beforeAll(async () => {
    sql = await freshDatabase();
    for (const [id, no] of [
      [emp, '3101'],
      [sub, '3102'],
    ] as const) {
      await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, hourly_wage_cents, weekly_hours, employment_type)
                values (${id}, ${no}, 'Test', ${no}, '2024-01-01', 1500, 40, 'vollzeit')`;
      await sql`insert into app.employee_sites (employee_id, site_id) values (${id}, ${DEMO.siteSchool})`;
    }
    month = addDays(monthRange(todayBerlin().slice(0, 7)).to, 1).slice(0, 7);
    mon = monthRange(month).from;
    // Montag mit zwei Werktagen ohne Feiertag
    while (isoWeekday(mon) !== 1 || holidayName(mon) || holidayName(addDays(mon, 1))) mon = addDays(mon, 1);
  });
  afterAll(async () => {
    await sql?.end();
  });

  const plan = (p: { weekdays: number[]; start: string; end: string; brk: number }) =>
    saveShiftPlan(
      sql,
      randomUUID(),
      {
        employeeId: emp,
        siteId: DEMO.siteSchool,
        weekdays: p.weekdays,
        startTime: p.start,
        endTime: p.end,
        breakMinutes: p.brk,
        validFrom: monthRange(month).from,
        validUntil: null,
        note: null,
      },
      'buero',
    );

  it('Einsatz erst nach der Krankmeldung geplant → Stunden kommen dazu; Vertretung am 2. Tag ändert nichts', async () => {
    // zuerst nur Montag geplant (06:00–15:00, 30 Min. Pause = 8,5 Std.)
    await plan({ weekdays: [1], start: '06:00', end: '15:00', brk: 30 });
    const sick = randomUUID();
    await requestAbsence(sql, {
      id: sick,
      employeeId: emp,
      kind: 'krank',
      start: mon,
      end: addDays(mon, 1),
      halfDay: false,
      note: null,
      actor: 'buero',
      approved: true,
    });
    let h = await listAbsenceHours(sql, { absenceId: sick });
    expect(h.reduce((a, x) => a + x.minutes, 0)).toBe(510);
    // Dienstag später eingeplant → beim nächsten Anzeigen 2 × 8,5 Std.
    await plan({ weekdays: [2], start: '06:00', end: '15:00', brk: 30 });
    h = await listAbsenceHours(sql, { absenceId: sick });
    expect(h.reduce((a, x) => a + x.minutes, 0)).toBe(1020);
    // Vertretung für Dienstag → die kranke Person behält ihre Stunden (Lohnausfallprinzip § 4 EFZG)
    const [tue] = await sql<{ id: string }[]>`
      select id from app.shift_plans where employee_id = ${emp} and weekday = 2`;
    await saveException(
      sql,
      randomUUID(),
      {
        planId: tue!.id,
        date: addDays(mon, 1),
        kind: 'vertretung',
        substituteId: sub,
        start: null,
        end: null,
        note: null,
        expectedVersion: null,
      },
      'buero',
    );
    h = await listAbsenceHours(sql, { absenceId: sick });
    expect(h.reduce((a, x) => a + x.minutes, 0)).toBe(1020);
    const rows = await payrollMonth(sql, month, emp, { fillPlan: true });
    expect(rows[0]!.minutes.krank).toBe(1020);
  });

  it('von Hand geänderte Stunden bleiben', async () => {
    const [a] = await sql<{ id: string }[]>`select id from app.absences where employee_id = ${emp}`;
    const h = await listAbsenceHours(sql, { absenceId: a!.id });
    await saveAbsenceHours(sql, a!.id, [{ id: h[0]!.id, minutes: 300, paid: true }], 'buero');
    const after = await listAbsenceHours(sql, { absenceId: a!.id });
    expect(after.find((x) => x.id === h[0]!.id)!.minutes).toBe(300);
    expect(after.reduce((s, x) => s + x.minutes, 0)).toBe(300 + 510);
  });
});
