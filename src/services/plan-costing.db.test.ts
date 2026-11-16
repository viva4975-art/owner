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

  it('Ist-Zeit ohne Einsatz zählt mit (wie Lohnarten)', async () => {
    const extra = randomUUID();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type, weekly_hours, pay_model, hourly_wage_cents)
              values (${extra}, '9884', 'Ohne', 'Plan', '2025-01-01', 'minijob', 2, 'individuell', 1500)`;
    const d = '2026-11-10';
    await sql`insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source, status, created_by)
              values (${randomUUID()}, ${extra}, ${site}, ${d}, (${d}::date + time '06:00') at time zone 'Europe/Berlin',
                      (${d}::date + time '08:00') at time zone 'Europe/Berlin', 0, 'buero', 'freigegeben', 't')`;
    const { employees } = await planCosting(sql, { from: '2026-11', to: '2026-11' });
    const x = employees.find((e) => e.employee_id === extra)!;
    expect(x.minutes).toBe(120);
    expect(x.gross).toBe(3000n);
  });

  it('Objektleitung zählt nicht bei den Objekten; Festgehalt nur als Gehalt (keine Stunden/Zuschläge)', async () => {
    const ol = randomUUID();
    const user = randomUUID();
    const fest = randomUUID();
    const s3 = randomUUID();
    await sql`insert into app.sites (id, customer_id, site_no, name) values (${s3}, ${DEMO.company}, '2990298', 'OL-Objekt')`;
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type, weekly_hours,
                pay_model, monthly_salary_cents, tags)
              values (${ol}, '9885', 'Olga', 'Plan', '2025-01-01', 'vollzeit', 40, 'festgehalt', 300000, ${['Objektleitung']}),
                     (${fest}, '9886', 'Fest', 'Plan', '2025-01-01', 'vollzeit', 40, 'festgehalt', 280000, ${['Vorarbeiter']})`;
    await sql`insert into auth.users (id) values (${user})`;
    await sql`insert into app.profiles (user_id, display_name, role, employee_id) values (${user}, 'Olga Plan', 'objektleitung', ${ol})`;
    await sql`update app.sites set manager_user_id = ${user} where id = ${s3}`;
    // beide mit Sonntags-Nachteinsatz (Zuschläge) am Objekt
    for (const e of [ol, fest])
      await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, break_minutes, valid_from, holiday_work)
                values (${randomUUID()}, ${e}, ${s3}, 7, '22:00', '23:30', 0, '2026-01-01', true)`;
    const { rows, employees } = await planCosting(sql, { from: '2026-11', to: '2026-11' });
    expect(employees.find((e) => e.employee_id === ol)).toBeUndefined();
    const f = employees.find((e) => e.employee_id === fest)!;
    expect(f.gross).toBe(280000n);
    expect(f.minutes).toBe(0);
    expect(rows.find((x) => x.site_id === s3)!.gross).toBe(280000n);
  });

  it('Nachunternehmer: einmalige Bestellung im Monat der Ausführung, höhere eingegangene Rechnung zählt', async () => {
    const s4 = randomUUID();
    const sup = randomUUID();
    await sql`insert into app.sites (id, customer_id, site_no, name) values (${s4}, ${DEMO.company}, '2990297', 'NU-Objekt')`;
    await sql`insert into app.suppliers (id, supplier_no, name, kind) values (${sup}, '79891', 'Plan Sub GmbH', 'nachunternehmer')`;
    await sql`insert into app.subcontracts (id, number, supplier_id, site_id, service_kind, frequency, billing, price_cents,
                valid_from, status, created_by)
              values (${randomUUID()}, 'BE-2026-0991', ${sup}, ${s4}, 'Grundreinigung', 'einmalig', 'pauschale_einsatz', 20000,
                      '2026-11-12', 'erteilt', 't')`;
    const a = await planCosting(sql, { from: '2026-11', to: '2026-11' });
    expect(a.rows.find((x) => x.site_id === s4)!.subcontractor).toBe(20000n);
    const inv = randomUUID();
    await sql`insert into app.incoming_invoices (id, supplier_id, invoice_no, invoice_date, due_date, net_cents, vat_cents,
                gross_cents, category, status, site_id, service_month, created_by)
              values (${inv}, ${sup}, 'R-77', '2026-11-20', '2026-12-04', 25000, 0, 25000, 'nachunternehmer', 'erfasst',
                      ${s4}, '2026-11-01', 't')`;
    await sql`delete from app.cost_allocations where incoming_invoice_id = ${inv}`;
    await sql`insert into app.cost_allocations (id, incoming_invoice_id, site_id, month, net_cents, auto, created_by)
              values (${randomUUID()}, ${inv}, ${s4}, '2026-11-01', 25000, true, 't')`;
    const b = await planCosting(sql, { from: '2026-11', to: '2026-11' });
    expect(b.rows.find((x) => x.site_id === s4)!.subcontractor).toBe(25000n);
    expect(b.details.get(s4)!.nuInvoices!.map((v) => v.invoice_no)).toEqual(['R-77']);
    // Dezember: weder Bestellung noch Rechnung
    const c = await planCosting(sql, { from: '2026-12', to: '2026-12' });
    expect(c.rows.find((x) => x.site_id === s4)).toBeUndefined();
  });

  it('geschriebene Rechnung mit Leistungszeitraum zählt als Erlös (höherer Wert, Pauschale nicht doppelt)', async () => {
    const s5 = randomUUID();
    const inv = randomUUID();
    await sql`insert into app.sites (id, customer_id, site_no, name) values (${s5}, ${DEMO.company}, '2990296', 'Rechnung-Objekt')`;
    await sql`insert into app.legacy_invoices (id, number, issue_date, due_date, customer_id, net_cents, gross_cents, paid)
              values (${inv}, '9900001', '2026-11-20', '2026-12-04', ${DEMO.company}, 80000, 95200, false)`;
    await sql`insert into app.legacy_invoice_lines (id, invoice_id, position, title, quantity_milli, unit_price_cents, net_cents,
                period_start, period_end, site_id)
              values (${randomUUID()}, ${inv}, 1, 'Bauendreinigung', 1000, 80000, 80000, '2026-11-01', '2026-11-30', ${s5})`;
    const a = await planCosting(sql, { from: '2026-11', to: '2026-11' });
    expect(a.rows.find((x) => x.site_id === s5)!.revenue).toBe(80000n);
    expect(a.details.get(s5)!.invoices!.map((v) => v.number)).toEqual(['9900001']);
    // Objekt mit Pauschale 2.000 €: Rechnung über 1.500 € im selben Monat → bleibt 2.000 € (nicht 3.500 €)
    const inv2 = randomUUID();
    await sql`insert into app.legacy_invoices (id, number, issue_date, due_date, customer_id, net_cents, gross_cents, paid)
              values (${inv2}, '9900002', '2026-11-30', '2026-12-14', ${DEMO.company}, 150000, 178500, false)`;
    await sql`insert into app.legacy_invoice_lines (id, invoice_id, position, title, quantity_milli, unit_price_cents, net_cents,
                period_start, period_end, site_id)
              values (${randomUUID()}, ${inv2}, 1, 'Unterhaltsreinigung', 1000, 150000, 150000, '2026-11-01', '2026-11-30', ${site})`;
    const b = await planCosting(sql, { from: '2026-11', to: '2026-11' });
    expect(b.rows.find((x) => x.site_id === site)!.revenue).toBe(200000n);
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
