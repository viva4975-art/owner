import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont, type PDFPage, rgb } from '@cantoo/pdf-lib';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pdfFonts } from './render.js';

/*
 * Kassenbuch als Monatsblatt wie die üblichen Kassenbuch-Vordrucke (Ahmed 09.10.: „online Kassenbücher anschauen,
 * nur oben Logo, quer geht auch“): A4 quer, kein Briefpapier, Kopf mit Logo, Firma, Monat; Kopfkasten mit
 * Anfangsbestand/Einnahmen/Ausgaben/Endbestand; Spalten Lfd. Nr. · Datum · Beleg · Buchungstext · Kategorie ·
 * Einnahmen · Ausgaben · Bestand; „Übertrag“ am Seitenende und -anfang; Summenzeile, Kassensturz, Unterschriften.
 */

const LOGO = fileURLToPath(new URL('../../assets/web/logo-transparent.png', import.meta.url));

const W = 841.89;
const H = 595.28;
const M = 32;
const INK = rgb(0.12, 0.12, 0.12);
const MUT = rgb(0.42, 0.42, 0.42);
const LINE = rgb(0.8, 0.8, 0.8);
const GRID = rgb(0.9, 0.9, 0.9);
const HEAD = rgb(0.95, 0.95, 0.95);
const BRAND = rgb(0.49, 0.08, 0.21);
const ZEBRA = rgb(0.985, 0.985, 0.985);

export interface CashbookPdfRow {
  no: number;
  date: string; // TT.MM.JJJJ
  receipt: string;
  text: string;
  category: string;
  income: string;
  expense: string;
  balance: string;
  /** Buchungen mit Beleg-Datei bekommen einen Haken in der Beleg-Spalte */
  hasFile: boolean;
}

export interface CashbookPdf {
  company: string;
  companyLine: string;
  title: string; // „Kassenbuch Oktober 2026“
  period: string; // „01.10.2026 – 31.10.2026“
  cashName: string;
  opening: string;
  openingNote: string;
  income: string;
  expense: string;
  closing: string;
  rows: CashbookPdfRow[];
  /** fortlaufender Bestand je Zeile in Cent – für den Übertrag am Seitenende */
  balances: bigint[];
  fmt: (c: bigint) => string;
  openingCents: bigint;
  closingNotes: string[];
  cancelled: string[];
  footnote: string;
  created: string;
}

const COLS: { label: string; w: number; align?: 'right' | 'center' }[] = [
  { label: 'Lfd. Nr.', w: 46, align: 'center' },
  { label: 'Datum', w: 64 },
  { label: 'Beleg-Nr.', w: 78 },
  { label: 'Buchungstext', w: 262 },
  { label: 'Kategorie', w: 100 },
  { label: 'Einnahmen €', w: 80, align: 'right' },
  { label: 'Ausgaben €', w: 80, align: 'right' },
  { label: 'Bestand €', w: 68, align: 'right' },
];

export async function renderCashbookPdf(p: CashbookPdf): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const f = await pdfFonts();
  const reg = await pdf.embedFont(f.regular, { subset: false });
  const bold = await pdf.embedFont(f.bold, { subset: false });
  const logoBytes = await readFile(LOGO).catch(() => null);
  const logo = logoBytes ? await pdf.embedPng(logoBytes) : null;
  pdf.setTitle(p.title);
  pdf.setAuthor(p.company);
  pdf.setCreator('Viva-Deluxe Betriebs-App');
  pdf.setLanguage('de-DE');

  const fs = 8.5;
  const rowH = 17;
  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;
  const xs: number[] = [];
  {
    let x = M;
    for (const c of COLS) {
      xs.push(x);
      x += c.w;
    }
  }
  const tableR = xs[xs.length - 1]! + COLS[COLS.length - 1]!.w;

  const text = (
    t: string,
    x: number,
    yy: number,
    o: { size?: number; font?: PDFFont; color?: typeof INK } = {},
  ) => page.drawText(t, { x, y: yy, size: o.size ?? fs, font: o.font ?? reg, color: o.color ?? INK });
  const fit = (s: string, font: PDFFont, size: number, w: number) => {
    if (font.widthOfTextAtSize(s, size) <= w) return s;
    let t = s;
    while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > w) t = t.slice(0, -1);
    return `${t}…`;
  };
  const cell = (i: number, t: string, yy: number, font: PDFFont = reg, color = INK) => {
    const c = COLS[i]!;
    const s = fit(t, font, fs, c.w - 8);
    const tw = font.widthOfTextAtSize(s, fs);
    const x =
      c.align === 'right'
        ? xs[i]! + c.w - 4 - tw
        : c.align === 'center'
          ? xs[i]! + (c.w - tw) / 2
          : xs[i]! + 4;
    text(s, x, yy, { font, color });
  };
  const vlines = (top: number, bottom: number) => {
    for (const x of [...xs.slice(1), tableR, M])
      page.drawLine({ start: { x, y: top }, end: { x, y: bottom }, thickness: 0.4, color: LINE });
  };

  const header = (first: boolean) => {
    page = pdf.addPage([W, H]);
    pages.push(page);
    y = H - M;
    // Logo links, Titel rechts
    if (logo) {
      const lw = 150;
      const lh = (logo.height / logo.width) * lw;
      page.drawImage(logo, { x: M, y: y - lh, width: lw, height: lh });
    }
    const title = p.title;
    const tw = bold.widthOfTextAtSize(title, 18);
    text(title, W - M - tw, y - 16, { size: 18, font: bold, color: BRAND });
    const sub = `${p.company} · ${p.cashName} · ${p.period}`;
    text(sub, W - M - reg.widthOfTextAtSize(sub, 8.5), y - 30, { size: 8.5, color: MUT });
    text(p.companyLine, W - M - reg.widthOfTextAtSize(p.companyLine, 7.5), y - 41, { size: 7.5, color: MUT });
    y -= 56;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1.2, color: BRAND });
    y -= 12;
    if (first) {
      // Kopfkasten: Anfangsbestand + Einnahmen − Ausgaben = Endbestand
      const boxes: [string, string, string?][] = [
        ['Anfangsbestand', p.opening, p.openingNote],
        ['+ Einnahmen', p.income],
        ['− Ausgaben', p.expense],
        ['= Endbestand', p.closing],
      ];
      const bw = (W - 2 * M - 3 * 10) / 4;
      boxes.forEach(([l, v, n], i) => {
        const x = M + i * (bw + 10);
        const last = i === 3;
        page.drawRectangle({
          x,
          y: y - 40,
          width: bw,
          height: 40,
          color: last ? BRAND : HEAD,
          borderColor: last ? BRAND : LINE,
          borderWidth: 0.6,
        });
        const c = last ? rgb(1, 1, 1) : MUT;
        text(l, x + 10, y - 13, { size: 7.5, font: bold, color: c });
        text(v, x + 10, y - 31, { size: 13, font: bold, color: last ? rgb(1, 1, 1) : INK });
        if (n) text(n, x + bw - 10 - reg.widthOfTextAtSize(n, 7), y - 13, { size: 7, color: MUT });
      });
      y -= 54;
    }
    // Tabellenkopf
    page.drawRectangle({ x: M, y: y - rowH, width: tableR - M, height: rowH, color: HEAD });
    COLS.forEach((_, i) => cell(i, COLS[i]!.label, y - 11.5, bold, INK));
    vlines(y, y - rowH);
    page.drawLine({ start: { x: M, y }, end: { x: tableR, y }, thickness: 0.6, color: LINE });
    y -= rowH;
    page.drawLine({ start: { x: M, y }, end: { x: tableR, y }, thickness: 0.9, color: BRAND });
  };

  const line = (
    cells: string[],
    o: { font?: PDFFont; fill?: typeof INK | undefined; color?: typeof INK } = {},
  ) => {
    if (o.fill) page.drawRectangle({ x: M, y: y - rowH, width: tableR - M, height: rowH, color: o.fill });
    cells.forEach((t, i) => t && cell(i, t, y - 11.5, o.font ?? reg, o.color ?? INK));
    vlines(y, y - rowH);
    y -= rowH;
    page.drawLine({ start: { x: M, y }, end: { x: tableR, y }, thickness: 0.4, color: GRID });
  };

  const BOTTOM = M + 30;
  header(true);
  line(['', '', '', 'Anfangsbestand / Übertrag aus Vormonat', '', '', '', p.opening], {
    font: bold,
    fill: ZEBRA,
  });
  p.rows.forEach((r, i) => {
    if (y - rowH < BOTTOM + rowH) {
      const carry = i > 0 ? p.fmt(p.balances[i - 1]!) : p.fmt(p.openingCents);
      line(['', '', '', 'Übertrag auf nächste Seite', '', '', '', carry], { font: bold, fill: HEAD });
      header(false);
      line(['', '', '', 'Übertrag von vorheriger Seite', '', '', '', carry], { font: bold, fill: HEAD });
    }
    line(
      [
        String(r.no),
        r.date,
        r.receipt + (r.hasFile ? ' ✓' : ''),
        r.text,
        r.category,
        r.income,
        r.expense,
        r.balance,
      ],
      { fill: i % 2 ? ZEBRA : undefined },
    );
  });
  if (!p.rows.length) line(['', '', '', 'Keine Buchungen in diesem Monat.', '', '', '', ''], { color: MUT });
  if (y - rowH * 2 < BOTTOM) header(false);
  line(['', '', '', 'Summe Monat', '', p.income, p.expense, ''], { font: bold, fill: HEAD });
  line(['', '', '', 'Endbestand', '', '', '', p.closing], { font: bold, fill: HEAD });

  // Hinweise, Storno, Kassensturz, Unterschriften
  const wrap = (t: string, w: number) => {
    const out: string[] = [];
    let cur = '';
    for (const word of t.split(' ')) {
      const next = cur ? `${cur} ${word}` : word;
      if (reg.widthOfTextAtSize(next, 7.5) > w && cur) {
        out.push(cur);
        cur = word;
      } else cur = next;
    }
    if (cur) out.push(cur);
    return out;
  };
  const notes = [
    ...p.closingNotes,
    ...(p.cancelled.length ? [`Storniert (nicht im Bestand): ${p.cancelled.join(' · ')}`] : []),
    p.footnote,
  ]
    .filter(Boolean)
    .flatMap((n) => wrap(n, W - 2 * M));
  const need = notes.length * 11 + 70;
  if (y - need < M) header(false);
  y -= 14;
  for (const n of notes) {
    text(n, M, y, { size: 7.5, color: MUT });
    y -= 11;
  }
  y -= 34;
  const sig = (x: number, label: string) => {
    page.drawLine({ start: { x, y }, end: { x: x + 220, y }, thickness: 0.5, color: INK });
    text(label, x, y - 10, { size: 7.5, color: MUT });
  };
  sig(M, 'Ort, Datum');
  sig(M + 260, 'Unterschrift Kassenführer/in');
  sig(M + 520, 'Unterschrift Geschäftsführung (geprüft)');

  pages.forEach((pg, i) => {
    const t = `${p.title} · Seite ${i + 1} von ${pages.length} · erstellt ${p.created}`;
    pg.drawText(t, { x: M, y: M - 14, size: 7, font: reg, color: MUT });
  });
  return pdf.save({ useObjectStreams: false });
}
