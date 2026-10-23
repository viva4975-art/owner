import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { planCosting } from './plan-costing.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Plan-Kalkulation (Soll)', () => {
  let sql: Sql;
  const site = randomUUID();
  const mini = randomUUID();
  const regular = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.sites (id, customer_id, site_no, name) values (${site}, ${DEMO.company}, '2990299', 'Plan-Objekt')`;
    // laufende Leistung 2.000 € im Monat, dazu quartalsweise 600 € (anteilig 200 € je Monat)
    await sql`insert into app.site_services (id, site_id, kind, description, unit_code, quantity_milli,
                unit_price_cents, vat_rate_bp, valid_from, billing_cycle)
              values (${randomUUID()}, ${site}, 'monthly_flat', 'Unterhaltsreinigung', 'LS', 1000, 200000, 1900, '2026-01-01', 'monatlich'),
                     (${randomUUID()}, ${site}, 'special', 'Glas', 'LS', 1000, 60000, 1900, '2026-01-01', 'quartalsweise')`;
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type, weekly_hours,
                pay_model, hourly_wage_cents)
              values (${mini}, '9881', 'Mini', 'Plan', '2025-01-01', 'minijob', 2, 'individuell', 1500),
                     (${regular}, '9882', 'Voll', 'Plan', '2025-01-01', 'vollzeit', 40, 'individuell', 1500)`;
    // Minijob montags 2 Std. (November 2026: 5 Montage = 10 Std.), Vollzeit Mo–Fr 8 Std.
    await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, break_minutes, valid_from)
              values (${randomUUID()}, ${mini}, ${site}, 1, '06:00', '08:00', 0, '2026-01-01')`;
    for (const wd of [1, 2, 3, 4, 5])
      await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, break_minutes, valid_from)
                values (${randomUUID()}, ${regular}, ${site}, ${wd}, '08:00', '16:30', 30, '2026-01-01')`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Erlös aus laufenden Leistungen, Lohn aus Einsätzen, AG-Kosten nach Lohnhöhe', async () => {
    const { rows, employees } = await planCosting(sql, { from: '2026-11', to: '2026-11' });
    const r = rows.find((x) => x.site_id === site)!;
    expect(r.revenue).toBe(220000n);
    const m = employees.find((e) => e.employee_id === mini)!;
    // 600 Min. × 15 € × 1,13 = 169,50 € → Minijob 31,17 % + Unfall 2,5 % = 57,07 €
    expect(m.gross).toBe(16950n);
    expect(m.employer).toBe(5707n);
    expect(m.bands).toEqual(['minijob']);
    const v = employees.find((e) => e.employee_id === regular)!;
    // November 2026: 21 Arbeitstage × 8 Std. = 168 Std. (1. Nov. ist Sonntag) × 15 € × 1,13 = 2.847,60 € → regulär 25,85 %
    expect(v.minutes).toBe(21 * 480);
    expect(v.gross).toBe(284760n);
    expect(v.bands).toEqual(['regulaer']);
    expect(v.employer).toBe(73610n);
    expect(r.gross).toBe(16950n + 284760n);
    expect(r.margin).toBe(220000n - r.gross - r.employer - r.subcontractor - r.material);
  });
});
