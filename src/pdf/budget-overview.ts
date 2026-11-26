import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont, type PDFPage, rgb } from '@cantoo/pdf-lib';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { embedUiFonts } from './fonts.js';

/*
 * Übersichtsseite der Budgetplanung als PDF (A4 quer): Kennzahlen, Säulendiagramm Umsatz/Kosten/Ergebnis je Monat,
 * Kostenstruktur (gestapelter Balken) und größte Kunden bzw. Gemeinkosten als Balken. Wird vor die Tabellen gesetzt.
 */

const LOGO = fileURLToPath(new URL('../../assets/web/logo-transparent.png', import.meta.url));

const INK = rgb(0.1, 0.09, 0.1);
const MUT = rgb(0.43, 0.43, 0.45);
const LINE = rgb(0.88, 0.88, 0.9);
const BRAND = rgb(0.49, 0.08, 0.21);
const COST = rgb(0.72, 0.72, 0.74);
const OK = rgb(0.18, 0.49, 0.31);
const ERR = rgb(0.7, 0.15, 0.12);

const hex = (h: string) =>
  rgb(
    parseInt(h.slice(1, 3), 16) / 255,
    parseInt(h.slice(3, 5), 16) / 255,
    parseInt(h.slice(5, 7), 16) / 255,
  );

export interface BudgetOverviewInput {
  title: string;
  subtitle: string;
  kpis: { label: string; value: string; sub?: string; neg?: boolean }[];
  months: { label: string; revenue: bigint; prev?: bigint; costs: bigint; result: bigint }[];
  structure: { label: string; cents: bigint; color: string }[];
  customers: { label: string; cents: bigint }[];
  overhead: { label: string; cents: bigint }[];
}

const eur = (c: bigint) => `${(Number(c) / 100).toLocaleString('de-DE', { maximumFractionDigits: 0 })} €`;
const short = (e: number) =>
  Math.abs(e) >= 1e6
    ? `${(e / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Mio`
    : Math.abs(e) >= 1000
      ? `${Math.round(e / 1000).toLocaleString('de-DE')} T`
      : Math.round(e).toLocaleString('de-DE');

function fit(text: string, font: PDFFont, size: number, max: number) {
  if (font.widthOfTextAtSize(text, size) <= max) return text;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > max) t = t.slice(0, -1);
  return `${t}…`;
}

function barsBlock(
  page: PDFPage,
  f: { regular: PDFFont; bold: PDFFont },
  title: string,
  rows: { label: string; cents: bigint }[],
  x: number,
  yTop: number,
  w: number,
  n: number,
) {
  page.drawText(title, { x, y: yTop, size: 10.5, font: f.bold, color: INK });
  const list = rows.filter((r) => r.cents > 0n).slice(0, n);
  const max = list.reduce((m, r) => (r.cents > m ? r.cents : m), 1n);
  const total = rows.reduce((a, r) => a + (r.cents > 0n ? r.cents : 0n), 0n);
  let y = yTop - 16;
  const labelW = w * 0.42;
  const barW = w - labelW - 70;
  for (const r of list) {
    page.drawText(fit(r.label, f.regular, 8, labelW - 6), { x, y, size: 8, font: f.regular, color: INK });
    const bw = Math.max(1, (Number(r.cents) / Number(max)) * barW);
    page.drawRectangle({ x: x + labelW, y: y - 1, width: bw, height: 7, color: BRAND });
    const v = `${eur(r.cents)}  ${total > 0n ? ((Number(r.cents) / Number(total)) * 100).toFixed(1).replace('.', ',') : '0'} %`;
    page.drawText(v, {
      x: x + w - f.regular.widthOfTextAtSize(v, 7.5),
      y,
      size: 7.5,
      font: f.regular,
      color: MUT,
    });
    y -= 13;
  }
  if (!list.length) page.drawText('–', { x, y, size: 8, font: f.regular, color: MUT });
}

export async function budgetOverviewPdf(p: BudgetOverviewInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const f = await embedUiFonts(pdf);
  pdf.setTitle(p.title);
  pdf.setCreator('Viva-Deluxe Betriebs-App');
  pdf.setLanguage('de-DE');
  const [W, H] = [841.89, 595.28];
  const page = pdf.addPage([W, H]);
  const M = 36;
  const logo = await readFile(LOGO).catch(() => null);
  if (logo) {
    const img = await pdf.embedPng(logo);
    const lw = 110;
    page.drawImage(img, {
      x: W - M - lw,
      y: H - M - (img.height / img.width) * lw,
      width: lw,
      height: (img.height / img.width) * lw,
    });
  }
  page.drawText(p.title, { x: M, y: H - M - 14, size: 18, font: f.bold, color: INK });
  page.drawText(p.subtitle, { x: M, y: H - M - 30, size: 9, font: f.regular, color: MUT });

  // Kennzahlen
  const kTop = H - M - 52;
  const kw = (W - 2 * M - (p.kpis.length - 1) * 8) / p.kpis.length;
  p.kpis.forEach((k, i) => {
    const x = M + i * (kw + 8);
    page.drawRectangle({
      x,
      y: kTop - 52,
      width: kw,
      height: 52,
      borderColor: LINE,
      borderWidth: 0.8,
      color: rgb(1, 1, 1),
    });
    page.drawRectangle({ x, y: kTop - 2, width: kw, height: 2, color: BRAND });
    page.drawText(k.label, { x: x + 8, y: kTop - 15, size: 8, font: f.regular, color: MUT });
    page.drawText(fit(k.value, f.bold, 15, kw - 16), {
      x: x + 8,
      y: kTop - 33,
      size: 15,
      font: f.bold,
      color: k.neg ? ERR : INK,
    });
    if (k.sub)
      page.drawText(fit(k.sub, f.regular, 7.5, kw - 16), {
        x: x + 8,
        y: kTop - 45,
        size: 7.5,
        font: f.regular,
        color: MUT,
      });
  });

  // Säulen je Monat: Umsatz, Kosten; Ergebnis als Zahl (keine Vorjahreswerte, Ahmed 26.11.)
  const cX = M;
  const cTop = kTop - 76;
  const cW = 500;
  const cH = 220;
  page.drawText('Umsatz, Kosten und Ergebnis je Monat', {
    x: cX,
    y: cTop,
    size: 10.5,
    font: f.bold,
    color: INK,
  });
  const legend: [string, ReturnType<typeof rgb>][] = [
    ['Umsatz Plan', BRAND],
    ['Kosten gesamt', COST],
  ];
  let lx = cX + 220;
  for (const [l, c] of legend) {
    page.drawRectangle({ x: lx, y: cTop, width: 8, height: 8, color: c });
    page.drawText(l, { x: lx + 11, y: cTop + 1, size: 7.5, font: f.regular, color: MUT });
    lx += f.regular.widthOfTextAtSize(l, 7.5) + 26;
  }
  const axL = cX + 42;
  const base = cTop - 14 - cH + 28;
  const plotH = cH - 40;
  const max = p.months.reduce((m, r) => {
    for (const v of [r.revenue, r.costs]) if (v > m) m = v;
    return m;
  }, 1n);
  const maxE = Number(max) / 100;
  const step = (() => {
    const raw = maxE / 4;
    const pw = 10 ** Math.floor(Math.log10(raw || 1));
    return ([1, 2, 2.5, 5, 10].find((m) => m * pw >= raw) ?? 10) * pw;
  })();
  const top = Math.ceil(maxE / step) * step || 1;
  const yv = (e: number) => base + (plotH * Math.max(0, e)) / top;
  for (let t = 0; t <= top + 0.001; t += step) {
    page.drawLine({
      start: { x: axL, y: yv(t) },
      end: { x: cX + cW, y: yv(t) },
      thickness: 0.5,
      color: LINE,
    });
    const s = short(t);
    page.drawText(s, {
      x: axL - 4 - f.regular.widthOfTextAtSize(s, 7),
      y: yv(t) - 2.5,
      size: 7,
      font: f.regular,
      color: MUT,
    });
  }
  const slot = (cX + cW - axL) / Math.max(1, p.months.length);
  p.months.forEach((m, i) => {
    const gw = slot * 0.78;
    const bw = gw / 2;
    const x0 = axL + i * slot + (slot - gw) / 2;
    const bars: [bigint, ReturnType<typeof rgb>][] = [
      [m.revenue, BRAND],
      [m.costs, COST],
    ];
    bars.forEach(([v, c], k) => {
      const h = yv(Number(v) / 100) - base;
      if (h > 0) page.drawRectangle({ x: x0 + k * bw, y: base, width: bw - 1, height: h, color: c });
    });
    const lab = m.label;
    page.drawText(lab, {
      x: axL + i * slot + slot / 2 - f.regular.widthOfTextAtSize(lab, 7.5) / 2,
      y: base - 11,
      size: 7.5,
      font: f.regular,
      color: MUT,
    });
    const r = short(Number(m.result) / 100);
    page.drawText(r, {
      x: axL + i * slot + slot / 2 - f.bold.widthOfTextAtSize(r, 7) / 2,
      y: base - 22,
      size: 7,
      font: f.bold,
      color: m.result < 0n ? ERR : OK,
    });
  });
  page.drawText('Ergebnis', { x: cX, y: base - 22, size: 7, font: f.regular, color: MUT });

  // Rechts: Kostenstruktur (gestapelter 100-%-Balken) und größte Kunden
  const rX = cX + cW + 30;
  const rW = W - M - rX;
  page.drawText('Wohin geht der Umsatz?', { x: rX, y: cTop, size: 10.5, font: f.bold, color: INK });
  const pos = p.structure.filter((s) => s.cents > 0n);
  const sum = pos.reduce((a, s) => a + s.cents, 0n) || 1n;
  let sx = rX;
  for (const s of pos) {
    const w = (Number(s.cents) / Number(sum)) * rW;
    page.drawRectangle({ x: sx, y: cTop - 26, width: Math.max(0.5, w), height: 14, color: hex(s.color) });
    sx += w;
  }
  let ly = cTop - 42;
  for (const s of pos) {
    page.drawRectangle({ x: rX, y: ly, width: 7, height: 7, color: hex(s.color) });
    page.drawText(s.label, { x: rX + 11, y: ly, size: 8, font: f.regular, color: INK });
    const v = `${eur(s.cents)}  ${((Number(s.cents) / Number(sum)) * 100).toFixed(1).replace('.', ',')} %`;
    page.drawText(v, {
      x: rX + rW - f.regular.widthOfTextAtSize(v, 8),
      y: ly,
      size: 8,
      font: f.regular,
      color: MUT,
    });
    ly -= 12;
  }
  barsBlock(page, f, 'Größte Kunden (Umsatz)', p.customers, rX, ly - 14, rW, 8);

  // Fuß: Gemeinkosten
  const fy = base - 48;
  barsBlock(
    page,
    f,
    'Gemeinkosten nach Kostenart',
    p.overhead,
    M,
    fy,
    cW,
    Math.max(3, Math.floor((fy - M) / 13)),
  );
  page.drawText(`erstellt ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`, {
    x: W - M - 120,
    y: 20,
    size: 7,
    font: f.regular,
    color: MUT,
  });
  return pdf.save();
}

/** Mehrere PDFs hintereinander zu einem zusammenfügen. */
export async function mergePdfs(parts: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const p of parts) {
    const src = await PDFDocument.load(p);
    for (const pg of await out.copyPages(src, src.getPageIndices())) out.addPage(pg);
  }
  return out.save();
}
