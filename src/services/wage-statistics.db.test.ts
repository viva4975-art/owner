import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { saveWageStatKeys, saveWageStatSettings, wageStatCsv, wageStatRows } from './wage-statistics.js';

const available = await dbAvailable();

describe.skipIf(!available)('Verdiensterhebung (Datenbank)', () => {
  let sql: Sql;
  const hourly = randomUUID();
  const mini = randomUUID();
  const gone = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, hourly_wage_cents, salutation, employment_type)
              values (${hourly}, '7701', 'Anna', 'Stunde', '2024-03-15', 1500, 'Frau', 'teilzeit')`;
    await sql`insert into app.employee_private (employee_id, birth_date, nationality) values (${hourly}, '1985-04-02', 'rumänisch')`;
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type, pay_model,
                                         monthly_salary_cents, weekly_hours, salutation)
              values (${mini}, '7702', 'Max', 'Mini', '2025-10-01', 'minijob', 'festgehalt', 58500, 10, 'Herr')`;
    await sql`insert into app.employee_private (employee_id, birth_date, nationality) values (${mini}, '1990-12-24', 'Deutschland')`;
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, exit_date, status)
              values (${gone}, '7703', 'Alt', 'Weg', '2020-01-01', '2026-09-30', 'ausgetreten')`;
    // 2 Tage à 4 Std. erfasst
    for (const d of ['2026-10-05', '2026-10-06'])
      await sql`insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source, status, created_by)
                values (${randomUUID()}, ${hourly}, ${DEMO.siteSchool}, ${d}, (${d}::date + time '06:00') at time zone 'Europe/Berlin',
                        (${d}::date + time '10:00') at time zone 'Europe/Berlin', 0, 'buero', 'freigegeben', 't')`;
  });
  afterAll(() => sql?.end());

  it('rechnet Stunden/Brutto, schlägt Schlüssel vor und schreibt die CSV wie IDEV/CORE', async () => {
    const rows = await wageStatRows(sql, '2026-10');
    expect(rows.find((r) => r.employee_id === gone)).toBeUndefined();
    const a = rows.find((r) => r.employee_id === hourly)!;
    expect([a.gender, a.birth, a.entry, a.nationality_key, a.deuev_group, a.activity_key]).toEqual([
      '2',
      '041985',
      '032024',
      '154',
      '101',
      '541019912',
    ]);
    expect(a.hours_cents).toBe(800n);
    expect(a.gross_cents).toBe(12000n);
    const m = rows.find((r) => r.employee_id === mini)!;
    expect([m.gender, m.deuev_group, m.nationality_key]).toEqual(['1', '109', '000']);
    expect(m.hours_cents).toBe(4330n); // 10 Std./Woche × 4,33
    expect(m.gross_cents).toBe(58500n);

    await saveWageStatSettings(sql, { report_unit_id: '0123456789', tariff_binding: 1 }, 't');
    const base = {
      report_unit_id: '0123456789',
      tariff_binding: 1,
      fusion: false,
      konjunkturKurz: false,
      saisonKurz: false,
      streik: false,
      sonstige: true,
      remarks: 'neue Objekte; Test',
    };
    const csv = wageStatCsv([a, m], { ...base, format: 'core' }).split('\r\n');
    expect(csv[0]).toBe('0123456789');
    expect(csv[1]).toBe('B;1;0;0;0;0;1;neue Objekte Test');
    expect(csv[2]).toBe('P;7701;2;041985;154;032024;101;541019912;;8,00;0,00;120,00;0,00;0,00;0,00;0,00');
    const idev = wageStatCsv([a], { ...base, format: 'idev' }).split('\r\n');
    expect(idev[0]!.startsWith('B;')).toBe(true);

    await saveWageStatKeys(sql, [
      { employee_id: hourly, deuev_group: '101', activity_key: '541012212', nationality_key: '154' },
    ]);
    const again = (await wageStatRows(sql, '2026-10')).find((r) => r.employee_id === hourly)!;
    expect([again.activity_key, again.stored.activity]).toEqual(['541012212', true]);
    await expect(
      saveWageStatKeys(sql, [
        { employee_id: hourly, deuev_group: '1', activity_key: 'x', nationality_key: '' },
      ]),
    ).rejects.toThrow(/3 Ziffern/);
  });
});
