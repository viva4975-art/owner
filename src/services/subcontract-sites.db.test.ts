import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { syncAutoAllocation } from './cost-centers.js';
import { saveSupplier } from './inventory.js';
import { DEMO } from './seed.js';
import { importLegacyOrders, legacyOrderSites } from './legacy-subcontractors.js';
import {
  allocateSammel,
  addSubcontractSites,
  saveSubcontractSites,
  subcontractSites,
} from './subcontract-sites.js';
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

  it('alter Auftrag mit mehreren Objekten wird eine Sammelbestellung (Betrag je Objekt)', async () => {
    const objekt =
      'Kunde: DEMO\n\t2990101\tGrundschule\tMusterweg\t5\t81369\tMünchen\t300\n\t2990102\tVerwaltung\tAm Platz\t3\t80331\tMünchen\t100';
    const row = {
      id: 'alt-1',
      sub_id: 'nu-alt',
      auftragsnummer: '2026-TST-028',
      objekt,
      kostenstelle: '29901',
      leistungsart: 'Glasreinigung',
      auftragstyp: 'jaehrlich1',
      abrechnungsart: 'pro_einsatz',
      netto_betrag: '400',
      status: 'aktiv',
      zeitraum_von: '2026-06-01',
    };
    const idOf = new Map([['nu-alt', nu]]);
    const r = await importLegacyOrders(sql, [row], idOf, 't');
    expect(r.orders).toBe(1);
    expect(r.ordersSammel).toBe(1);
    const [sc2] = await sql<{ id: string; site_id: string }[]>`
      select id, site_id from app.subcontracts where number = '2026-TST-028'`;
    expect(sc2!.site_id).toBe(DEMO.siteSchool);
    const sites = await subcontractSites(sql, sc2!.id);
    expect(sites.map((x) => x.share_cents)).toEqual(['30000', '10000']);
    // Rechnung über 200 € nach Betrag je Objekt: 150 / 50
    const parts = await allocateSammel(sql, sc2!.id, '2026-10', 20000n);
    expect(parts!.map((x) => x.net)).toEqual([15000n, 5000n]);
    // erneuter Import legt nichts doppelt an
    const again = await importLegacyOrders(sql, [row], idOf, 't');
    expect(again.orders).toBe(0);
    expect((await subcontractSites(sql, sc2!.id)).length).toBe(2);
    // Kostenstellen-Liste „2990101 + 2990102“ wird ebenfalls erkannt
    const byNo = new Map([
      ['2990101', DEMO.siteSchool],
      ['2990102', DEMO.siteOffice],
    ]);
    expect(legacyOrderSites('2990101 + 2990102', 'ARGE', byNo).map((x) => x.siteId)).toEqual([
      DEMO.siteSchool,
      DEMO.siteOffice,
    ]);
  });
});
