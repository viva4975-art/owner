import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { PLANEGG_GLASS, ensurePlaneggGlass, normStreet } from './planegg-glass.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Glasreinigung Gemeinde Planegg', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('legt je Gebäude eine halbjährliche Leistung nach Ausführung mit halbem Jahrespreis an, nur einmal', async () => {
    expect(normStreet('Pasinger Straße 20 a')).toBe(normStreet('Pasingerstr. 20a'));
    const cust = randomUUID();
    await sql`insert into app.customers (id, customer_no, name, street, postal_code, city)
              values (${cust}, '20022', 'Gemeinde Planegg', 'Pasingerstr. 8', '82152', 'Planegg')`;
    const sites: Record<string, string> = {};
    for (const [i, g] of PLANEGG_GLASS.entries()) {
      if (g.key === 'n') continue; // ein Gebäude fehlt → wird gemeldet
      sites[g.key] = randomUUID();
      await sql`insert into app.sites (id, customer_id, site_no, name, street, postal_code, city)
                values (${sites[g.key]!}, ${cust}, ${`20022${String(i).padStart(2, '0')}`}, ${g.name},
                        ${g.street}, '82152', 'Planegg')`;
    }
    const r = await ensurePlaneggGlass(sql, 't');
    expect(r).toMatchObject({ created: 18, existing: 0 });
    expect(r!.missing).toEqual(['n Obdachlosenunterkunft']);
    const rows = await sql<
      { site_id: string; unit_price_cents: bigint; billing_cycle: string; kind: string }[]
    >`
      select site_id, unit_price_cents, billing_cycle, kind from app.site_services where site_id in ${sql(Object.values(sites))}`;
    expect(rows).toHaveLength(18);
    const rathaus = rows.find((x) => x.site_id === sites.f)!;
    expect(rathaus.unit_price_cents).toBe(145720n); // 2.914,41 € ÷ 2
    expect(rathaus.billing_cycle).toBe('halbjaehrlich');
    expect(rathaus.kind).toBe('special'); // nach Ausführung, nicht im Monatslauf
    // Kinderhort 8a und Rathaus 8 nicht verwechselt
    expect(rows.find((x) => x.site_id === sites.d)!.unit_price_cents).toBe(27592n);
    expect(await ensurePlaneggGlass(sql, 't')).toBeNull();
  });
});
