import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { renderCashbookPdf } from './cashbook.js';

describe('Kassenbuch-PDF (A4 quer)', () => {
  it('bricht lange Monate mit Übertrag auf mehrere Seiten um', async () => {
    const fmt = (c: bigint) => `${(Number(c) / 100).toFixed(2)} €`;
    const balances = Array.from({ length: 80 }, (_, i) => BigInt((i + 1) * 1000));
    const bytes = await renderCashbookPdf({
      company: 'Test GmbH',
      companyLine: 'Weg 1, 80331 München',
      title: 'Kassenbuch Oktober 2026',
      period: '01.10.2026 – 31.10.2026',
      cashName: 'Hauptkasse',
      opening: fmt(0n),
      openingNote: 'Übertrag Vormonat',
      income: fmt(80000n),
      expense: fmt(0n),
      closing: fmt(80000n),
      openingCents: 0n,
      fmt,
      balances,
      rows: balances.map((b, i) => ({
        no: i + 1,
        date: '01.10.2026',
        receipt: `Q-${i}`,
        text: `Einlage ${i}`,
        category: '',
        income: fmt(1000n),
        expense: '',
        balance: fmt(b),
        hasFile: i % 2 === 0,
      })),
      closingNotes: [],
      cancelled: [],
      footnote: 'Hinweis',
      created: '09.10.2026',
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(4); // ~22 Zeilen auf Seite 1, ~28 auf Folgeseiten
    const [w, h] = [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()];
    expect(w).toBeGreaterThan(h); // quer
  });
});
