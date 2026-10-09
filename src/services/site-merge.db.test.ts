import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { mergeSites, mergedRefs } from './site-merge.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Objekte zusammenführen', () => {
  let sql: Sql;
  const cust = randomUUID();
  const keep = randomUUID();
  const dup = randomUUID();
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.customers (id, customer_no, name, street, postal_code, city)
              values (${cust}, '28901', 'ARGE Test', 'Weg 1', '80331', 'München')`;
    await sql`insert into app.sites (id, customer_id, site_no, name, street, postal_code, city, external_ref)
              values (${keep}, ${cust}, '2890101', 'Schule Nord', 'Weg 1', '80331', 'München', null),
                     (${dup}, ${cust}, '2890102', 'Schule Nord (2)', 'Weg 1', '80331', 'München', 'ftx:f:4711')`;
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, weekly_hours)
              values (${emp}, '8901', 'Ida', 'Test', '2026-01-01', 20)`;
    await sql`insert into app.employee_sites (employee_id, site_id) values (${emp}, ${keep}), (${emp}, ${dup})`;
    await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, break_minutes, valid_from)
              values (${randomUUID()}, ${emp}, ${dup}, 1, '06:00', '09:00', 0, '2026-09-01')`;
    await sql`insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, source, status, created_by)
              values (${randomUUID()}, ${emp}, ${dup}, '2026-09-07', '2026-09-07 06:00+02', '2026-09-07 09:00+02',
                      'buero', 'freigegeben', 'test')`;
    await sql`insert into app.site_services (id, site_id, kind, description, unit_code, quantity_milli, unit_price_cents,
                                             vat_rate_bp, valid_from, sort_order, cost_center)
              values (${randomUUID()}, ${dup}, 'monthly_flat', 'Unterhaltsreinigung', 'LS', 1000, 120000, 1900, '2026-01-01', 1, '2890102')`;
    await sql`insert into app.notes (id, entity_type, entity_id, body, author)
              values (${randomUUID()}, 'site', ${dup}, 'Schlüssel beim Hausmeister', 'test')`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('hängt alles um, löscht die Dublette, merkt die Fortytools-ID', async () => {
    await expect(mergeSites(sql, keep, keep, 't')).rejects.toThrow(/anderes Objekt/);
    const r = await mergeSites(sql, dup, keep, 't');
    expect(r.deleted).toBe(true);
    expect(r.left).toEqual({});
    const [n] = await sql<{ te: number; sp: number; sv: number; no: number; es: number }[]>`
      select (select count(*)::int from app.time_entries where site_id = ${keep}) as te,
             (select count(*)::int from app.shift_plans where site_id = ${keep}) as sp,
             (select count(*)::int from app.site_services where site_id = ${keep}) as sv,
             (select count(*)::int from app.notes where entity_type = 'site' and entity_id = ${keep}) as no,
             (select count(*)::int from app.employee_sites where site_id = ${keep}) as es`;
    expect(n).toEqual({ te: 1, sp: 1, sv: 1, no: 1, es: 1 });
    const [s] = await sql<{ external_ref: string }[]>`select external_ref from app.sites where id = ${keep}`;
    expect(s!.external_ref).toBe('ftx:f:4711');
    expect((await mergedRefs(sql)).get('ftx:f:4711')).toBe(keep);
    const [sv] = await sql<
      { cost_center: string }[]
    >`select cost_center from app.site_services where site_id = ${keep}`;
    expect(sv!.cost_center).toBe('2890101');
  });

  it('Objektnummer ändern → Kostenstelle der Leistungen zieht mit (nur wenn sie die alte Nummer war)', async () => {
    await sql`insert into app.site_services (id, site_id, kind, description, unit_code, quantity_milli, unit_price_cents,
                                             vat_rate_bp, valid_from, sort_order, cost_center)
              values (${randomUUID()}, ${keep}, 'monthly_flat', 'Glas', 'LS', 1000, 5000, 1900, '2026-01-01', 2, '9000')`;
    await sql`update app.sites set site_no = '2890199' where id = ${keep}`;
    const rows = await sql<{ cost_center: string }[]>`
      select cost_center from app.site_services where site_id = ${keep} order by sort_order`;
    expect(rows.map((r) => r.cost_center)).toEqual(['2890199', '9000']);
  });
});
