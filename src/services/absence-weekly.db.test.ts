import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { listAbsenceHours, listAbsences, requestAbsence, weeklyModeDays } from './absences.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe('weeklyModeDays', () => {
  it('3 Tage = Mo–Mi, 2,5 = Mo, Di + halber Mi, ohne Feiertag', () => {
    // 2026-11-16 Mo … 2026-11-22 So
    expect(weeklyModeDays('2026-11-16', '2026-11-22', 3).map((x) => x.date)).toEqual([
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
    ]);
    expect(weeklyModeDays('2026-11-16', '2026-11-22', 2.5).map((x) => x.part)).toEqual([1, 1, 0.5]);
    // 25.12.2026 Fr ist Feiertag
    expect(weeklyModeDays('2026-12-21', '2026-12-27', 5).length).toBe(4);
  });
});

// Ahmed 25.11.: Urlaub „Stunden ohne Einsatz“ nach Wochenstunden ÷ Tage, mit Objekt/Kostenstelle
describe.skipIf(!available)('Abwesenheit Stunden ohne Einsatz (Datenbank)', () => {
  let sql: Sql;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, hourly_wage_cents, weekly_hours, employment_type)
              values (${emp}, '3955', 'Test', 'Wochen', '2024-01-01', 1500, 20, 'teilzeit')`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('20 Std. auf 4 Tage = 5 Std. je Tag Mo–Do am Objekt, 4 Urlaubstage je Woche', async () => {
    const id = randomUUID();
    await requestAbsence(sql, {
      id,
      employeeId: emp,
      kind: 'urlaub',
      start: '2027-02-01',
      end: '2027-02-07',
      halfDay: false,
      note: null,
      actor: 'buero',
      approved: true,
      allowNoLeave: true,
      hours: { weeklyMinutes: 1200, days: 4 },
      siteId: DEMO.siteSchool,
    });
    const h = await listAbsenceHours(sql, { absenceId: id });
    expect(h.map((x) => x.work_date)).toEqual(['2027-02-01', '2027-02-02', '2027-02-03', '2027-02-04']);
    expect(h.every((x) => x.minutes === 300 && x.site_id === DEMO.siteSchool && x.paid)).toBe(true);
    const [row] = (await listAbsences(sql, { employeeId: emp })).filter((a) => a.id === id);
    expect(row?.days).toBe(4);
  });
});
