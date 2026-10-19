import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { syncAutoAllocation } from './cost-centers.js';
import { saveSupplier } from './inventory.js';
import { DEMO } from './seed.js';
import { addSubcontractSites, saveSubcontractSites, subcontractSites } from './subcontract-sites.js';
import { saveSubcontract, subcontractPdf } from './subcontractors.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Sammelbestellung Nachunternehmer', () => {
  let sql: Sql;
  const nu = randomUUID();
  const sc = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await saveSupplier(
      sql,
      nu,
      {
        supplier_no: '70300',
        name: 'TG Partner GmbH',
        kind: 'nachunternehmer',
        payment_terms_days: '30',
        active: 'on',
      },
      null,
      't',
    );
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('alle Objekte eines Kunden, Preis je m², Rechnung nach Fläche verteilt', async () => {
    await saveSubcontract(
      sql,
      sc,
      {
        supplierId: nu,
        siteId: DEMO.siteSchool,
        serviceKind: 'Tiefgaragenreinigung',
        frequency: 'monatlich',
        billing: 'qm',
        priceCents: 30n,
        maxHours: null,
        validFrom: '2026-10-01',
        validTo: null,
        description: null,
        note: null,
      },
      't',
    );
    const n = await addSubcontractSites(sql, sc, { customerId: DEMO.authority }, 't');
    expect(n).toBeGreaterThanOrEqual(2);
    const sites = await subcontractSites(sql, sc);
    await saveSubcontractSites(
      sql,
      sc,
      sites.map((s, i) => ({
        siteId: s.site_id,
        sqm: i === 0 ? '300' : i === 1 ? '100' : '',
        remove: i > 1,
      })),
      't',
    );
    const two = await subcontractSites(sql, sc);
    expect(two.map((s) => s.sqm)).toEqual(['300.00', '100.00']);
    // Rechnung über 120,00 € → 90,00 / 30,00 nach Fläche
    const inv = randomUUID();
    await sql`insert into app.incoming_invoices (id, supplier_id, invoice_no, invoice_date, due_date, net_cents, vat_cents,
                gross_cents, category, created_by, subcontract_id, site_id, service_month)
              values (${inv}, ${nu}, 'R-1', '2026-10-31', '2026-11-30', 12000, 0, 12000, 'nachunternehmer', 't', ${sc},
                      ${DEMO.siteSchool}, '2026-10-01')`;
    await sql.begin((tx) => syncAutoAllocation(tx, inv, 't'));
    const alloc = await sql<{ site_id: string; net_cents: bigint }[]>`
      select site_id, net_cents from app.cost_allocations where incoming_invoice_id = ${inv} order by net_cents desc`;
    expect(alloc.map((a) => [a.site_id, BigInt(a.net_cents)])).toEqual([
      [two[0]!.site_id, 9000n],
      [two[1]!.site_id, 3000n],
    ]);
    const pdf = await subcontractPdf(sql, sc);
    expect(pdf.byteLength).toBeGreaterThan(1000);
  });

  it('Anteil am Umsatz braucht eine Marge', async () => {
    await expect(
      saveSubcontract(
        sql,
        randomUUID(),
        {
          supplierId: nu,
          siteId: DEMO.siteSchool,
          serviceKind: 'Unterhaltsreinigung',
          frequency: 'monatlich',
          billing: 'umsatz',
          priceCents: 0n,
          maxHours: null,
          validFrom: '2026-10-01',
          validTo: null,
          description: null,
          note: null,
        },
        't',
      ),
    ).rejects.toThrow(/Marge/);
  });
});
