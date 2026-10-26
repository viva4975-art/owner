import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { addLeaveExtra, deleteLeaveExtra, leaveBalance, leaveDaysOf, listLeaveExtra } from './absences.js';
import { recordHoursChange } from './employee-hours.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Arbeitstage pro Woche: Urlaub anteilig', () => {
  let sql: Sql;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type, weekly_hours, annual_leave_days)
              values (${emp}, '9871', 'Tage', 'Test', '2024-01-01', 'teilzeit', 20, 30)`;
    await recordHoursChange(sql, emp, 20, '2024-01-01', 't');
    // ab 01.11.2026 nur noch 3 Tage (Mo, Di, Mi)
    await recordHoursChange(sql, emp, 12, '2026-11-01', 't', null, 3);
    for (const wd of [1, 2, 3])
      await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, break_minutes, valid_from)
                values (${randomUUID()}, ${emp}, ${DEMO.siteSchool}, ${wd}, '06:00', '10:00', 0, '2026-11-01')`;
    // Reduzierung mit Stichtag in den Stammdaten (fest) – sonst gälte der Plan ab 11/2026 fürs ganze Jahr
    await sql`update app.employees set days_auto = false where id = ${emp}`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Anspruch je Monat nach Arbeitstagen, Urlaubswoche kostet nur die Arbeitstage', async () => {
    // 10 Monate × 5 Tage + 2 Monate × 3 Tage → 30 × (10 + 2 × 0,6) / 12 = 28
    expect((await leaveBalance(sql, emp, 2026)).entitlement).toBe(28);
    expect((await leaveBalance(sql, emp, 2025)).entitlement).toBe(30);
    expect((await leaveBalance(sql, emp, 2027)).entitlement).toBe(18);
    expect(await leaveDaysOf(sql, emp, '2026-11-09', '2026-11-15', false)).toBe(3);
    expect(await leaveDaysOf(sql, emp, '2026-10-05', '2026-10-11', false)).toBe(5);
  });

  it('Zusätzlicher Urlaub kommt zum Anspruch dazu, doppelt absenden zählt einmal, löschen nimmt ihn zurück', async () => {
    const id = randomUUID();
    const add = () =>
      addLeaveExtra(sql, {
        id,
        employeeId: emp,
        year: 2025,
        days: 5,
        reason: 'Schwerbehinderung',
        actor: 't',
      });
    await add();
    await add();
    const b = await leaveBalance(sql, emp, 2025);
    expect(b.entitlement).toBe(35);
    expect(b.extra).toBe(5);
    await addLeaveExtra(sql, {
      id: randomUUID(),
      employeeId: emp,
      year: 2025,
      days: -1.5,
      reason: 'Korrektur',
      actor: 't',
    });
    expect((await leaveBalance(sql, emp, 2025)).entitlement).toBe(33.5);
    await expect(
      addLeaveExtra(sql, {
        id: randomUUID(),
        employeeId: emp,
        year: 2025,
        days: 1.3,
        reason: 'x',
        actor: 't',
      }),
    ).rejects.toThrow(/halbe/);
    await expect(
      addLeaveExtra(sql, { id: randomUUID(), employeeId: emp, year: 2025, days: 1, reason: ' ', actor: 't' }),
    ).rejects.toThrow(/Grund/);
    for (const x of await listLeaveExtra(sql, emp)) await deleteLeaveExtra(sql, x.id, emp, 't');
    expect((await leaveBalance(sql, emp, 2025)).entitlement).toBe(30);
  });

  it('Eintritt/Austritt: rein anteilig', async () => {
    const mk = async (no: string, entry: string, exit: string | null, days: number) => {
      const id = randomUUID();
      await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, exit_date, employment_type, weekly_hours, annual_leave_days)
                values (${id}, ${no}, 'Ein', 'Tritt', ${entry}, ${exit}, 'vollzeit', 40, ${days})`;
      return (await leaveBalance(sql, id, 2026)).entitlement;
    };
    // alle 30 Tage laut Rahmentarifvertrag (annual_leave_days wird nicht mehr verwendet)
    expect(await mk('9881', '2026-10-01', null, 24)).toBe(7.5); // Wartezeit im Jahr nicht erfüllt → nur anteilig
    expect(await mk('9882', '2026-03-01', null, 24)).toBe(25); // 10/12 von 30
    expect(await mk('9883', '2026-06-15', null, 30)).toBe(15); // 6/12 – ohne Untergrenze (Ahmed 26.10.)
    expect(await mk('9884', '2020-01-01', '2026-05-31', 30)).toBe(12.5); // Austritt 1. Halbjahr → anteilig
    expect(await mk('9885', '2020-01-01', '2026-08-31', 30)).toBe(20); // 8/12 von 30
  });

  it('Arbeitstage automatisch aus der Einsatzplanung oder fest aus den Stammdaten', async () => {
    const auto = randomUUID();
    const fest = randomUUID();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type, weekly_hours)
              values (${auto}, '9891', 'Auto', 'Tage', '2024-01-01', 'teilzeit', 10),
                     (${fest}, '9892', 'Fest', 'Tage', '2024-01-01', 'teilzeit', 10)`;
    for (const wd of [1, 3])
      await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, break_minutes, valid_from)
                values (${randomUUID()}, ${auto}, ${DEMO.siteSchool}, ${wd}, '06:00', '10:00', 0, '2024-01-01')`;
    // Mo + Mi eingeplant → 2 Tage/Woche → 30 × 2/5 = 12; eine Urlaubswoche kostet 2 Tage
    expect((await leaveBalance(sql, auto, 2025)).entitlement).toBe(12);
    expect(await leaveDaysOf(sql, auto, '2025-10-06', '2025-10-12', false)).toBe(2);
    // fest 3 Tage (ohne Einsätze) → 18
    await sql`update app.employees set days_auto = false, days_per_week = 3 where id = ${fest}`;
    expect((await leaveBalance(sql, fest, 2025)).entitlement).toBe(18);
  });

  it('Lücke ohne Einsatz zählt wie die Monate davor (2× wöchentlich), Eintritt mitten im Jahr anteilig', async () => {
    const gap = randomUUID();
    const mid = randomUUID();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type, weekly_hours)
              values (${gap}, '9893', 'Mit', 'Luecke', '2024-01-01', 'teilzeit', 8),
                     (${mid}, '9894', 'Mitte', 'Jahr', '2025-10-01', 'teilzeit', 8)`;
    for (const wd of [2, 4]) {
      await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, break_minutes, valid_from, valid_until)
                values (${randomUUID()}, ${gap}, ${DEMO.siteSchool}, ${wd}, '06:00', '10:00', 0, '2024-01-01', '2025-03-31'),
                       (${randomUUID()}, ${gap}, ${DEMO.siteSchool}, ${wd}, '06:00', '10:00', 0, '2025-07-01', null),
                       (${randomUUID()}, ${mid}, ${DEMO.siteSchool}, ${wd}, '06:00', '10:00', 0, '2025-10-01', null)`;
    }
    expect((await leaveBalance(sql, gap, 2025)).entitlement).toBe(12); // 30 × 2/5, auch April–Juni ohne Einsatz
    expect((await leaveBalance(sql, mid, 2025)).entitlement).toBe(3); // 30 × 2/5 × 3/12
    // Plan erst ab Juli: auch Januar–Juni zählen 2 Tage (nicht 5)
    const late = randomUUID();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type, weekly_hours)
              values (${late}, '9895', 'Spaet', 'Geplant', '2024-01-01', 'teilzeit', 8)`;
    for (const wd of [2, 4])
      await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, break_minutes, valid_from)
                values (${randomUUID()}, ${late}, ${DEMO.siteSchool}, ${wd}, '06:00', '10:00', 0, '2025-07-01')`;
    expect((await leaveBalance(sql, late, 2025)).entitlement).toBe(12);
  });
});
