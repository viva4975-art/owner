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
  const gf = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.sites (id, customer_id, site_no, name) values (${site}, ${DEMO.company}, '2990299', 'Plan-Objekt')`;
    // laufende Leistung 2.000 € im Monat; Glas quartalsweise nach Ausführung zählt im Plan nicht
    await sql`insert into app.site_services (id, site_id, kind, description, unit_code, quantity_milli,
                unit_price_cents, vat_rate_bp, valid_from, billing_cycle)
              values (${randomUUID()}, ${site}, 'monthly_flat', 'Unterhaltsreinigung', 'LS', 1000, 200000, 1900, '2026-01-01', 'monatlich'),
                     (${randomUUID()}, ${site}, 'special', 'Glas', 'LS', 1000, 60000, 1900, '2026-01-01', 'quartalsweise')`;
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type, weekly_hours,
                pay_model, hourly_wage_cents)
              values (${mini}, '9881', 'Mini', 'Plan', '2025-01-01', 'minijob', 2, 'individuell', 1500),
                     (${regular}, '9882', 'Voll', 'Plan', '2025-01-01', 'vollzeit', 40, 'individuell', 1500)`;
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type, weekly_hours,
                pay_model, monthly_salary_cents, tags)
              values (${gf}, '9883', 'Chef', 'Plan', '2025-01-01', 'vollzeit', 40, 'festgehalt', 500000,
                      ${['Vollzeit', 'Geschäftsführer']})`;
    await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, break_minutes, valid_from)
              values (${randomUUID()}, ${gf}, ${site}, 3, '09:00', '11:00', 0, '2026-01-01')`;
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
    expect(r.revenue).toBe(200000n);
    // Material pauschal 2 % vom Erlös (Ahmed 27.10.)
    expect(r.material).toBe(4000n);
    const m = employees.find((e) => e.employee_id === mini)!;
    // 600 Min. × 15 € = 150,00 € (kein Zuschlag Urlaub/Krankheit) → Minijob 31,17 % + Unfall 2,5 % = 50,51 €
    expect(m.gross).toBe(15000n);
    expect(m.employer).toBe(5051n);
    expect(m.bands).toEqual(['minijob']);
    const v = employees.find((e) => e.employee_id === regular)!;
    // November 2026: 21 Arbeitstage × 8 Std. = 168 Std. (1. Nov. ist Sonntag) × 15 € = 2.520,00 € → regulär 25,85 %
    expect(v.minutes).toBe(21 * 480);
    expect(v.gross).toBe(252000n);
    expect(v.bands).toEqual(['regulaer']);
    expect(v.employer).toBe(65142n);
    // Geschäftsführer: Monatsgehalt, keine Arbeitgeberkosten
    const c = employees.find((e) => e.employee_id === gf)!;
    expect(c.gross).toBe(500000n);
    expect(c.employer).toBe(0n);
    expect(c.bands).toEqual(['gf']);
    expect(r.gross).toBe(15000n + 252000n + 500000n);
    expect(r.employer).toBe(5051n + 65142n);
    expect(r.margin).toBe(200000n - r.gross - r.employer - r.subcontractor - r.material);
  });

  it('inaktiver Kunde setzt Objekte und Leistungen inaktiv', async () => {
    const cust = randomUUID();
    const s2 = randomUUID();
    await sql`insert into app.customers (id, customer_no, name, street, postal_code, city)
              values (${cust}, '29871', 'Inaktiv GmbH', 'Weg 1', '80331', 'München')`;
    await sql`insert into app.sites (id, customer_id, site_no, name) values (${s2}, ${cust}, '2987101', 'Inaktiv-Objekt')`;
    await sql`insert into app.site_services (id, site_id, kind, description, unit_code, quantity_milli,
                unit_price_cents, vat_rate_bp, valid_from, billing_cycle)
              values (${randomUUID()}, ${s2}, 'monthly_flat', 'Unterhaltsreinigung', 'LS', 1000, 1000, 1900, '2026-01-01', 'monatlich')`;
    await sql`update app.customers set active = false where id = ${cust}`;
    const [x] = await sql<{ s: boolean; n: number }[]>`
      select s.active as s, (select count(*)::int from app.site_services where site_id = s.id and active) as n
        from app.sites s where s.id = ${s2}`;
    expect(x).toEqual({ s: false, n: 0 });
  });
});
