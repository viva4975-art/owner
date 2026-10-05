import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { DEMO } from './seed.js';
import { filteredSites, parseSiteFilter, sitesCsv } from './site-list.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Objektliste', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into auth.users (id) values ('00000000-0000-4000-8000-00000000a001') on conflict do nothing`;
    await sql`insert into app.profiles (user_id, display_name, role) values ('00000000-0000-4000-8000-00000000a001', 'Olga OL', 'objektleitung')`;
    await sql`update app.sites set manager_user_id = '00000000-0000-4000-8000-00000000a001' where id = ${DEMO.siteSchool}`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Kunde, Objektleitung, Filter, Sortierung, Bereich der Objektleitung', async () => {
    const f = parseSiteFilter(() => undefined);
    const all = await filteredSites(sql, null, f);
    const school = all.rows.find((r) => r.id === DEMO.siteSchool)!;
    expect(school.manager_name).toBe('Olga OL');
    expect(school.customer_no).toMatch(/^\d+$/);
    const mine = await filteredSites(sql, null, { ...f, manager: '00000000-0000-4000-8000-00000000a001' });
    expect(mine.rows.map((r) => r.id)).toEqual([DEMO.siteSchool]);
    const without = await filteredSites(sql, null, { ...f, manager: 'ohne' });
    expect(without.rows.some((r) => r.id === DEMO.siteSchool)).toBe(false);
    const byLetter = await filteredSites(sql, null, { ...f, letter: school.name[0]!.toUpperCase() });
    expect(byLetter.rows.map((r) => r.id)).toContain(DEMO.siteSchool);
    const desc = await filteredSites(sql, null, { ...f, desc: true });
    expect(desc.rows.map((r) => r.id)).toEqual([...all.rows].reverse().map((r) => r.id));
    const scoped = await filteredSites(sql, [DEMO.siteOffice], f);
    expect(scoped.rows.map((r) => r.id)).toEqual([DEMO.siteOffice]);
    expect(sitesCsv(all.rows)).toContain('Olga OL');
    expect(parseSiteFilter((k) => ({ sort: 'x; drop', buchstabe: 'ab', ol: 'evil' })[k])).toMatchObject({
      sort: 'nummer',
      letter: null,
      manager: null,
    });
  });
});
