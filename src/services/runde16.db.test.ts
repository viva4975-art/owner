import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { absentBetween, absentOn, requestAbsence } from './absences.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Runde 16: Heute abwesend (Datenbank)', () => {
  let sql: Sql;
  const a = randomUUID();
  const b = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, annual_leave_days)
              values (${a}, '7001', 'Ana', 'Abwesend', '2024-01-01', 30), (${b}, '7002', 'Ben', 'Anderswo', '2024-01-01', 30)`;
    await sql`insert into app.employee_sites (employee_id, site_id) values (${a}, ${DEMO.siteSchool})`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('nur genehmigte, am Tag, Objektleitung nur Mitarbeitende ihrer Objekte', async () => {
    await requestAbsence(sql, {
      id: randomUUID(),
      employeeId: a,
      kind: 'krank',
      start: '2026-11-02',
      end: '2026-11-04',
      halfDay: false,
      note: null,
      actor: 'buero',
      approved: true,
    });
    await requestAbsence(sql, {
      id: randomUUID(),
      employeeId: b,
      kind: 'urlaub',
      start: '2026-11-03',
      end: '2026-11-03',
      halfDay: false,
      note: null,
      actor: 'b',
      approved: false,
    });
    const all = await absentOn(sql, '2026-11-03', null);
    expect(all.map((x) => x.name)).toEqual(['Ana Abwesend']); // Bens Antrag ist nur beantragt
    expect(all[0]!.sites.length).toBe(1);
    expect(await absentOn(sql, '2026-11-05', null)).toEqual([]);
    // Objektleitung: nur zugeordnet reicht nicht – die Person muss dort eingeplant sein (Ahmed 09.10.)
    expect(await absentOn(sql, '2026-11-03', [DEMO.siteSchool])).toEqual([]);
    const plan = randomUUID();
    await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, break_minutes, valid_from, valid_until)
              values (${plan}, ${a}, ${DEMO.siteSchool}, 2, '06:00', '09:00', 0, '2026-01-01', '2026-10-31')`;
    expect(await absentOn(sql, '2026-11-03', [DEMO.siteSchool])).toEqual([]); // Einsatz schon beendet
    await sql`update app.shift_plans set valid_until = null where id = ${plan}`;
    const ol = await absentOn(sql, '2026-11-03', [DEMO.siteSchool]);
    expect(ol.length).toBe(1);
    expect(ol[0]!.sites.length).toBe(1);
    expect(await absentOn(sql, '2026-11-03', [randomUUID()])).toEqual([]);
    // eine Woche vorher: Abwesenheit ab 02.11. erscheint ab 26.10. unter „nächste 7 Tage“
    expect((await absentBetween(sql, '2026-10-26', '2026-11-02', null)).map((x) => x.kind)).toEqual([
      'krank',
    ]);
    expect(await absentBetween(sql, '2026-10-25', '2026-11-01', null)).toEqual([]);
  });
});
