import { describe, expect, it } from 'vitest';
import { skontoTerms } from '../invoice/calc.js';
import { LINES, sampleCancellation, sampleDocument } from '../../einvoice/fixtures.js';
import { generateCii, generateXRechnungUbl, generateZugferd } from '../../einvoice/generate.js';
import { renderInvoicePdf } from '../../pdf/invoice-pdf.js';
import { checkTotals, decimalToCents, parseSkonto, readEInvoice } from './incoming.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('Eingehende E-Rechnung lesen', () => {
  it('Beträge cent-genau, kaufmännisch gerundet', () => {
    expect(decimalToCents('6454.2')).toBe(645420n);
    expect(decimalToCents('-0.125')).toBe(-13n);
    expect(decimalToCents('19')).toBe(1900n);
    expect(decimalToCents('6.5', 3)).toBe(6500n);
    expect(() => decimalToCents('1,5')).toThrow();
  });

  it('Skonto maschinenlesbar und als Freitext', () => {
    expect(parseSkonto('#SKONTO#TAGE=7#PROZENT=3.00#\n')).toEqual({ days: 7, percentBp: 300 });
    expect(parseSkonto('Zahlbar innerhalb 10 Tagen mit 2 % Skonto')).toEqual({ days: 10, percentBp: 200 });
    expect(parseSkonto('Zahlbar ohne Abzug bis 31.10.2026')).toBeNull();
    expect(parseSkonto('2 % Skonto bei Zahlung innerhalb 10 Tage')).toEqual({ days: 10, percentBp: 200 });
    expect(parseSkonto('innerhalb 14 Tage abzüglich 2,5 % Skonto')).toEqual({ days: 14, percentBp: 250 });
  });

  for (const [name, gen] of [
    ['XRechnung UBL', generateXRechnungUbl],
    ['CII', generateCii],
  ] as const) {
    it(`${name}: Kopf, Verkäufer, Bank, Summen, Positionen`, async () => {
      const d = sampleDocument();
      const e = await readEInvoice(enc(await gen(d)));
      expect(e.invoiceNo).toBe('1038301');
      expect(e.issueDate).toBe('2026-10-01');
      expect(e.dueDate).toBe('2026-10-31');
      expect(e.periodStart).toBe('2026-09-01');
      expect(e.periodEnd).toBe('2026-09-30');
      expect(e.seller.name).toBe('Viva-Deluxe Gebäudereinigung GmbH');
      expect(e.seller.vatId).toBe('DE341586171');
      expect(e.seller.taxNumber).toBe('143/190/63154');
      expect(e.seller.postalCode).toBe('81375');
      expect(e.iban).toBe('DE39701900000003297837');
      expect(e.netCents).toBe(d.netTotal);
      expect(e.vatCents).toBe(d.vatTotal);
      expect(e.grossCents).toBe(d.grossTotal);
      expect(e.payableCents).toBe(d.payableTotal);
      expect(e.vat).toHaveLength(1);
      expect(e.vat[0]!.rateBp).toBe(1900);
      expect(e.lines).toHaveLength(3);
      expect(e.lines[2]).toMatchObject({ quantityMilli: 6500n, unitCode: 'HUR', netCents: 19370n });
      expect(e.reverseCharge).toBe(false);
      expect(e.isCorrection).toBe(false);
      expect(checkTotals(e)).toEqual([]);
    });
  }

  it('ZUGFeRD-PDF: eingebettetes XML wird gelesen', async () => {
    const d = {
      ...sampleDocument(),
      skonto: skontoTerms(sampleDocument().payableTotal, 300, 7, '2026-10-01'),
    };
    const pdf = await generateZugferd(d, await renderInvoicePdf(d), '1038301.pdf');
    const e = await readEInvoice(pdf);
    expect(e.fromPdf).toBe(true);
    expect(e.syntax).toBe('CII');
    expect(e.grossCents).toBe(d.grossTotal);
    expect(e.skonto).toEqual({ days: 7, percentBp: 300 });
  });

  it('PDF ohne E-Rechnung → verständliche Meldung', async () => {
    const pdf = await renderInvoicePdf(sampleDocument());
    await expect(readEInvoice(pdf)).rejects.toThrow(/keine eingebettete E-Rechnung/);
  });

  it('Storno (384) mit Verweis aufs Original', async () => {
    const e = await readEInvoice(enc(await generateXRechnungUbl(sampleCancellation())));
    expect(e.typeCode).toBe('384');
    expect(e.isCorrection).toBe(true);
    expect(e.precedingInvoice).toBe('1038301');
    expect(e.grossCents < 0n).toBe(true);
  });

  it('§ 13b (Kategorie AE) wird erkannt', async () => {
    const base = sampleDocument();
    const d = sampleDocument(
      { buyer: { ...base.buyer, vatId: 'DE123456789', leitwegId: null }, buyerReference: null },
      LINES.map((l) => ({ ...l, vatRate: 0 as typeof l.vatRate })),
    );
    for (const gen of [generateCii, generateXRechnungUbl]) {
      const e = await readEInvoice(enc(await gen(d)));
      expect(e.reverseCharge).toBe(true);
      expect(e.vatCents).toBe(0n);
      expect(e.buyerVatId).toBe('DE123456789');
    }
  });

  it('DOCTYPE/Entitäten werden abgelehnt (XXE)', async () => {
    const xml =
      '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><Invoice>&a;</Invoice>';
    await expect(readEInvoice(enc(xml))).rejects.toThrow(/DTD/);
    await expect(readEInvoice(enc('<foo/>'))).rejects.toThrow(/Keine E-Rechnung/);
  });
});
