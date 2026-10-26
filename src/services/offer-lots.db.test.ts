import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { parseEuro, parseQuantity } from '../domain/money/money.js';
import {
  acceptIntoSite,
  getOffer,
  offerStats,
  offerYearValue,
  renderOfferPdf,
  saveOffer,
  setLotStatus,
  setOfferStatus,
} from './offers.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Angebote: Lose und jährliche Positionen', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  const line = (description: string, price: string, cycle: 'm' | 'j' | 'e', lot: number | null) => ({
    description,
    quantity: parseQuantity('1'),
    unitCode: 'LS',
    unitPrice: parseEuro(price),
    vatRate: 1900,
    recurring: cycle === 'm',
    yearly: cycle === 'j',
    alternative: false,
    lot,
  });
  const offer = randomUUID();

  it('Jahreswert, Lose einzeln vergeben, Übernahme nur mit Zuschlag', async () => {
    await saveOffer(
      sql,
      offer,
      {
        customerId: DEMO.authority,
        siteId: null,
        title: 'Ausschreibung Schulen',
        tenderReference: 'V-1',
        tenderPlatform: null,
        submissionDeadline: null,
        offerDate: '2026-10-20',
        validUntil: null,
        introText: null,
        closingText: null,
        lines: [
          line('Unterhaltsreinigung Schule A', '1.000,00', 'm', 1),
          line('Grundreinigung Schule A', '2.000,00', 'j', 1),
          line('Unterhaltsreinigung Schule B', '500,00', 'm', 2),
        ],
        lotTitles: { 1: 'Schule A', 2: 'Schule B' },
      },
      'anna',
    );
    const d = (await getOffer(sql, offer))!;
    expect(d.lots.map((l) => [l.lot_no, l.title, l.status])).toEqual([
      [1, 'Schule A', 'offen'],
      [2, 'Schule B', 'offen'],
    ]);
    expect(d.lines[1]!.yearly).toBe(true);
    // 1.000 × 12 + 2.000 + 500 × 12
    expect(offerYearValue(d.lines)).toBe(2000000n);
    await expect(setLotStatus(sql, offer, 1, 'angenommen', 'anna')).rejects.toThrow(/versendet/);
    await setOfferStatus(sql, offer, 'versendet', 'anna');
    await setLotStatus(sql, offer, 1, 'angenommen', 'anna');
    expect((await getOffer(sql, offer))!.offer.status).toBe('versendet');
    await setLotStatus(sql, offer, 2, 'abgelehnt', 'anna');
    expect((await getOffer(sql, offer))!.offer.status).toBe('angenommen');

    const s = await offerStats(sql, { from: '2026-01-01', to: '2026-12-31' });
    expect(s.accepted.count).toBe(1);
    expect(s.rejected.count).toBe(1);
    expect(s.accepted.year).toBe(1400000n);
    expect(s.rejected.year).toBe(600000n);

    const n = await acceptIntoSite(sql, offer, DEMO.siteSchool, '2026-11-01', 'anna');
    expect(n).toBe(2);
    const svc = await sql<{ description: string; billing_cycle: string }[]>`
      select description, billing_cycle::text as billing_cycle from app.site_services
      where site_id = ${DEMO.siteSchool} and description like '%Schule %' order by description`;
    expect(svc).toEqual([
      { description: 'Grundreinigung Schule A', billing_cycle: 'jaehrlich' },
      { description: 'Unterhaltsreinigung Schule A', billing_cycle: 'monatlich' },
    ]);
    // gewonnenes Los nach Übernahme nicht mehr umstellbar
    await expect(setLotStatus(sql, offer, 1, 'abgelehnt', 'anna')).rejects.toThrow();
    const pdf = await renderOfferPdf(sql, offer);
    expect(pdf.pdf.byteLength).toBeGreaterThan(1000);
  });
});
