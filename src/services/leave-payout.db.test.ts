import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { addLeavePayout, deleteLeavePayout, leaveExitPreview } from './absences.js';
import { payrollMonth } from './payroll.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

// Ahmed 25.11.: nur volle Monate zählen (Austritt 07.12. → Dezember zählt nicht); Urlaubsabgeltung § 7 Abs. 4 BUrlG
describe.skipIf(!available)('Urlaub volle Monate und Urlaubsabgeltung (Datenbank)', () => {
  let sql: Sql;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, exit_date,
                hourly_wage_cents, weekly_hours, days_per_week, days_auto, employment_type)
              values (${emp}, '3966', 'Test', 'Abgeltung', '2026-05-11', '2026-12-07', 1500, 24, 3, false, 'teilzeit')`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Eintritt 11.05., Austritt 07.12., 3 Tage/Woche: Juni–November = 6 × 1,5 = 9', async () => {
    const p = await leaveExitPreview(sql, emp);
    expect(p!.at).toBe('2026-12-07');
    expect(p!.entitlement).toBe(9);
    // Austritt am Monatsletzten zählt der Monat voll
    const q = await leaveExitPreview(sql, emp, '2026-11-30');
    expect(q!.entitlement).toBe(9);
    const r = await leaveExitPreview(sql, emp, '2026-11-29');
    expect(r!.entitlement).toBe(7.5);
  });

  it('Abgeltung: 9 Tage × 8 Std. = 72 Std. Lohnart, am Objekt, Rest 0', async () => {
    const id = randomUUID();
    const add = () =>
      addLeavePayout(sql, {
        id,
        employeeId: emp,
        leaveYear: 2026,
        month: '2026-12',
        days: 9,
        minutesPerDay: 480,
        siteId: DEMO.siteSchool,
        note: '',
        actor: 'test',
      });
    await add();
    await add(); // doppelt absenden → einmal
    const p = await leaveExitPreview(sql, emp);
    expect(p!.paidOut).toBe(9);
    expect(p!.rest).toBe(0);
    const [row] = await payrollMonth(sql, '2026-12', emp);
    expect(row!.minutes.urlaubsabgeltung).toBe(72 * 60);
    expect(row!.siteMinutes[DEMO.siteSchool]).toBe(72 * 60);
    await deleteLeavePayout(sql, id, emp, 'test');
    expect((await leaveExitPreview(sql, emp))!.rest).toBe(9);
  });
});
