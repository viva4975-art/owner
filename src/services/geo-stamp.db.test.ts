import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { clockIn, clockOut } from './time.js';

const available = await dbAvailable();

describe.skipIf(!available)('Stempeln mit Standort (Datenbank)', () => {
  let sql: Sql;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date)
              values (${emp}, '7801', 'Geo', 'Test', '2024-01-01')`;
    await sql`insert into app.employee_sites (employee_id, site_id) values (${emp}, ${DEMO.siteSchool})`;
    await sql`update app.sites set geo_lat = 48.137154, geo_lng = 11.575382, geo_radius_m = 200 where id = ${DEMO.siteSchool}`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('nur bei eingeschalteter Prüfung; speichert Bewertung + Entfernung, keine Koordinaten', async () => {
    const a = randomUUID();
    await clockIn(sql, {
      id: a,
      employeeId: emp,
      siteId: DEMO.siteSchool,
      viaQr: false,
      actor: 't',
      geo: { lat: 48.137, lng: 11.5754, acc: 15 },
    });
    const [x] = await sql`select start_geo from app.time_entries where id = ${a}`;
    expect(x!.start_geo).toBeNull(); // Prüfung aus
    await sql`update app.time_entries set start_at = start_at - interval '2 hours' where id = ${a}`;
    await sql`update app.time_settings set geo_check = true`;
    await clockOut(sql, {
      employeeId: emp,
      breakMinutes: 0,
      actor: 't',
      geo: { lat: 48.139126, lng: 11.565972, acc: 20 },
    });
    const [y] = await sql`select end_geo, end_geo_m, end_geo_acc_m from app.time_entries where id = ${a}`;
    expect(y).toMatchObject({ end_geo: 'entfernt', end_geo_acc_m: 20 });
    expect(y!.end_geo_m).toBeGreaterThan(700);
    const cols = await sql`select column_name from information_schema.columns
                            where table_schema = 'app' and table_name = 'time_entries' and column_name ~ 'lat|lng'`;
    expect(cols).toHaveLength(0);
  });
});
