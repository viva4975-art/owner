import { randomUUID } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { parseEuro, parseQuantity } from '../domain/money/money.js';
import { getInvoice } from './invoices.js';
import {
  acceptIntoSite,
  copyOffer,
  getOffer,
  offerStats,
  offerToInvoiceDraft,
  recentCustomers,
  renderOfferPdf,
  saveOffer,
  setOfferStatus,
} from './offers.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Angebote: Alternativen, Folgeangebot, Statistik', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  const line = (description: string, price: string, recurring: boolean, alternative = false) => ({
    description,
    quantity: parseQuantity('1'),
    unitCode: 'LS',
    unitPrice: parseEuro(price),
    vatRate: 1900,
    recurring,
    alternative,
  });
  const input = (over: Partial<Parameters<typeof saveOffer>[2]> = {}) => ({
    customerId: DEMO.authority,
    siteId: null,
    title: 'Unterhaltsreinigung Schule',
    tenderReference: null,
    tenderPlatform: null,
    submissionDeadline: null,
    offerDate: '2026-10-01',
    validUntil: null,
    introText: null,
    closingText: null,
    lines: [
      line('Unterhaltsreinigung 5×/Woche', '4.000,00', true),
      line('Unterhaltsreinigung 3×/Woche', '2.600,00', true, true),
      line('Grundreinigung', '1.000,00', false),
      line('Grundreinigung mit Beschichtung', '1.800,00', false, true),
    ],
    ...over,
  });

  const offer = randomUUID();

  it('Alternativpositionen zählen nicht zur Summe', async () => {
    await saveOffer(sql, offer, input(), 'anna');
    const o = (await getOffer(sql, offer))!;
    expect(o.offer.net_cents).toBe(500000n);
    expect(o.offer.vat_cents).toBe(95000n);
    expect(o.offer.monthly_net_cents).toBe(400000n);
    expect(o.lines.map((l) => [l.position, l.alternative, l.net_cents])).toEqual([
      [1, false, 400000n],
      [2, true, 260000n],
      [3, false, 100000n],
      [4, true, 180000n],
    ]);
    await expect(
      saveOffer(sql, randomUUID(), input({ lines: [line('nur Alternative', '10,00', false, true)] }), 'anna'),
    ).rejects.toThrow(/keine Alternative/);
    const pdf = await renderOfferPdf(sql, offer);
    expect((await PDFDocument.load(pdf.pdf)).getPageCount()).toBeGreaterThan(0);
  });

  it('Folgeangebot: verweist aufs Original, nur einmal, Original zurückgezogen beim Versand', async () => {
    await setOfferStatus(sql, offer, 'versendet', 'anna');
    const f1 = await copyOffer(sql, offer, 'anna', { followUp: true });
    const f2 = await copyOffer(sql, offer, 'anna', { followUp: true });
    expect(f2).toBe(f1);
    const f = (await getOffer(sql, f1))!;
    expect(f.offer.predecessor_id).toBe(offer);
    expect(f.lines.filter((l) => l.alternative)).toHaveLength(2);
    expect((await getOffer(sql, offer))!.offer.status).toBe('versendet');
    await setOfferStatus(sql, f1, 'versendet', 'anna');
    expect((await getOffer(sql, offer))!.offer.status).toBe('zurueckgezogen');
    await expect(copyOffer(sql, offer, 'anna', { followUp: true })).resolves.toBe(f1);
  });

  it('Annahme: Alternativen gehen nicht ins Objekt und nicht in die Rechnung', async () => {
    const f1 = (await sql<{ id: string }[]>`select id from app.offers where predecessor_id = ${offer}`)[0]!
      .id;
    await setOfferStatus(sql, f1, 'angenommen', 'anna');
    const n = await acceptIntoSite(sql, f1, DEMO.siteSchool, '2026-11-01', 'anna');
    expect(n).toBe(2);
    const inv = (await getInvoice(sql, await offerToInvoiceDraft(sql, f1, 'anna')))!;
    expect(inv.lines.map((l) => l.description)).toEqual(['Unterhaltsreinigung 5×/Woche', 'Grundreinigung']);
  });

  it('Statistik 12 Monate und zuletzt bearbeitete Kunden', async () => {
    const lost = randomUUID();
    await saveOffer(sql, lost, input({ customerId: DEMO.company }), 'ben');
    await setOfferStatus(sql, lost, 'versendet', 'ben');
    await setOfferStatus(sql, lost, 'abgelehnt', 'ben');
    const s = await offerStats(sql);
    expect(s.accepted.count).toBe(1);
    expect(s.accepted.net).toBe(500000n);
    expect(s.rejected.count).toBe(1);
    expect(s.withdrawn).toBe(1);
    expect(s.rate).toBe(50);
    expect((await recentCustomers(sql, 'ben')).map((c) => c.id)).toEqual([DEMO.company]);
    expect((await recentCustomers(sql, 'anna')).map((c) => c.id)).toEqual([DEMO.authority]);
  });
});
