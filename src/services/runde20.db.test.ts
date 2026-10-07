import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { importFtx } from './fortytools-xml-import.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { deleteShiftPlans, officeSave } from './time.js';

const available = await dbAvailable();
const enc = (s: string) => new TextEncoder().encode(s);

describe.skipIf(!available)('Runde 20 (Datenbank)', () => {
  let sql: Sql;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date)
              values (${emp}, '9301', 'Erna', 'Einsatz', '2025-01-01')`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  const plan = async (from: string) => {
    const id = randomUUID();
    await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, valid_from)
              values (${id}, ${emp}, ${DEMO.siteSchool}, 1, '06:00', '09:00', ${from})`;
    return id;
  };

  it('Einsatz löschen: ohne erfasste Zeit ganz weg (mit Protokoll), mit Zeit abgelehnt', async () => {
    const a = await plan('2025-01-06');
    expect(await deleteShiftPlans(sql, [a], 'buero')).toBe(1);
    expect((await sql`select 1 from app.shift_plans where id = ${a}`).length).toBe(0);
    const [log] = await sql`select details from app.audit_log where action = 'delete' and entity_id = ${a}`;
    expect(log?.details).toMatchObject({ id: a, start_time: '06:00:00' });

    const b = await plan('2025-01-06');
    await officeSave(sql, {
      id: randomUUID(),
      employeeId: emp,
      siteId: DEMO.siteSchool,
      date: '2025-01-06',
      start: '06:00',
      end: '09:00',
      breakMinutes: 0,
      reason: 'Test',
      expectedVersion: null,
      actor: 'buero',
    });
    // 06.01.2025 ist ein Montag → Zeit gehört zum Einsatz, Löschen wird abgelehnt
    await expect(deleteShiftPlans(sql, [b], 'buero')).rejects.toThrow(/beenden/);
    expect((await sql`select 1 from app.shift_plans where id = ${b}`).length).toBe(1);
  });

  it('Fortytools-XML: Tiefgaragen kommen zusätzlich in die Tiefgaragenplanung (verknüpft, nichts doppelt)', async () => {
    const files = [
      {
        name: 'customers.xml',
        data: enc(`<customers><customer><number>29988</number><shortname>Dawo</shortname>
          <address><addressable-id>701</addressable-id><name>Dawonia Test GmbH</name><street>A 1</street><zip>80331</zip><city>München</city></address>
          </customer></customers>`),
      },
      {
        name: 'facilities.xml',
        data: enc(`<facilities>
          <facility><number>2998801</number><customer-id>701</customer-id><address><addressable-id>801</addressable-id><name>TG 245</name><street>Garagenweg 2</street><zip>80331</zip><city>München</city></address></facility>
          <facility><number>2998802</number><customer-id>701</customer-id><address><addressable-id>802</addressable-id><name>Wohnanlage Nord</name><street>B 2</street><zip>80331</zip><city>München</city></address></facility>
          </facilities>`),
      },
    ];
    const r = await importFtx(sql, files, { actor: 't', dryRun: false });
    expect(r.counts.Tiefgaragen).toMatchObject({ neu: 1 });
    const [tg] = await sql`select t.customer, t.name, t.object_no, s.site_no from app.tg_objects t
                            join app.sites s on s.id = t.site_id where t.legacy_id = 'ftx:f:801'`;
    expect(tg).toMatchObject({
      customer: 'Dawonia',
      name: 'TG 245',
      object_no: '2998801',
      site_no: '2998801',
    });
    const r2 = await importFtx(sql, files, { actor: 't', dryRun: false });
    expect(r2.counts.Tiefgaragen).toMatchObject({ neu: 0, unveraendert: 1 });
  });
});
