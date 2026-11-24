import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { leaveBalance } from './absences.js';
import { payrollMonth } from './payroll.js';
import { addRestPeriod, deleteRestPeriod, listRestPeriods } from './rest-periods.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Ruhend von–bis und Geschäftsführer ohne Zuschläge (Datenbank)', () => {
  let sql: Sql;
  const emp = randomUUID();
  const gf = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, hourly_wage_cents)
              values (${emp}, '7801', 'Ruht', 'Test', '2024-01-01', 1500)`;
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, hourly_wage_cents, tags)
              values (${gf}, '7802', 'Chef', 'Test', '2024-01-01', 3000, ${['Geschäftsführer']})`;
    for (let wd = 1; wd <= 5; wd++)
      await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, valid_from, created_at)
                values (${randomUUID()}, ${emp}, ${DEMO.siteSchool}, ${wd}, '06:00', '10:00', '2026-01-01', '2026-01-01 12:00+01')`;
    // GF: 5 × 10 Std. in einer Woche (über der Mehrarbeitsschwelle), auch nachts
    for (const d of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'])
      await sql`insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source, status, created_by)
                values (${randomUUID()}, ${gf}, ${DEMO.siteSchool}, ${d}, ${`${d} 14:00+01`}, ${`${d} 23:30+01`}, 0, 'buero', 'freigegeben', 'test')`;
  }, 60_000);
  afterAll(async () => {
    await sql?.end();
  });

  it('Ruhend: keine Lohnstunden im Zeitraum, weniger Urlaub, Löschen stellt wieder her', async () => {
    const before = await leaveBalance(sql, emp, 2026);
    const id = randomUUID();
    await addRestPeriod(sql, {
      id,
      employeeId: emp,
      start: '2026-11-01',
      end: '2026-12-31',
      reason: 'Test',
      actor: 't',
    });
    await addRestPeriod(sql, {
      id,
      employeeId: emp,
      start: '2026-11-01',
      end: '2026-12-31',
      reason: 'Test',
      actor: 't',
    });
    expect(await listRestPeriods(sql, emp)).toHaveLength(1);
    const rows = await payrollMonth(sql, '2026-11', emp, { fillPlan: true });
    const r = rows[0];
    expect((r?.minutes.normal ?? 0) + (r?.minutes.urlaub ?? 0)).toBe(0);
    const during = await leaveBalance(sql, emp, 2026);
    expect(during.entitlement).toBeLessThan(before.entitlement);
    await expect(
      addRestPeriod(sql, {
        id: randomUUID(),
        employeeId: emp,
        start: '2026-12-01',
        end: '2026-12-05',
        reason: null,
        actor: 't',
      }),
    ).rejects.toThrow(/schon ein Ruhenszeitraum/);
    await deleteRestPeriod(sql, id, emp, 't');
    expect(await listRestPeriods(sql, emp)).toHaveLength(0);
    const [after] = await payrollMonth(sql, '2026-11', emp, { fillPlan: true });
    expect(after?.minutes.normal).toBeGreaterThan(0);
  });

  it('Geschäftsführer: keine Mehrarbeit, keine Zuschläge', async () => {
    const [r] = await payrollMonth(sql, '2026-11', gf);
    expect(r?.minutes.normal).toBe(5 * 570);
    expect(r?.minutes.mehrarbeit).toBe(0);
    expect(r?.minutes.nacht).toBe(0);
    expect(r?.overtimeCents).toBe(0n);
  });
});
