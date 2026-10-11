import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { absenceStats, anonName } from './absence-stats.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Ausfallzeiten für die Kalkulation (Datenbank)', () => {
  let sql: Sql;
  const a = randomUUID();
  const b = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type, weekly_hours)
              values (${a}, '99101', 'Anna', 'Ausfall', '2025-01-01', 'vollzeit', 39),
                     (${b}, '99102', 'Bert', 'Ausfall', '2025-07-01', 'teilzeit', 20)`;
    const abs = (emp: string, kind: string, s: string, e: string, half = false, status = 'genehmigt') =>
      sql`insert into app.absences (id, employee_id, kind, start_date, end_date, half_day, status, requested_by)
          values (${randomUUID()}, ${emp}, ${kind}, ${s}, ${e}, ${half}, ${status}, 't')`;
    await abs(a, 'urlaub', '2025-03-03', '2025-03-07'); // 5 Tage
    await abs(a, 'krank', '2025-04-14', '2025-04-22'); // 7 Mo–Fr − Karfreitag − Ostermontag = 5
    await abs(a, 'kind_krank', '2025-05-05', '2025-05-05', true); // 0,5
    await abs(a, 'urlaub', '2025-08-04', '2025-08-08', false, 'beantragt'); // zählt nicht
    await abs(b, 'urlaub', '2025-07-07', '2025-07-08'); // vor Stichtag → steckt im Anfangsbestand
    await abs(b, 'urlaub', '2025-08-04', '2025-08-06'); // 3
    await sql`insert into app.leave_openings (employee_id, year, as_of, taken_days, sick_as_of, sick_days, source, updated_by)
              values (${b}, 2025, '2025-07-31', 4, '2025-07-31', 2, 'test', 't')`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('zählt Urlaub/Krank in Arbeitstagen, Anfangsbestände bis Stichtag, Quoten und Zuschlag', async () => {
    const r = await absenceStats(sql, 2025, '2026-10-11');
    expect(r.partial).toBe(false);
    const ra = r.rows.find((x) => x.id === a)!;
    expect(ra.weekdays).toBe(261);
    expect(ra.vacation).toBe(5);
    expect(ra.sick).toBe(5.5);
    expect(ra.child_sick).toBe(0.5);
    expect(ra.sick_cases).toBe(2);
    expect(ra.present).toBe(ra.weekdays - ra.holidays - 10.5);
    const rb = r.rows.find((x) => x.id === b)!;
    expect(rb.from).toBe('2025-07-01');
    expect(rb.vacation).toBe(7);
    expect(rb.sick).toBe(2);

    const vz = r.groups.find((g) => g.label === 'Vollzeit')!;
    expect(r.total.heads).toBe(r.rows.length);
    // Quote und Zuschlag passen zusammen: Zuschlag = Ausfall ÷ anwesend
    const out = r.total.holidays + r.total.vacation + r.total.sick;
    expect(r.total.outage_rate).toBeCloseTo(out / r.total.weekdays, 6);
    expect(r.total.surcharge).toBeCloseTo(out / r.total.present, 6);
    expect(vz.heads).toBeGreaterThanOrEqual(1);
  });

  it('laufendes Jahr nur bis heute, anonyme Namen', async () => {
    const r = await absenceStats(sql, 2025, '2025-03-31');
    expect(r.partial).toBe(true);
    expect(r.to).toBe('2025-03-31');
    expect(r.rows.find((x) => x.id === b)).toBeUndefined();
    expect(r.rows.find((x) => x.id === a)!.sick).toBe(0);
    expect(anonName(0)).toBe('Mitarbeiter/in 001');
    expect(anonName(41)).toBe('Mitarbeiter/in 042');
  });
});
