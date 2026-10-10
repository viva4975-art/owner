import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont, type PDFPage, rgb } from '@cantoo/pdf-lib';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { embedUiFonts } from './fonts.js';

const LOGO = fileURLToPath(new URL('../../assets/web/logo-transparent.png', import.meta.url));
let logoBytes: Promise<Buffer | null> | null = null;
const logo = () => (logoBytes ??= readFile(LOGO).catch(() => null));

/*
 * Einfache Listen-PDF (A4 quer oder hoch) für Auswertungen: Titel, Untertitel, Tabelle mit Kopfzeile auf jeder
 * Seite, optional farbige Zellen (z. B. Urlaubskalender), Fußzeile mit Seitenzahl und Erstellungszeit.
 */

export interface PdfColumn {
  label: string;
  width: number; // in pt
  align?: 'left' | 'right' | 'center';
  /** lange Texte umbrechen (bis 4 Zeilen) statt mit „…“ abschneiden */
  wrap?: boolean;
}

export interface PdfCell {
  text: string;
  fill?: [number, number, number];
  bold?: boolean;
}

export type PdfRow = (string | PdfCell)[] | { section: string };

const INK = rgb(0.1, 0.09, 0.1);
const MUT = rgb(0.47, 0.45, 0.47);
const LINE = rgb(0.86, 0.86, 0.86);
const HEAD = rgb(0.972, 0.968, 0.97);
const BRAND = rgb(0.49, 0.08, 0.21);

export async function renderTablePdf(p: {
  title: string;
  subtitle?: string;
  columns: PdfColumn[];
  rows: PdfRow[];
  landscape?: boolean;
  fontSize?: number;
  footnote?: string;
  /** Zeilen fett, z. B. Summen */
  totals?: (string | PdfCell)[];
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const { regular, bold } = await embedUiFonts(pdf);
  const logoPng = await logo();
  const logoImg = logoPng ? await pdf.embedPng(logoPng) : null;
  pdf.setTitle(p.title);
  pdf.setCreator('Viva-Deluxe Betriebs-App');
  pdf.setLanguage('de-DE');
  const [W, H] = p.landscape === false ? [595.28, 841.89] : [841.89, 595.28];
  const M = 28;
  const fs = p.fontSize ?? 8;
  const rowH = fs + 7;
  const totalW = p.columns.reduce((a, c) => a + c.width, 0);
  const scale = Math.min(1, (W - 2 * M) / totalW);
  const cols = p.columns.map((c) => ({ ...c, width: c.width * scale }));
  const created = new Date().toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  let page!: PDFPage;
  let y = 0;
  const pages: PDFPage[] = [];
  const fit = (s: string, font: PDFFont, size: number, w: number) => {
    if (font.widthOfTextAtSize(s, size) <= w) return s;
    let t = s;
    while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > w) t = t.slice(0, -1);
    return `${t}…`;
  };
  /** Text in Zeilen der Breite w (Wortgrenzen), höchstens max Zeilen – die letzte notfalls mit „…“. */
  const wrapLines = (s: string, font: PDFFont, size: number, w: number, max = 4) => {
    const out: string[] = [];
    let cur = '';
    for (const word of s.split(/\s+/).filter(Boolean)) {
      const t = cur ? `${cur} ${word}` : word;
      if (font.widthOfTextAtSize(t, size) <= w || !cur) cur = t;
      else {
        out.push(cur);
        cur = word;
      }
    }
    if (cur) out.push(cur);
    if (out.length > max) {
      const keep = out.slice(0, max);
      keep[max - 1] = fit(`${keep[max - 1]} ${out.slice(max).join(' ')}`, font, size, w);
      return keep.map((l) => fit(l, font, size, w));
    }
    return out.length ? out.map((l) => fit(l, font, size, w)) : [''];
  };
  const LINE_GAP = fs + 2;
  const cellObj = (cell: string | PdfCell | undefined): PdfCell =>
    typeof cell === 'string' || cell === undefined ? { text: cell ?? '' } : cell;
  const cellLines = (cells: (string | PdfCell)[], font: PDFFont, header: boolean) =>
    cols.map((c, i) => {
      const obj = cellObj(cells[i]);
      const fnt = obj.bold ? bold : font;
      if (header) {
        // Kopfzeile: erst kleiner schreiben, erst dann kürzen (Fund: „Persona…“, „Beschäftigu…“)
        let size = fs;
        while (size > fs - 2 && fnt.widthOfTextAtSize(obj.text, size) > c.width - 4) size -= 0.5;
        return { lines: [fit(obj.text, fnt, size, c.width - 4)], size };
      }
      return c.wrap
        ? { lines: wrapLines(obj.text, fnt, fs, c.width - 4), size: fs }
        : { lines: [fit(obj.text, fnt, fs, c.width - 4)], size: fs };
    });
  const heightOf = (cells: (string | PdfCell)[], font: PDFFont, header = false) =>
    rowH + (Math.max(1, ...cellLines(cells, font, header).map((l) => l.lines.length)) - 1) * LINE_GAP;
  const drawRow = (
    cells: (string | PdfCell)[],
    font: PDFFont,
    fill?: ReturnType<typeof rgb>,
    header = false,
  ) => {
    let x = M;
    const lines = cellLines(cells, font, header);
    const h = rowH + (Math.max(1, ...lines.map((l) => l.lines.length)) - 1) * LINE_GAP;
    if (fill) page.drawRectangle({ x: M, y: y - h + 3, width: W - 2 * M, height: h, color: fill });
    cols.forEach((c, i) => {
      const cell = cells[i];
      const obj = cellObj(cell);
      if (obj.fill)
        page.drawRectangle({
          x,
          y: y - h + 3,
          width: c.width,
          height: h,
          color: rgb(...obj.fill),
        });
      const fnt = obj.bold ? bold : font;
      const { lines: ls, size } = lines[i]!;
      ls.forEach((txt, li) => {
        const tw = fnt.widthOfTextAtSize(txt, size);
        const tx =
          c.align === 'right' ? x + c.width - 6 - tw : c.align === 'center' ? x + (c.width - tw) / 2 : x + 2;
        page.drawText(txt, { x: tx, y: y - fs - li * LINE_GAP, size, font: fnt, color: INK });
      });
      x += c.width;
    });
    page.drawLine({
      start: { x: M, y: y - h + 3 },
      end: { x: W - M, y: y - h + 3 },
      thickness: 0.4,
      color: LINE,
    });
    y -= h;
  };
  const newPage = () => {
    page = pdf.addPage([W, H]);
    pages.push(page);
    y = H - M;
    if (logoImg) {
      // Logo oben rechts (420 × 96 px → 120 pt breit)
      const w = 120;
      const h = (logoImg.height / logoImg.width) * w;
      page.drawImage(logoImg, { x: W - M - w, y: y - h + 4, width: w, height: h });
    }
    page.drawText('Viva-Deluxe Gebäudereinigung GmbH', { x: M, y: y - 8, size: 8, font: bold, color: BRAND });
    y -= 26;
    page.drawText(p.title, { x: M, y, size: 14, font: bold, color: INK });
    y -= 14;
    if (p.subtitle) {
      page.drawText(p.subtitle, { x: M, y, size: 9, font: regular, color: MUT });
      y -= 14;
    }
    y -= 4;
    drawRow(
      cols.map((c) => ({ text: c.label, bold: true })),
      bold,
      HEAD,
      true,
    );
  };
  newPage();
  for (const r of p.rows) {
    if (y - (Array.isArray(r) ? heightOf(r, regular) : rowH) < M + 24) newPage();
    if (!Array.isArray(r)) {
      y -= 4;
      page.drawText(fit(r.section, bold, fs + 1, W - 2 * M), {
        x: M + 2,
        y: y - fs - 1,
        size: fs + 1,
        font: bold,
        color: BRAND,
      });
      y -= rowH + 2;
      continue;
    }
    drawRow(r, regular);
  }
  if (p.totals) {
    if (y - rowH < M + 24) newPage();
    drawRow(
      p.totals.map((t) => (typeof t === 'string' ? { text: t, bold: true } : { ...t, bold: true })),
      bold,
      HEAD,
    );
  }
  if (p.footnote) {
    if (y - 20 < M + 14) newPage();
    page.drawText(p.footnote, { x: M, y: y - 14, size: 7, font: regular, color: MUT, maxWidth: W - 2 * M });
  }
  pages.forEach((pg, i) =>
    pg.drawText(`Seite ${i + 1} von ${pages.length} · erstellt ${created}`, {
      x: M,
      y: M - 12,
      size: 7,
      font: regular,
      color: MUT,
    }),
  );
  return pdf.save();
}
