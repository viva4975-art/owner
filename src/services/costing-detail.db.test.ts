import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { siteCosting } from './costing.js';
import { costCenterBreakdown, siteCostBreakdown } from './costing-detail.js';
import { planCosting } from './plan-costing.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Nachkalkulation aufschlüsseln', () => {
  let sql: Sql;
  const site = randomUUID();
  const emp = randomUUID();
  const chef = randomUUID();
  let cc = '';
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.sites (id, customer_id, site_no, name) values (${site}, ${DEMO.company}, '2990399', 'Detail-Objekt')`;
    await sql`insert into app.site_services (id, site_id, kind, description, unit_code, quantity_milli,
                unit_price_cents, vat_rate_bp, valid_from, billing_cycle)
              values (${randomUUID()}, ${site}, 'monthly_flat', 'Unterhaltsreinigung', 'LS', 1000, 100000, 1900, '2026-01-01', 'monatlich')`;
    await sql`update app.company set managing_director = 'Ahmed Chomontek'`;
    // Geschäftsführer ohne Tag, nur über die Firmendaten erkannt
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type, weekly_hours,
                pay_model, hourly_wage_cents)
              values (${emp}, '9891', 'Kraft', 'Detail', '2025-01-01', 'teilzeit', 20, 'individuell', 1500),
                     (${chef}, '9892', 'Ahmed', 'Chomontek', '2025-01-01', 'vollzeit', 40, 'individuell', 3000)`;
    for (const [e, d] of [
      [emp, '2026-09-07'],
      [chef, '2026-09-08'],
    ] as const)
      await sql`insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source, status, created_by)
                values (${randomUUID()}, ${e}, ${site}, ${d}, (${d}::date + time '06:00') at time zone 'Europe/Berlin',
                        (${d}::date + time '10:00') at time zone 'Europe/Berlin', 0, 'buero', 'freigegeben', 't')`;
    for (const [e, wd] of [
      [emp, 1],
      [chef, 2],
    ] as const)
      await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, break_minutes, valid_from)
                values (${randomUUID()}, ${e}, ${site}, ${wd}, '06:00', '10:00', 0, '2026-01-01')`;
    const sup = randomUUID();
    await sql`insert into app.suppliers (id, supplier_no, name, kind) values (${sup}, '79391', 'Büro-Lieferant', 'lieferant')`;
    const inv = randomUUID();
    await sql`insert into app.incoming_invoices (id, supplier_id, invoice_no, invoice_date, due_date, net_cents, vat_cents, gross_cents, category, created_by)
              values (${inv}, ${sup}, 'B-1', '2026-09-15', '2026-10-15', 4200, 798, 4998, 'sonstiges', 't')`;
    cc = (await sql<{ id: string }[]>`select id from app.cost_centers where number = '9000'`)[0]!.id;
    await sql`delete from app.cost_allocations where incoming_invoice_id = ${inv}`;
    await sql`insert into app.cost_allocations (id, incoming_invoice_id, site_id, cost_center_id, month, net_cents, created_by)
              values (${randomUUID()}, ${inv}, null, ${cc}, '2026-09-01', 4200, 't')`;
  }, 60_000);
  afterAll(async () => {
    await sql?.end();
  });

  it('Lohn je Person stimmt mit der Zeile überein, Geschäftsführer ohne Zuschlag', async () => {
    const period = { from: '2026-09', to: '2026-09' };
    const [{ rows }, b] = await Promise.all([
      siteCosting(sql, period, site),
      siteCostBreakdown(sql, site, period),
    ]);
    const r = rows[0]!;
    expect(b.labor.reduce((a, l) => a + l.cost, 0n)).toBe(r.labor);
    const c = b.labor.find((l) => l.employee_id === chef)!;
    expect(c.overhead_bp).toBe(0);
    // Lohn laut Lohnarten (Ist, sonst Plan): 5 Dienstage × 4 Std. × 30 €, kein Zuschlag
    expect(c.cost).toBe(60000n);
    expect(b.labor.find((l) => l.employee_id === emp)!.overhead_bp).toBeGreaterThan(0);
  });

  it('Kostenstelle Büro zeigt die einzelne Eingangsrechnung', async () => {
    const b = await costCenterBreakdown(sql, cc, { from: '2026-09', to: '2026-09' });
    const it = b.other.find((x) => x.label.includes('B-1'))!;
    expect(it.amount).toBe(4200n);
    expect(it.href).toContain('/rechnungseingang/');
  });

  it('Plan: Erlös je Leistung, Lohn je Person, Geschäftsführer ohne AG-Kosten', async () => {
    const plan = await planCosting(sql, { from: '2026-11', to: '2026-11' });
    const r = plan.rows.find((x) => x.site_id === site)!;
    const d = plan.details.get(site)!;
    expect(d.revenue.reduce((a, x) => a + x.amount, 0n)).toBe(r.revenue);
    expect(d.labor.reduce((a, x) => a + x.gross + x.employer, 0n)).toBe(r.labor);
    const c = d.labor.find((l) => l.employee_id === chef)!;
    expect(c.employer).toBe(0n);
    expect(c.bands).toEqual(['gf']);
  });
});
