import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont, type PDFPage, rgb } from '@cantoo/pdf-lib';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { holidaysBavaria, isoWeekday } from '../domain/time/holidays.js';
import { embedUiFonts } from './fonts.js';

/*
 * Anwesenheitsliste für das Objekt (Ahmed 10.10.: „eine Seite mit Anwesenheit für zwei Monate parallel“): A4 quer,
 * links und rechts je ein Monat mit allen Tagen, Wochenenden grau, Feiertage in Bayern mit Namen. Ersetzt die
 * Word-Listen je Jahr (VD-ANW-2026/2027) – jeder Zeitraum wird hier erzeugt.
 */

const LOGO = fileURLToPath(new URL('../../assets/web/logo-transparent.png', import.meta.url));
const W = 841.89;
const H = 595.28;
const M = 28;
const GAP = 16;
const INK = rgb(0.1, 0.09, 0.1);
const GREY = rgb(0.47, 0.45, 0.47);
const HAIR = rgb(0.84, 0.83, 0.84);
const WEEKEND = rgb(0.94, 0.935, 0.94);
const HOLIDAY = rgb(0.98, 0.93, 0.945);
const BRD = rgb(125 / 255, 20 / 255, 53 / 255);

const MONTHS = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];
const WD = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** „2026-11“ → „2026-12“ */
export function nextMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return `${MONTHS[m - 1]} ${y}`;
}

export async function renderAttendancePdf(p: {
  site: { name: string; site_no: string; address?: string | null };
  customer?: string | null;
  /** erster Monat (JJJJ-MM); es folgt immer der nächste */
  month: string;
  /** Anzahl Doppelseiten (je zwei Monate), Standard 1 */
  pages?: number;
  company: string;
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const { regular, bold } = await embedUiFonts(pdf);
  const logoBytes = await readFile(LOGO).catch(() => null);
  const logo = logoBytes ? await pdf.embedPng(logoBytes) : null;
  pdf.setTitle(`Anwesenheitsliste ${p.site.name} ${monthLabel(p.month)}`);
  pdf.setAuthor(p.company);
  pdf.setLanguage('de-DE');
  pdf.setCreator('Viva-Deluxe Betriebs-App');
  const fixed = new Date(`${p.month}-01T12:00:00Z`);
  pdf.setCreationDate(fixed);
  pdf.setModificationDate(fixed);

  const text = (pg: PDFPage, t: string, x: number, y: number, size: number, f: PDFFont, color = INK) =>
    pg.drawText(t, { x, y: H - y, size, font: f, color });
  const fit = (t: string, f: PDFFont, size: number, max: number) => {
    if (f.widthOfTextAtSize(t, size) <= max) return t;
    let s = t;
    while (s.length > 1 && f.widthOfTextAtSize(`${s}…`, size) > max) s = s.slice(0, -1);
    return `${s}…`;
  };

  let ym = p.month;
  for (let n = 0; n < (p.pages ?? 1); n++) {
    const months = [ym, nextMonth(ym)];
    ym = nextMonth(months[1]!);
    const pg = pdf.addPage([W, H]);
    // Kopf
    if (logo) {
      const h = 30;
      pg.drawImage(logo, {
        x: W - M - (logo.width / logo.height) * h,
        y: H - M - h + 4,
        width: (logo.width / logo.height) * h,
        height: h,
      });
    }
    text(pg, 'Anwesenheitsliste', M, M + 14, 17, bold);
    text(pg, `${monthLabel(months[0]!)} und ${monthLabel(months[1]!)}`, M + 168, M + 14, 11, regular, BRD);
    const objekt = `${p.site.name} (${p.site.site_no})${p.site.address ? ` · ${p.site.address}` : ''}${p.customer ? ` · Kunde: ${p.customer}` : ''}`;
    text(pg, fit(objekt, regular, 8.6, W - 2 * M - 140), M, M + 30, 8.6, regular, GREY);
    pg.drawLine({
      start: { x: M, y: H - M - 37 },
      end: { x: W - M, y: H - M - 37 },
      thickness: 0.5,
      color: INK,
    });

    const colW = (W - 2 * M - GAP) / 2;
    const cols = [
      { label: 'TAG', w: 50 },
      { label: 'VON – BIS', w: 62 },
      { label: 'NAME', w: 0 },
      { label: 'UNTERSCHRIFT', w: 86 },
      { label: 'BEMERKUNG', w: 70 },
    ];
    cols[2]!.w = colW - cols.reduce((a, c) => a + c.w, 0);
    const top = M + 50;
    const bottom = H - M - 22;
    const rowH = (bottom - top - 16) / 31;
    months.forEach((mm, k) => {
      const x0 = M + k * (colW + GAP);
      const [y, mo] = mm.split('-').map(Number) as [number, number];
      const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      const hol = holidaysBavaria(y);
      text(pg, monthLabel(mm).toUpperCase(), x0, top - 2, 8, bold, BRD);
      // Spaltenköpfe
      let cx = x0;
      for (const c of cols) {
        text(pg, c.label, cx + 3, top + 10, 6, bold, GREY);
        cx += c.w;
      }
      pg.drawLine({
        start: { x: x0, y: H - top - 14 },
        end: { x: x0 + colW, y: H - top - 14 },
        thickness: 0.5,
        color: INK,
      });
      for (let d = 1; d <= days; d++) {
        const date = `${mm}-${String(d).padStart(2, '0')}`;
        const wd = isoWeekday(date);
        const yRow = top + 16 + (d - 1) * rowH;
        const h = hol.get(date);
        if (h || wd >= 6)
          pg.drawRectangle({
            x: x0,
            y: H - yRow - rowH,
            width: colW,
            height: rowH,
            color: h ? HOLIDAY : WEEKEND,
          });
        const base = yRow + rowH * 0.68;
        text(
          pg,
          `${WD[wd]} ${String(d).padStart(2, '0')}.${String(mo).padStart(2, '0')}.`,
          x0 + 3,
          base,
          7.6,
          wd >= 6 || h ? bold : regular,
          h ? BRD : INK,
        );
        if (h)
          text(pg, fit(h, regular, 6.4, cols[4]!.w - 6), x0 + colW - cols[4]!.w + 3, base, 6.4, regular, BRD);
        pg.drawLine({
          start: { x: x0, y: H - yRow - rowH },
          end: { x: x0 + colW, y: H - yRow - rowH },
          thickness: 0.35,
          color: HAIR,
        });
      }
      // senkrechte Haarlinien
      let vx = x0;
      for (const c of cols.slice(0, -1)) {
        vx += c.w;
        pg.drawLine({
          start: { x: vx, y: H - top - 14 },
          end: { x: vx, y: H - top - 16 - days * rowH },
          thickness: 0.35,
          color: HAIR,
        });
      }
    });
    text(
      pg,
      'Grau = Samstag/Sonntag · Rosa = gesetzlicher Feiertag in Bayern · Die Liste bleibt im Objekt und wird nach Monatsende im Büro abgegeben.',
      M,
      H - M - 6,
      6.8,
      regular,
      GREY,
    );
    const right = `${p.company} · Objekt ${p.site.site_no}`;
    text(pg, right, W - M - regular.widthOfTextAtSize(right, 6.8), H - M - 6, 6.8, regular, GREY);
  }
  return pdf.save({ useObjectStreams: false });
}
