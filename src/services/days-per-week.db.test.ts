import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { leaveBalance, leaveDaysOf } from './absences.js';
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

  it('Eintritt/Austritt: anteilig, gesetzlicher Mindesturlaub nach § 5 BUrlG bleibt', async () => {
    const mk = async (no: string, entry: string, exit: string | null, days: number) => {
      const id = randomUUID();
      await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, exit_date, employment_type, weekly_hours, annual_leave_days)
                values (${id}, ${no}, 'Ein', 'Tritt', ${entry}, ${exit}, 'vollzeit', 40, ${days})`;
      return (await leaveBalance(sql, id, 2026)).entitlement;
    };
    expect(await mk('9881', '2026-10-01', null, 30)).toBe(7.5); // Wartezeit im Jahr nicht erfüllt → nur anteilig
    expect(await mk('9882', '2026-03-01', null, 30)).toBe(25); // 10/12 von 30
    expect(await mk('9883', '2026-03-15', null, 24)).toBe(20); // 9/12 von 24 = 18 → Mindesturlaub 20
    expect(await mk('9884', '2020-01-01', '2026-05-31', 24)).toBe(10); // Austritt 1. Halbjahr → anteilig
    expect(await mk('9885', '2020-01-01', '2026-08-31', 24)).toBe(20); // Austritt 2. Halbjahr → Mindesturlaub
  });
});
