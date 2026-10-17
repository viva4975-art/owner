import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { applyMwServices, ensureMwServices, mwWorkReportLines, previewMwServices } from './garage-mw.js';
import { saveService, serviceInput } from './masterdata.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();
const prices = { scheuer1: 47n, scheuer2: 26n, kehr3: 32n, duplex1: 527n, duplex2: 211n };

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
  });
});
