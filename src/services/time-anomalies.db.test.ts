import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { clockIn } from './time.js';
import { planDiff, reviewAnomalies, timeAnomalies } from './time-anomalies.js';
import { createUser, saveEmployeeLink } from './users.js';

const available = await dbAvailable();

describe('planDiff', () => {
  it('stark = mind. 30 Min. und 25 %', () => {
    expect(planDiff(240, 180)).toBe(60);
    expect(planDiff(200, 180)).toBeNull(); // 20 Min.
    expect(planDiff(600, 560)).toBeNull(); // 40 Min., aber < 25 %
    expect(planDiff(60, 120)).toBe(-60);
  });
});

describe.skipIf(!available)('Auffällige Zeiten / Stempeln Büro (Datenbank)', () => {
  let sql: Sql;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date)
              values (${emp}, '7811', 'Auf', 'Fällig', '2024-01-01')`;
    await sql`insert into app.employee_sites (employee_id, site_id) values (${emp}, ${DEMO.siteSchool})`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('meldet starke Abweichung vom Plan und „nicht am Objekt“, geprüft verschwindet', async () => {
    const day = (
      await sql<{ d: string }[]>`select ((now() at time zone 'Europe/Berlin')::date - 2)::text as d`
    )[0]!.d;
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay() || 7;
    const plan = randomUUID();
    await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, break_minutes, valid_from)
              values (${plan}, ${emp}, ${DEMO.siteSchool}, ${dow}, '06:00', '09:00', 0, '2024-01-01')`;
    const a = randomUUID();
    const b = randomUUID();
    await sql`insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source,
                status, shift_plan_id, created_by, end_geo, end_geo_m)
              values (${a}, ${emp}, ${DEMO.siteSchool}, ${day}, (${day}::date + time '06:00') at time zone 'Europe/Berlin',
                      (${day}::date + time '11:00') at time zone 'Europe/Berlin', 0, 'buero', 'freigegeben', ${plan}, 't',
                      'entfernt', 2400)`;
    // passt zum Plan, am Objekt → nicht auffällig
    await sql`insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source,
                status, created_by, end_geo)
              values (${b}, ${emp}, ${DEMO.siteSchool}, ${day}::date - 7,
                      ((${day}::date - 7) + time '06:00') at time zone 'Europe/Berlin',
                      ((${day}::date - 7) + time '09:10') at time zone 'Europe/Berlin', 0, 'buero', 'freigegeben', 't',
                      'am_objekt')`;
    const list = await timeAnomalies(sql);
    const hit = list.find((x) => x.entryId === a)!;
    expect(hit.diffMin).toBe(120);
    expect(hit.reasons.join(' ')).toContain('nicht am Objekt (2,4 km)');
    expect(list.some((x) => x.entryId === b)).toBe(false);
    // Objektleitung ohne Objekte sieht nichts
    expect(await timeAnomalies(sql, { managerUserId: randomUUID() })).toHaveLength(0);
    expect(await reviewAnomalies(sql, [a], 'ahmed')).toBe(1);
    expect((await timeAnomalies(sql)).some((x) => x.entryId === a)).toBe(false);
  });

  it('Objektleitung mit verknüpftem Mitarbeiter stempelt an eigenen Objekten ohne Einsatz', async () => {
    const own = randomUUID();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date)
              values (${own}, '7812', 'Olga', 'Leitung', '2024-01-01')`;
    const { id: uid } = await createUser(
      sql,
      {
        login: 'olga.l',
        name: 'Olga Leitung',
        email: null,
        role: 'objektleitung',
        password: 'Start12345x',
        mustChange: false,
      },
      'ahmed',
    );
    await saveEmployeeLink(sql, uid, own, 'ahmed');
    const id = randomUUID();
    await expect(
      clockIn(sql, { id, employeeId: own, siteId: DEMO.siteSchool, viaQr: false, actor: 't' }),
    ).rejects.toThrow(/nicht zugeordnet/);
    await sql`update app.sites set manager_user_id = ${uid} where id = ${DEMO.siteSchool}`;
    await clockIn(sql, { id, employeeId: own, siteId: DEMO.siteSchool, viaQr: false, actor: 't' });
    const [r] = await sql`select status from app.time_entries where id = ${id}`;
    expect(r!.status).toBe('laeuft');
  });
});
