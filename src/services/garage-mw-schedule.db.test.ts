import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { applyMwSchedule2026 } from './garage-mw-schedule.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Termine Münchner Wohnen 2026', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('trägt Termine ein, Fläche aus der Liste, Herbst ab Oktober vorgemerkt, September nicht', async () => {
    const cust = randomUUID();
    await sql`insert into app.customers (id, customer_no, name, street, postal_code, city)
              values (${cust}, '29917', 'Münchner Wohnen GmbH', 'Gustav-Heinemann-Ring 111', '81739', 'München')`;
    const esswurm = randomUUID();
    const sigl = randomUUID();
    await sql`insert into app.sites (id, customer_id, site_no, name, street, postal_code, city)
              values (${esswurm}, ${cust}, '2001703', 'TG 3 - Sendling-Westpark', 'Esswurmstr. 27', '81371', 'München'),
                     (${sigl}, ${cust}, '2001729', 'TG 27- Sendling- Westpark', 'Siglstr. 23', '80686', 'München')`;
    const r = await applyMwSchedule2026(sql, 't');
    // Esswurmstr.: Frühjahr 16.03. + Herbst 13.10.; Siglstr.: Frühjahr + Herbst 22.09.
    expect(r.appointments).toBe(4);
    const [o] = await sql<{ sqm: number }[]>`select sqm from app.tg_objects where site_id = ${esswurm}`;
    expect(o!.sqm).toBe(370);
    const ex = await sql<{ site_id: string; date_from: string; total: bigint }[]>`
      select e.site_id, e.date_from::text, e.quantity_milli * e.unit_price_cents / 1000 as total
        from app.service_executions e`;
    expect(ex).toEqual([{ site_id: esswurm, date_from: '2026-10-13', total: 11840n }]); // 370 m² × 0,32 €
    expect((await applyMwSchedule2026(sql, 't')).appointments).toBe(0);
  });
});
