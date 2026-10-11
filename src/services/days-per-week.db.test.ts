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
});
