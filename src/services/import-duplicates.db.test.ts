import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { uuidOf } from './fortytools-export-import.js';
import { importDuplicates } from './import-duplicates.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Import-Dubletten (Datenbank)', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('XML- und CSV-Datensatz desselben Kunden/Objekts werden zusammengeführt, Leistungen umgehängt, Pauschale abgelöst', async () => {
    const keepC = randomUUID();
    const dupC = randomUUID();
    const keepS = randomUUID();
    const dupS = randomUUID();
    await sql`insert into app.customers (id, customer_no, name, street, postal_code, city, external_ref)
              values (${keepC}, '28801', 'Baufirma Muster GmbH', 'Weg 1', '80331', 'München', 'ftx:c:900'),
                     (${dupC}, '28802', 'Baufirma Muster GmbH', 'Weg 1', '80331', 'München', 'ft:k28802')`;
    await sql`insert into app.sites (id, customer_id, site_no, name, street, postal_code, city, external_ref)
              values (${keepS}, ${keepC}, '2880101', 'Baubüro', 'Weg 1', '80331', 'München', 'ftx:f:77'),
                     (${dupS}, ${dupC}, '2880201', 'Baubüro', 'Weg 1', '80331', 'München', 'ft:o:2880201')`;
    const derived = uuidOf('ftx-service:77:0');
    await sql`insert into app.site_services (id, site_id, kind, description, unit_code, quantity_milli, unit_price_cents,
                                             vat_rate_bp, valid_from, sort_order)
              values (${derived}, ${keepS}, 'monthly_flat', 'Monatspauschale (aus Rechnung)', 'LS', 1000, 100000, 1900, '2026-01-01', 1),
                     (${randomUUID()}, ${dupS}, 'monthly_flat', 'Unterhaltsreinigung', 'LS', 1000, 120000, 1900, '2026-01-01', 1)`;

    const preview = await importDuplicates(sql, { apply: false, actor: 'admin' });
    expect(preview.pairs.map((p) => p.kind).sort()).toEqual(['Kunde', 'Objekt']);
    expect(preview.merged).toBe(0);

    const res = await importDuplicates(sql, { apply: true, actor: 'admin' });
    expect(res.merged).toBe(2);
    expect(res.derivedOff).toBe(1);
    expect((await sql`select 1 from app.customers where id = ${dupC}`).length).toBe(0);
    expect((await sql`select 1 from app.sites where id = ${dupS}`).length).toBe(0);
    const active = await sql<{ unit_price_cents: bigint }[]>`
      select unit_price_cents from app.site_services where site_id = ${keepS} and active`;
    expect(active.map((r) => Number(r.unit_price_cents))).toEqual([120000]);

    // zweiter Lauf findet nichts mehr
    expect((await importDuplicates(sql, { apply: true, actor: 'admin' })).pairs).toEqual([]);
  });
});
