import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont, type PDFPage, rgb } from '@cantoo/pdf-lib';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pdfFonts } from './render.js';

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
}

export interface PdfCell {
  text: string;
  fill?: [number, number, number];
  bold?: boolean;
}

export type PdfRow = (string | PdfCell)[] | { section: string };

const INK = rgb(0.13, 0.13, 0.13);
const MUT = rgb(0.42, 0.42, 0.42);
const LINE = rgb(0.86, 0.86, 0.86);
const HEAD = rgb(0.98, 0.95, 0.96);
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
  const f = await pdfFonts();
  const regular = await pdf.embedFont(f.regular, { subset: false });
  const bold = await pdf.embedFont(f.bold, { subset: false });
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
  const drawRow = (cells: (string | PdfCell)[], font: PDFFont, fill?: ReturnType<typeof rgb>) => {
    let x = M;
    if (fill) page.drawRectangle({ x: M, y: y - rowH + 3, width: W - 2 * M, height: rowH, color: fill });
    cols.forEach((c, i) => {
      const cell = cells[i];
      const obj: PdfCell = typeof cell === 'string' || cell === undefined ? { text: cell ?? '' } : cell;
      if (obj.fill)
        page.drawRectangle({
          x,
          y: y - rowH + 3,
          width: c.width,
          height: rowH,
          color: rgb(...obj.fill),
        });
      const fnt = obj.bold ? bold : font;
      const txt = fit(obj.text, fnt, fs, c.width - 4);
      const tw = fnt.widthOfTextAtSize(txt, fs);
      const tx =
        c.align === 'right' ? x + c.width - 2 - tw : c.align === 'center' ? x + (c.width - tw) / 2 : x + 2;
      page.drawText(txt, { x: tx, y: y - fs, size: fs, font: fnt, color: INK });
      x += c.width;
    });
    page.drawLine({
      start: { x: M, y: y - rowH + 3 },
      end: { x: W - M, y: y - rowH + 3 },
      thickness: 0.4,
      color: LINE,
    });
    y -= rowH;
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
    );
  };
  newPage();
  for (const r of p.rows) {
    if (y - rowH < M + 24) newPage();
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
