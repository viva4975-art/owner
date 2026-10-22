import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { markNotStarted, revokeExit } from './employees.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Mitarbeiter nicht angetreten', () => {
  let sql: Sql;
  const emp = randomUUID();
  const worked = randomUUID();
  const site = randomUUID();
  const plan = randomUUID();
  const abs = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    const cust = randomUUID();
    await sql`insert into app.customers (id, customer_no, name, street, postal_code, city)
              values (${cust}, '29911', 'Kunde NA', 'Weg 1', '80331', 'München')`;
    await sql`insert into app.sites (id, customer_id, site_no, name) values (${site}, ${cust}, '2991101', 'Objekt NA')`;
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type, weekly_hours)
              values (${emp}, '9881', 'Nora', 'Neu', '2026-10-20', 'teilzeit', 20),
                     (${worked}, '9882', 'Willi', 'War', '2026-10-01', 'teilzeit', 20)`;
    await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, break_minutes, valid_from)
              values (${plan}, ${emp}, ${site}, 1, '06:00', '10:00', 0, '2026-10-20')`;
    await sql`insert into app.absences (id, employee_id, kind, start_date, end_date, half_day, status, requested_by)
              values (${abs}, ${emp}, 'urlaub', '2026-12-28', '2026-12-30', false, 'genehmigt', 'test')`;
    await sql`insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source, status, created_by)
              values (${randomUUID()}, ${worked}, ${site}, '2026-10-05', '2026-10-05 06:00+02', '2026-10-05 10:00+02', 0, 'buero', 'freigegeben', 'test')`;
  }, 60_000);
  afterAll(async () => {
    await sql?.end();
  });

  it('Austritt zum Eintrittstag, Einsätze wieder offen, Abwesenheiten storniert', async () => {
    const r = await markNotStarted(sql, emp, 'test');
    expect(r).toEqual({ shifts: 1, absences: 1 });
    const [e] = await sql`select status, exit_date::text, exit_reason from app.employees where id = ${emp}`;
    expect(e).toMatchObject({
      status: 'ausgetreten',
      exit_date: '2026-10-20',
      exit_reason: 'Nicht angetreten',
    });
    const [p] = await sql`select employee_id from app.shift_plans where id = ${plan}`;
    expect(p!.employee_id).toBeNull();
    const [a] = await sql`select status from app.absences where id = ${abs}`;
    expect(a!.status).toBe('storniert');
    await expect(markNotStarted(sql, emp, 'test')).rejects.toThrow(/schon ein Austritt/);
    await revokeExit(sql, emp);
  });

  it('nicht möglich, wenn schon Arbeitszeit erfasst ist', async () => {
    await expect(markNotStarted(sql, worked, 'test')).rejects.toThrow(/Austritt erfassen/);
  });
});
