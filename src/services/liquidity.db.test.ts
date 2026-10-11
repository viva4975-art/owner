import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { liquidityForecast } from './liquidity.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Liquiditätsvorschau', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('8 Wochen ab Montag, Stand fortlaufend, Eingangsrechnung mindert den Stand in ihrer Woche', async () => {
    const base = await liquidityForecast(sql, '2026-10-14');
    expect(base.weeks).toHaveLength(8);
    expect(base.weeks[0]!.from).toBe('2026-10-12');
    expect(base.weeks[0]!.kw).toBe(42);
    const [sup] = await sql<{ id: string }[]>`select id from app.suppliers limit 1`;
    if (!sup) return;
    await sql`insert into app.incoming_invoices (id, supplier_id, invoice_no, invoice_date, due_date, net_cents, vat_cents,
                gross_cents, category, status, created_by)
              values (${randomUUID()}, ${sup.id}, 'LIQ-1', '2026-10-01', '2026-10-28', 100000, 19000, 119000,
                      'sonstiges', 'erfasst', 't')`;
    const f = await liquidityForecast(sql, '2026-10-14');
    const w = f.weeks.findIndex((x) => x.from <= '2026-10-28' && x.to >= '2026-10-28');
    expect(f.weeks[w]!.outflow - base.weeks[w]!.outflow).toBe(119000n);
    expect(f.weeks[7]!.balance - base.weeks[7]!.balance).toBe(-119000n);
  });
});
