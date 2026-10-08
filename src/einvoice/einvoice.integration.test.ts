import { describe, expect, it } from 'vitest';
import { renderInvoicePdf } from '../pdf/render.js';
import { LINES, sampleCancellation, sampleDocument, sampleFinal } from './fixtures.js';
import { generateCii, generateXRechnungUbl, generateZugferd } from './generate.js';
import { validateWithKosit } from './kosit.js';
import { PDFDocument } from '@cantoo/pdf-lib';
import { kositAvailable } from '../services/testing.js';
import { skontoTerms } from '../domain/invoice/calc.js';

/**
 * Prüft echte E-Rechnungen gegen den KoSIT-Validator.
 * Läuft nur, wenn KOSIT_VALIDATOR_URL erreichbar ist (docker compose up kosit).
 */
const KOSIT = process.env.KOSIT_VALIDATOR_URL ?? 'http://127.0.0.1:8081';
const available = await kositAvailable();

const withSkonto = (() => {
  const d = sampleDocument();
  return { ...d, skonto: skontoTerms(d.payableTotal, 300, 7, d.issueDate) };
})();

const withDebit = (() => {
  const d = sampleDocument();
  return {
    ...d,
    buyer: {
      ...d.buyer,
      directDebit: {
        mandateRef: 'M-29901-1',
        iban: 'DE02120300000000202051',
        creditorId: 'DE98ZZZ09999999999',
        scheme: 'CORE' as const,
      },
    },
  };
})();

// § 13b: Kunde ist selbst Gebäudereiniger → alle Positionen 0 %, Kategorie AE, USt-IdNr. des Kunden
const reverseCharge = (() => {
  const base = sampleDocument();
  const d = sampleDocument(
    { buyer: { ...base.buyer, vatId: 'DE123456789', leitwegId: null }, buyerReference: null },
    LINES.map((l) => ({ ...l, vatRate: 0 as typeof l.vatRate })),
  );
  return d;
})();

// Firmenkunde ohne Leitweg-ID: Empfänger-Adresse = Rechnungs-E-Mail (BT-49), Käuferreferenz = Kundennummer
const withoutLeitweg = (() => {
  const base = sampleDocument();
  return sampleDocument({ buyer: { ...base.buyer, leitwegId: null }, buyerReference: null });
})();

const cases = [
  ['Rechnung ohne Leitweg-ID (Firmenkunde, E-Mail)', withoutLeitweg],
  ['Rechnung § 13b (Reverse Charge)', reverseCharge],
  ['Rechnung', sampleDocument()],
  ['Rechnung mit SEPA-Lastschrift', withDebit],
  ['Rechnung mit Skonto', withSkonto],
  ['Stornorechnung', sampleCancellation()],
  ['Abschlagsrechnung', sampleDocument({ kind: 'partial', number: '1038303' })],
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

  it('Skonto steht maschinenlesbar in BT-20 (#SKONTO#)', async () => {
    const xml = await generateXRechnungUbl(withSkonto);
    expect(xml).toMatch(/<cbc:Note>#SKONTO#TAGE=7#PROZENT=3\.00#\n?Zahlbar bis zum/);
  });

  it('Lastschrift: Vorabankündigung im Text, Code 59 mit Mandat, Gläubiger-ID und Konto', async () => {
    const xml = await generateXRechnungUbl(withDebit);
    expect(xml).toContain('<cbc:PaymentMeansCode>59</cbc:PaymentMeansCode>');
    expect(xml).toMatch(/<cac:PaymentMandate>\s*<cbc:ID>M-29901-1<\/cbc:ID>/);
    expect(xml).toContain('<cbc:ID schemeID="SEPA">DE98ZZZ09999999999</cbc:ID>');
    expect(xml).toContain('DE02120300000000202051');
    expect(xml).toMatch(/per SEPA-Lastschrift von Ihrem Konto DE02 \*{4} \*{4} \*{4} \*\*20 51 eingezogen/);
    const pdf = await renderInvoicePdf(withDebit);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(0);
  });

  it('§ 13b: AE mit Befreiungsgrund, Hinweis im Text, keine Mischung, USt-IdNr. Pflicht', async () => {
    const xml = await generateXRechnungUbl(reverseCharge);
    expect(xml).toContain('<cbc:TaxExemptionReasonCode>VATEX-EU-AE</cbc:TaxExemptionReasonCode>');
    expect(xml).toContain('Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG)');
    expect(reverseCharge.vatTotal).toBe(0n);
    const mixed = { ...reverseCharge, lines: [...reverseCharge.lines, sampleDocument().lines[0]!] };
    await expect(generateXRechnungUbl(mixed)).rejects.toThrow(/mischen/);
    const noVat = { ...reverseCharge, buyer: { ...reverseCharge.buyer, vatId: null } };
    await expect(generateXRechnungUbl(noVat)).rejects.toThrow(/USt-IdNr/);
  });

  it('Storno referenziert das Original und hat Belegart 384', async () => {
    const xml = await generateXRechnungUbl(sampleCancellation());
    expect(xml).toContain('<cbc:InvoiceTypeCode>384</cbc:InvoiceTypeCode>');
    expect(xml).toMatch(
      /<cac:BillingReference>\s*<cac:InvoiceDocumentReference>\s*<cbc:ID>1038301<\/cbc:ID>/,
    );
    expect(xml).not.toMatch(/Gutschrift/i);
  });
});

describe('ZUGFeRD-PDF', () => {
  it('bettet das XML in eine PDF/A-3 ein', async () => {
    const doc = sampleDocument();
    const pdf = await renderInvoicePdf(doc);
    const zugferd = await generateZugferd(doc, pdf, '1038301.pdf');
    const loaded = await PDFDocument.load(zugferd);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);
    const text = Buffer.from(zugferd).toString('latin1');
    expect(text).toMatch(/pdfaid:part[^0-9]*3/);
    expect(text).toMatch(/factur-x\.xml|xrechnung\.xml/);
  });
});
