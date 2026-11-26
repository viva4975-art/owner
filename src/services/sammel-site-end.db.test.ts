import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { saveSupplier } from './inventory.js';
import { DEMO } from './seed.js';
import { endSammelSite, revokeSammelSiteEnd } from './subcontract-cancel.js';
import {
  addSubcontractSites,
  allocateSammel,
  applyShare,
  sammelMonthCost,
  saveSubcontractSites,
  siteMonthShare,
} from './subcontract-sites.js';
import { saveSubcontract, setSubcontractStatus } from './subcontractors.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe('Anteil gekündigter Objekte je Monat', () => {
  it('Monat des Endes nach Kalendertagen, danach 0', () => {
    expect(siteMonthShare(null, '2026-11')).toEqual([1n, 1n]);
    expect(siteMonthShare('2026-11-15', '2026-11')).toEqual([15n, 30n]);
    expect(siteMonthShare('2026-11-30', '2026-11')).toEqual([1n, 1n]);
    expect(siteMonthShare('2026-11-15', '2026-12')).toEqual([0n, 1n]);
    expect(siteMonthShare('2026-11-15', '2026-11', false)).toEqual([1n, 1n]);
    expect(applyShare(100001n, [15n, 30n])).toBe(50001n); // 50000,5 → kaufmännisch aufgerundet
  });
});

describe.skipIf(!available)('Sammelbestellung: einzelnes Objekt kündigen', () => {
  let sql: Sql;
  let files: { sql: Sql; filesDir: string; maxBytes: number };
  const nu = randomUUID();
  const sc = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    files = { sql, filesDir: await mkdtemp(join(tmpdir(), 'viva-files-')), maxBytes: 50_000_000 };
    await saveSupplier(
      sql,
      nu,
      {
        supplier_no: '70310',
        name: 'Sammel Sub GmbH',
        kind: 'nachunternehmer',
        payment_terms_days: '14',
        active: 'on',
      },
      null,
      't',
    );
    await saveSubcontract(
      sql,
      sc,
      {
        supplierId: nu,
        siteId: DEMO.siteSchool,
        serviceKind: 'Unterhaltsreinigung',
        frequency: 'monatlich',
        billing: 'pauschale_monat',
        priceCents: 300000n,
        maxHours: null,
        validFrom: '2026-10-01',
        validTo: null,
        description: null,
        note: null,
      },
      't',
    );
    await addSubcontractSites(sql, sc, { siteIds: [DEMO.siteOffice, DEMO.siteHq] }, 't');
    // Pauschale je Objekt: 1.000 / 1.200 / 800 €
    const amounts: Record<string, bigint> = {
      [DEMO.siteSchool]: 100000n,
      [DEMO.siteOffice]: 120000n,
      [DEMO.siteHq]: 80000n,
    };
    await saveSubcontractSites(
      sql,
      sc,
      Object.entries(amounts).map(([siteId, share]) => ({
        siteId,
        sqm: '',
        share,
        mode: 'pauschale',
        remove: false,
      })),
      't',
    );
    await setSubcontractStatus(sql, sc, 'erteilt', 't', { acceptMissing: true });
  });
  afterAll(async () => {
    await sql?.end();
  });

  const cost = async (m: string) =>
    new Map(
      (
        await sammelMonthCost(
          sql,
          { id: sc, billing: 'pauschale_monat', price_cents: 300000n, margin_bp: null },
          m,
        )
      ).map((x) => [x.site_id, x.cost]),
    );

  it('Objekt zum 15.11. gekündigt: November anteilig, Dezember entfällt, Schreiben abgelegt', async () => {
    const file = await endSammelSite(
      files,
      sc,
      {
        siteId: DEMO.siteOffice,
        date: '2026-11-15',
        reason: 'Kunde hat gekündigt',
        letter: true,
        reasonInLetter: true,
      },
      't',
    );
    expect(file).toBeTruthy();
    const nov = await cost('2026-11');
    expect(nov.get(DEMO.siteOffice)).toBe(60000n); // 1.200 € × 15/30
    expect(nov.get(DEMO.siteSchool)).toBe(100000n);
    const dec = await cost('2026-12');
    expect(dec.get(DEMO.siteOffice)).toBe(0n);
    expect([...dec.values()].reduce((a, b) => a + b, 0n)).toBe(180000n);
    // Rechnung im Dezember wird nur auf die laufenden Objekte verteilt
    const split = await allocateSammel(sql, sc, '2026-12', 180000n);
    expect(split?.find((x) => x.site_id === DEMO.siteOffice)?.net).toBe(0n);
    await expect(
      endSammelSite(
        files,
        sc,
        { siteId: DEMO.siteOffice, date: '2026-11-20', reason: null, letter: false, reasonInLetter: false },
        't',
      ),
    ).rejects.toThrow(/schon/);
  });

  it('letztes laufendes Objekt nicht einzeln kündbar, Zurücknehmen stellt wieder her', async () => {
    await endSammelSite(
      files,
      sc,
      { siteId: DEMO.siteHq, date: '2026-12-31', reason: null, letter: false, reasonInLetter: false },
      't',
    );
    await expect(
      endSammelSite(
        files,
        sc,
        { siteId: DEMO.siteSchool, date: '2026-12-31', reason: null, letter: false, reasonInLetter: false },
        't',
      ),
    ).rejects.toThrow(/letzte/);
    await revokeSammelSiteEnd(sql, sc, DEMO.siteOffice, 't');
    expect((await cost('2026-12')).get(DEMO.siteOffice)).toBe(120000n);
  });
});
