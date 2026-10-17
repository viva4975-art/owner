import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import {
  applyMwServices,
  ensureMwServices,
  ensureMwServicesFor,
  ensureMwTgObjects,
  mwWorkReportLines,
  previewMwServices,
} from './garage-mw.js';
import { uuidOf } from './fortytools-export-import.js';
import { saveService, serviceInput } from './masterdata.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();
const prices = { scheuer1: 47n, scheuer2: 26n, kehr3: 32n, duplex1: 527n, duplex2: 211n, grube: 53n };

describe.skipIf(!available)('Leistungen Münchner Wohnen (Tiefgarage)', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('legt 3 Flächen- und 2 Duplex-Leistungen an, nichts doppelt, Fläche aus Fortytools-Leistung', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await sql`insert into app.tg_objects (id, customer, name, sqm, spaces_duplex, site_id)
              values (${a}, 'Münchner Wohnen GmbH', 'TG Am Hart 1', 2400, 17, ${DEMO.siteSchool}),
                     (${b}, 'Münchner Wohnen GmbH', 'TG Ohne Fläche', null, null, ${DEMO.siteOffice})`;
    // b: Fläche steckt nur in einer übernommenen Leistung
    await saveService(
      sql,
      randomUUID(),
      DEMO.siteOffice,
      serviceInput.parse({
        description: '1. Scheuersaugen - Tiefgaragenreinigung',
        unit_code: 'MTK',
        quantity: '1000',
        unit_price: '0,47',
        valid_from: '2026-01-01',
        billing_cycle: 'je_ausfuehrung',
        version: '',
      }),
      'test',
    );
    const pre = await previewMwServices(sql);
    expect(pre.find((r) => r.objectId === b)).toMatchObject({ sqm: 1000, fromServices: true });

    const r = await applyMwServices(sql, { prices, validFrom: '2026-10-01', update: false }, 't');
    expect(r.created).toBe(5 + 2); // a: alle fünf, b: nur 2. Scheuersaugen + Kehrsaugen
    const svA = await sql<{ description: string; quantity_milli: bigint; unit_price_cents: bigint }[]>`
      select description, quantity_milli, unit_price_cents from app.site_services
       where site_id = ${DEMO.siteSchool} and description like '%Tiefgaragenreinigung' order by description`;
    expect(svA.map((s) => s.description)).toEqual([
      '1. Reinigung Duplex - Tiefgaragenreinigung',
      '1. Scheuersaugen - Tiefgaragenreinigung',
      '2. Reinigung Duplex - Tiefgaragenreinigung',
      '2. Scheuersaugen - Tiefgaragenreinigung',
      '3. Kehrsaugen - Tiefgaragenreinigung',
    ]);
    // 2.400 m² × 0,47 € = 1.128,00 €, 17 × 5,27 € = 89,59 € wie in Fortytools
    const s1 = svA.find((s) => s.description.startsWith('1. Scheuer'))!;
    expect((s1.quantity_milli * s1.unit_price_cents) / 1000n).toBe(112800n);
    const d1 = svA.find((s) => s.description.startsWith('1. Reinigung'))!;
    expect((d1.quantity_milli * d1.unit_price_cents) / 1000n).toBe(8959n);
    const [ob] = await sql<{ sqm: number }[]>`select sqm from app.tg_objects where id = ${b}`;
    expect(ob!.sqm).toBe(1000);

    const again = await applyMwServices(sql, { prices, validFrom: '2026-10-01', update: false }, 't');
    expect(again.created).toBe(0);
    expect(await ensureMwServices(sql)).toBeNull(); // schon gelaufen → nichts mehr

    const lines = await mwWorkReportLines(sql, a, DEMO.siteSchool, 2400, 17);
    expect(lines).toHaveLength(5);
    expect(lines.every((l) => l.serviceId)).toBe(true);

    // Grube: Fläche am TG-Objekt nachgetragen → Leistung wird für dieses Objekt angelegt (306 m² = 162,18 €)
    await sql`update app.tg_objects set pit_sqm = 306 where id = ${a}`;
    expect((await ensureMwServicesFor(sql, a, 't')).created).toBe(1);
    const [g] = await sql<{ quantity_milli: bigint; unit_price_cents: bigint }[]>`
      select quantity_milli, unit_price_cents from app.site_services
       where site_id = ${DEMO.siteSchool} and description like 'Mechanische Reinigung der Grube%'`;
    expect((g!.quantity_milli * g!.unit_price_cents) / 1000n).toBe(16218n);
    expect((await ensureMwServicesFor(sql, a, 't')).created).toBe(0);
    expect(await mwWorkReportLines(sql, a, DEMO.siteSchool, 2400, 17, 306)).toHaveLength(6);
  });

  it('nur Grube nachlegen, Lohnkostenanteil 85 %', async () => {
    const a = randomUUID();
    await sql`insert into app.tg_objects (id, customer, name, sqm, pit_sqm, site_id)
              values (${a}, 'Münchner Wohnen GmbH', 'TG Grube', 500, 120, ${DEMO.siteOffice})`;
    await applyMwServices(sql, { prices, validFrom: '2026-01-01', update: false, keys: ['grube'] }, 't');
    const svc = await sql<{ description: string; labor_share_bp: number | null }[]>`
      select description, labor_share_bp from app.site_services
       where id in ${sql(['scheuer1', 'grube'].map((k) => uuidOf(`tg-mw:${a}:${k}`)))}`;
    expect(svc).toEqual([
      { description: 'Mechanische Reinigung der Grube - Tiefgaragenreinigung', labor_share_bp: 8500 },
    ]);
  });

  it('TG-Objekt ohne Eintrag: wird angelegt, Fläche aus den übernommenen Rechnungen', async () => {
    const cust = randomUUID();
    const site = randomUUID();
    const inv = randomUUID();
    await sql`insert into app.customers (id, customer_no, name, street, postal_code, city)
              values (${cust}, '29917', 'Münchner Wohnen GmbH', 'Gustav-Heinemann-Ring 111', '81739', 'München')`;
    await sql`insert into app.sites (id, customer_id, site_no, name, street, postal_code, city)
              values (${site}, ${cust}, '2991703', 'TG 3 - Sendling-Westpark', 'Esswurmstr. 27', '81371', 'München')`;
    await sql`insert into app.legacy_invoices (id, number, issue_date, net_cents, gross_cents, paid, customer_id)
              values (${inv}, '9990001', '2026-06-30', 0, 0, true, ${cust})`;
    const lines: [string, number, number][] = [
      ['1. Scheuersaugen - Tiefgaragenreinigung', 2400, 47],
      ['1. Reinigung Duplex - Tiefgaragenreinigung', 17, 527],
      ['Mechanische Reinigung der Grube - Tiefgaragenreinigung', 306, 53],
    ];
    for (const [i, [title, q, p]] of lines.entries())
      await sql`insert into app.legacy_invoice_lines (id, invoice_id, position, title, quantity_milli, unit_price_cents, net_cents, site_id)
                values (${randomUUID()}, ${inv}, ${i + 1}, ${title}, ${q * 1000}, ${p}, ${q * p}, ${site})`;
    expect(await ensureMwTgObjects(sql)).toBe(1);
    expect(await ensureMwTgObjects(sql)).toBe(0);
    const [o] = await sql<{ id: string }[]>`select id from app.tg_objects where site_id = ${site}`;
    const r = await applyMwServices(
      sql,
      { prices, validFrom: '2026-01-01', update: false, objectId: o!.id },
      't',
    );
    expect(r.created).toBe(6);
    const [t] = await sql<{ sqm: number; spaces_duplex: number; pit_sqm: number }[]>`
      select sqm, spaces_duplex, pit_sqm from app.tg_objects where id = ${o!.id}`;
    expect(t).toEqual({ sqm: 2400, spaces_duplex: 17, pit_sqm: 306 });
  });
});
