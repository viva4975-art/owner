import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { runMonthly } from './invoices.js';
import { forecastPriorYear } from './reports.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Runde 27', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Bestellnummer der Leistung: einheitlich → Rechnungskopf, verschieden → je Position', async () => {
    const svcs = await sql<{ id: string }[]>`
      select id from app.site_services where site_id = ${DEMO.siteSchool} and kind = 'monthly_flat' and active
       order by sort_order`;
    expect(svcs.length).toBeGreaterThan(0);
    await sql`update app.site_services set order_reference = 'B-4711' where id in ${sql(svcs.map((s) => s.id))}`;
    const r = await runMonthly(sql, '2026-09', 't', { siteIds: [DEMO.siteSchool] });
    const [inv] = await sql<{ order_reference: string }[]>`
      select order_reference from app.invoices where id = ${r.created[0]!.invoiceId}`;
    expect(inv!.order_reference).toBe('B-4711');
    if (svcs.length > 1) {
      await sql`update app.site_services set order_reference = 'B-0815' where id = ${svcs[1]!.id}`;
      const r2 = await runMonthly(sql, '2026-10', 't', { siteIds: [DEMO.siteSchool] });
      const lines = await sql<{ detail: string | null }[]>`
        select detail from app.invoice_lines where invoice_id = ${r2.created[0]!.invoiceId}`;
      expect(lines.map((l) => l.detail ?? '').join('\n')).toMatch(/Bestellnummer: B-0815/);
    }
  });

  it('Umsatz-Vorschau: nicht monatliche Leistungsarten aus dem Vorjahr', async () => {
    const cust = DEMO.authority;
    await sql`insert into app.legacy_invoices (id, number, issue_date, customer_id, net_cents, gross_cents, paid)
              values ('00000000-0000-4000-8000-00000000a001', 'L-1', '2025-11-20', ${cust}, 50000, 59500, true)`;
    await sql`insert into app.legacy_invoice_lines (id, invoice_id, position, title, quantity_milli, unit_price_cents,
                                                    net_cents, service_type, period_start, period_end)
              values ('00000000-0000-4000-8000-00000000a002', '00000000-0000-4000-8000-00000000a001', 1, 'Glas', 1000,
                      50000, 50000, 'Glasreinigung mit Rahmen', '2025-11-10', '2025-11-10')`;
    const months = ['2026-10', '2026-11', '2026-12'];
    const p = await forecastPriorYear(sql, months, null);
    expect(p.chosen).toContain('Glasreinigung mit Rahmen');
    expect(p.perMonth).toEqual([0n, 50000n, 0n]);
    expect((await forecastPriorYear(sql, months, [])).total).toBe(0n);
  });
});
