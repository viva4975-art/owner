import { describe, expect, it } from 'vitest';
import { renderInvoicePdf } from '../pdf/render.js';
import { sampleCancellation, sampleDocument, sampleFinal } from './fixtures.js';
import { generateCii, generateXRechnungUbl, generateZugferd } from './generate.js';
import { validateWithKosit } from './kosit.js';
import { PDFDocument } from '@cantoo/pdf-lib';
import { kositAvailable } from '../services/testing.js';

/**
 * Prüft echte E-Rechnungen gegen den KoSIT-Validator.
 * Läuft nur, wenn KOSIT_VALIDATOR_URL erreichbar ist (docker compose up kosit).
 */
const KOSIT = process.env.KOSIT_VALIDATOR_URL ?? 'http://127.0.0.1:8081';
const available = await kositAvailable();

const cases = [
  ['Rechnung', sampleDocument()],
  ['Stornorechnung', sampleCancellation()],
  ['Abschlagsrechnung', sampleDocument({ kind: 'partial', number: 'RE-2026-00003' })],
  ['Schlussrechnung', sampleFinal()],
] as const;

describe.skipIf(!available)('E-Rechnung gegen KoSIT', () => {
  for (const [name, doc] of cases) {
    it(`${name}: XRechnung UBL ist gültig`, async () => {
      const res = await validateWithKosit(await generateXRechnungUbl(doc), KOSIT);
      expect(res.messages.filter((m) => m.level === 'error')).toEqual([]);
      expect(res.valid).toBe(true);
    });

    it(`${name}: CII (ZUGFeRD-XML) ist gültig`, async () => {
      const res = await validateWithKosit(await generateCii(doc), KOSIT);
      expect(res.messages.filter((m) => m.level === 'error')).toEqual([]);
      expect(res.valid).toBe(true);
    });
  }

  it('erkennt ungültige Rechnungen (kein Versand möglich)', async () => {
    const xml = (await generateXRechnungUbl(sampleDocument())).replace(
      /<cbc:PayableAmount([^>]*)>[^<]*</,
      '<cbc:PayableAmount$1>1.00<',
    );
    const res = await validateWithKosit(xml, KOSIT);
    expect(res.valid).toBe(false);
    expect(res.messages.some((m) => m.level === 'error')).toBe(true);
  });

  it('Storno referenziert das Original und hat Belegart 384', async () => {
    const xml = await generateXRechnungUbl(sampleCancellation());
    expect(xml).toContain('<cbc:InvoiceTypeCode>384</cbc:InvoiceTypeCode>');
    expect(xml).toMatch(
      /<cac:BillingReference>\s*<cac:InvoiceDocumentReference>\s*<cbc:ID>RE-2026-00001<\/cbc:ID>/,
    );
    expect(xml).not.toMatch(/Gutschrift/i);
  });
});

describe('ZUGFeRD-PDF', () => {
  it('bettet das XML in eine PDF/A-3 ein', async () => {
    const doc = sampleDocument();
    const pdf = await renderInvoicePdf(doc);
    const zugferd = await generateZugferd(doc, pdf, 'RE-2026-00001.pdf');
    const loaded = await PDFDocument.load(zugferd);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);
    const text = Buffer.from(zugferd).toString('latin1');
    expect(text).toMatch(/pdfaid:part[^0-9]*3/);
    expect(text).toMatch(/factur-x\.xml|xrechnung\.xml/);
  });
});
