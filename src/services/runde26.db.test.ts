import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { officeConfirmPlanned } from './time.js';

const available = await dbAvailable();

describe.skipIf(!available)('Runde 26: Plan-Zeiten als Ist-Zeiten (Datenbank)', () => {
  let sql: Sql;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date)
              values (${emp}, '8801', 'Plan', 'Ist', '2024-01-01')`;
    // montags 06:00–09:00 seit Januar 2025, angelegt vorher (Soll zählt erst ab Anlage)
    await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, valid_from, valid_until, created_at)
              values (${randomUUID()}, ${emp}, ${DEMO.siteSchool}, 1, '06:00', '09:00', '2025-01-01', '2025-01-31', '2024-12-01')`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('trägt jeden vergangenen Einsatz ohne Zeit ein, freigegeben, doppelt ausführen legt nichts doppelt an', async () => {
    const r = await officeConfirmPlanned(sql, {
      employeeId: emp,
      from: '2025-01-01',
      to: '2025-01-31',
      actor: 'buero',
    });
    expect(r.created).toBe(3); // 13., 20., 27. Januar 2025 – der 06.01. ist Feiertag (Hl. Drei Könige)
    const rows = await sql<{ status: string; source: string; n: number }[]>`
      select status::text, source::text, count(*)::int as n from app.time_entries where employee_id = ${emp} group by 1, 2`;
    expect(rows).toEqual([{ status: 'freigegeben', source: 'soll_bestaetigt', n: 3 }]);
    const [log] =
      await sql`select reason from app.time_entry_log l join app.time_entries t on t.id = l.entry_id
                             where t.employee_id = ${emp} limit 1`;
    expect(log?.reason).toBe('Plan als Ist (Büro)');
    expect(
      (
        await officeConfirmPlanned(sql, {
          employeeId: emp,
          from: '2025-01-01',
          to: '2025-01-31',
          actor: 'buero',
        })
      ).created,
    ).toBe(0);
  });
});
