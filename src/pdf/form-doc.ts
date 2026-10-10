import { readFile } from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
import {
  PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setCharacterSpacing,
} from '@cantoo/pdf-lib';
import { embedUiFonts, uiText } from './fonts.js';

/*
 * Formular-Dokumente im Stil der alten Viva-App (Ahmed 08.10.: Bestellschein BE-2026-0001, Arbeitsscheine AS-2026-1024/1028):
 * Briefpapier als Hintergrund, Titel in Bordeaux mit Linie, grauer Infokasten mit Bordeaux-Strich links, zweispaltige
 * Anschriften, Abschnittsbalken, Tabellen mit Bordeaux-Kopflinie, Unterschriftslinien und senkrechter Dokumentkennung
 * rechts („VD-NU-02 Bestellschein … · Seite 1 von 5“).
 * Seit 10.10.2026 in der Gestaltung „edel“ wie die Rechnung: Schrift Inter, dunkle Titel, Kapitälchen-Beschriftungen,
 * Haarlinien, helle graue Flächen mit Bordeaux-Kante.
 */

const ASSETS = new URL('../../assets/', import.meta.url);
const W = 595.28;
const H = 841.89;
const L = 48.5;
const R = 546.5;
const TOP = 128;
const BOTTOM = 702;

const BORDEAUX = rgb(125 / 255, 20 / 255, 53 / 255);
const INK = rgb(0.1, 0.09, 0.1);
const MUT = rgb(0.47, 0.45, 0.47);
const GREY = rgb(0.47, 0.45, 0.47);
const BOX = rgb(0.972, 0.968, 0.97);
const BOX_LINE = rgb(0.89, 0.88, 0.89);
const SECTION = rgb(0.972, 0.968, 0.97);
const RULE = rgb(0.86, 0.85, 0.86);

let letterheadBytes: Uint8Array | null = null;
/** Briefpapier (A4, JPG) – z. B. für Aushänge, die nicht über FormDoc laufen */
export async function letterhead(): Promise<Uint8Array> {
  letterheadBytes ??= await readFile(new URL('briefpapier/viva-deluxe-a4.jpg', ASSETS));
  return letterheadBytes;
}

export interface FormCol {
  label: string;
  width: number;
  align?: 'left' | 'right';
}

export class FormDoc {
  pdf!: PDFDocument;
  reg!: PDFFont;
  bold!: PDFFont;
  bg!: PDFImage;
  page!: PDFPage;
  y = TOP;
  private constructor(
    private sideRef: string,
    private watermark?: string,
  ) {}

  static async create(p: {
    title: string;
    sideRef: string;
    date: string;
    author: string;
    watermark?: string;
  }) {
    const d = new FormDoc(p.sideRef, p.watermark);
    d.pdf = await PDFDocument.create();
    d.pdf.registerFontkit(fontkit);
    const f = await embedUiFonts(d.pdf);
    d.reg = f.regular;
    d.bold = f.bold;
    letterheadBytes ??= await readFile(new URL('briefpapier/viva-deluxe-a4.jpg', ASSETS));
    d.bg = await d.pdf.embedJpg(letterheadBytes);
    d.pdf.setTitle(p.title);
    d.pdf.setAuthor(p.author);
    d.pdf.setLanguage('de-DE');
    d.pdf.setCreator('Viva-Deluxe Betriebs-App');
    d.pdf.setCreationDate(new Date(`${p.date}T12:00:00Z`));
    d.pdf.setModificationDate(new Date(`${p.date}T12:00:00Z`));
    d.newPage();
    return d;
  }

  newPage() {
    this.page = this.pdf.addPage([W, H]);
    this.page.drawImage(this.bg, { x: 0, y: 0, width: W, height: H });
    if (this.watermark)
      this.page.drawText(this.watermark, {
        x: 140,
        y: 300,
        size: 72,
        font: this.bold,
        color: rgb(0.85, 0.85, 0.85),
        rotate: degrees(35),
        opacity: 0.5,
      });
    this.y = TOP;
  }

  /** Platz prüfen, sonst neue Seite (optional mit Wiederholung z. B. eines Tabellenkopfs) */
  ensure(h: number, onBreak?: () => void) {
    if (this.y + h <= BOTTOM) return;
    this.newPage();
    onBreak?.();
  }

  width(t: string, size = 9, bold = false) {
    return (bold ? this.bold : this.reg).widthOfTextAtSize(uiText(t), size);
  }

  /** Kapitälchen-Beschriftung (gesperrt) wie auf der Rechnung */
  cap(
    t: string,
    x: number,
    y: number,
    o: { size?: number; color?: ReturnType<typeof rgb>; right?: boolean } = {},
  ) {
    const s = t.toUpperCase();
    const size = o.size ?? 6.4;
    const w = this.width(s, size, true) + 0.7 * s.length;
    this.page.pushOperators(pushGraphicsState(), setCharacterSpacing(0.7));
    this.text(s, o.right ? x - w : x, y, { size, bold: true, color: o.color ?? GREY });
    this.page.pushOperators(setCharacterSpacing(0), popGraphicsState());
  }

  text(
    t: string,
    x: number,
    y: number,
    o: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb> } = {},
  ) {
    if (!t) return;
    this.page.drawText(uiText(t), {
      x,
      y: H - y,
      size: o.size ?? 9,
      font: o.bold ? this.bold : this.reg,
      color: o.color ?? INK,
    });
  }

  right(
    t: string,
    x: number,
    y: number,
    o: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb> } = {},
  ) {
    this.text(t, x - this.width(t, o.size ?? 9, o.bold), y, o);
  }

  /** Text in Zeilen umbrechen (Wortgrenzen, Zeilenumbrüche bleiben) */
  wrap(t: string, maxW: number, size = 9, bold = false): string[] {
    const out: string[] = [];
    for (const para of (t ?? '').split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (this.width(next, size, bold) <= maxW) line = next;
        else {
          if (line) out.push(line);
          // überlange Wörter hart teilen
          let w = word;
          while (this.width(w, size, bold) > maxW && w.length > 1) {
            let i = w.length;
            while (i > 1 && this.width(w.slice(0, i), size, bold) > maxW) i--;
            out.push(w.slice(0, i));
            w = w.slice(i);
          }
          line = w;
        }
      }
      out.push(line);
    }
    return out;
  }

  rect(
    x: number,
    y: number,
    w: number,
    h: number,
    color: ReturnType<typeof rgb>,
    border?: ReturnType<typeof rgb>,
  ) {
    this.page.drawRectangle({
      x,
      y: H - y - h,
      width: w,
      height: h,
      color,
      ...(border ? { borderColor: border, borderWidth: 0.6 } : {}),
    });
  }

  line(x1: number, x2: number, y: number, color = RULE, thickness = 0.6) {
    this.page.drawLine({ start: { x: x1, y: H - y }, end: { x: x2, y: H - y }, thickness, color });
  }

  /** „Arbeitsschein … Nr. AS-2026-1024“ mit Bordeaux-Linie */
  title(left: string, right?: string) {
    this.text(left, L, this.y + 14, { size: 17, bold: true, color: INK });
    if (right) this.right(right, R, this.y + 12, { size: 11, bold: true, color: BORDEAUX });
    this.y += 22;
    this.line(L, R, this.y, INK, 0.5);
    this.y += 12;
  }

  /** Großer Titel rechtsbündig (Bestellung) mit Hinweis darunter */
  titleRight(t: string, sub?: string) {
    this.right(t, R, this.y + 14, { size: 13, bold: true, color: INK });
    this.y += 20;
    if (sub) {
      this.right(sub, R, this.y + 6, { size: 7.5, color: MUT });
      this.y += 14;
    }
  }

  /** Grauer Kasten mit Bordeaux-Strich: Raster aus Beschriftung (klein) und Wert, 3 Spalten */
  infoGrid(cells: [string, string][], cols = 3) {
    const rows = Math.ceil(cells.length / cols);
    const h = rows * 26 + 10;
    this.rect(L, this.y, R - L, h, BOX);
    this.rect(L, this.y, 2.2, h, BORDEAUX);
    const cw = (R - L - 20) / cols;
    cells.forEach(([k, v], i) => {
      const x = L + 14 + (i % cols) * cw;
      const y = this.y + 14 + Math.floor(i / cols) * 26;
      this.cap(k, x, y, { size: 5.8 });
      this.text(this.fit(v, cw - 8, 9), x, y + 11, { size: 9 });
    });
    this.y += h + 12;
  }

  /** Kasten mit Beschriftung links und Wert (wie Bestellschein); optional zweites Paar rechts */
  kvBox(rows: { k: string; v: string; k2?: string; v2?: string; strong?: boolean; accent?: boolean }[]) {
    const lh = 17.5;
    const h = rows.length * lh + 14;
    this.ensure(h);
    this.rect(L, this.y, R - L, h, rgb(1, 1, 1), BOX_LINE);
    let y = this.y + 18;
    for (const r of rows) {
      this.cap(r.k, L + 14, y, { size: 6 });
      const vw = r.k2 ? 170 : R - L - 190;
      this.text(this.fit(r.v, vw, r.strong ? 10.5 : 9), L + 120, y, {
        size: r.strong ? 10.5 : 9,
        bold: !!r.strong || !!r.accent,
        color: r.accent ? BORDEAUX : INK,
      });
      if (r.k2) {
        this.cap(r.k2, L + 330, y, { size: 6 });
        this.text(this.fit(r.v2 ?? '', 90, 9), L + 420, y, { size: 9, bold: true });
      }
      y += lh;
    }
    this.y += h + 14;
  }

  /** Zwei Spalten mit Bordeaux-Beschriftung (Kunden-/Objektanschrift) */
  twoCols(a: { label: string; lines: string[] }, b: { label: string; lines: string[] }) {
    const half = (R - L) / 2;
    const wrapAll = (ls: string[]) => ls.flatMap((l) => this.wrap(l, half - 16, 9));
    const la = wrapAll(a.lines);
    const lb = wrapAll(b.lines);
    this.ensure(14 + Math.max(la.length, lb.length) * 12);
    this.cap(a.label, L, this.y + 6, { color: BORDEAUX });
    this.cap(b.label, L + half, this.y + 6, { color: BORDEAUX });
    let y = this.y + 19;
    la.forEach((l, i) => this.text(l, L, y + i * 12));
    lb.forEach((l, i) => this.text(l, L + half, y + i * 12));
    y += Math.max(la.length, lb.length) * 12;
    this.y = y + 6;
  }

  /** Abschnittsbalken (hell-Bordeaux) */
  section(t: string) {
    this.ensure(40);
    this.rect(L, this.y, R - L, 18, SECTION);
    this.rect(L, this.y, 2.2, 18, BORDEAUX);
    this.cap(t, L + 10, this.y + 12, { size: 6.6, color: BORDEAUX });
    this.y += 28;
  }

  heading(t: string, size = 11) {
    this.ensure(30);
    this.text(t, L, this.y + 10, { size, bold: true, color: INK });
    this.y += size + 9;
  }

  para(
    t: string,
    o: { size?: number; color?: ReturnType<typeof rgb>; bold?: boolean; indent?: number } = {},
  ) {
    const size = o.size ?? 9;
    const x = L + (o.indent ?? 0);
    for (const l of this.wrap(t, R - x, size, o.bold)) {
      this.ensure(size + 4);
      this.text(l, x, this.y + size, { size, color: o.color ?? INK, bold: !!o.bold });
      this.y += size + 3.6;
    }
    this.y += 3;
  }

  /**
   * Abschnitte zweispaltig fließen lassen (Auftragsbedingungen kompakt, Ahmed 09.10.: „max. 2 Seiten“).
   * Füllt erst die linke, dann die rechte Spalte, danach neue Seite.
   */
  columns(blocks: { title: string; paragraphs: string[] }[], size = 7.4) {
    const gap = 16;
    const cw = (R - L - gap) / 2;
    const lh = size + 2.4;
    // erst alle Zeilen bilden, dann seitenweise auf zwei Spalten verteilen (letzte Seite ausgeglichen)
    const lines: { t: string; title?: boolean; gapAfter?: number }[] = [];
    for (const b of blocks) {
      for (const l of this.wrap(b.title, cw, size + 0.6, true)) lines.push({ t: l, title: true });
      b.paragraphs.forEach((p, i) => {
        const w = this.wrap(p, cw, size);
        w.forEach((l, j) =>
          lines.push({ t: l, gapAfter: j === w.length - 1 ? (i === b.paragraphs.length - 1 ? 4 : 1.5) : 0 }),
        );
      });
    }
    const height = (ls: typeof lines) => ls.reduce((a, l) => a + lh + (l.gapAfter ?? 0), 0);
    let i = 0;
    while (i < lines.length) {
      const avail = BOTTOM - this.y;
      const rest = lines.slice(i);
      // passt der Rest in zwei Spalten? → in der Mitte (nach Höhe) teilen, sonst linke Spalte voll füllen
      let cut = i;
      if (height(rest) <= avail * 2 - lh * 2) {
        const half = height(rest) / 2;
        let h = 0;
        while (cut < lines.length && h + lh <= half + lh / 2) h += lh + (lines[cut++]!.gapAfter ?? 0);
        // Überschrift nicht allein unten stehen lassen
        while (cut > i && lines[cut - 1]!.title) cut--;
      } else {
        let h = 0;
        while (cut < lines.length && h + lh <= avail) h += lh + (lines[cut++]!.gapAfter ?? 0);
        while (cut > i + 1 && lines[cut - 1]!.title) cut--;
      }
      const draw = (from: number, to: number, x: number) => {
        let y = this.y;
        for (let k = from; k < to; k++) {
          const l = lines[k]!;
          if (y + lh > BOTTOM) return { y, k };
          this.text(l.t, x, y + size, l.title ? { size: size + 0.6, bold: true, color: BORDEAUX } : { size });
          y += lh + (l.gapAfter ?? 0);
        }
        return { y, k: to };
      };
      const left = draw(i, cut, L);
      let end = left.k;
      let rightY = this.y;
      if (end < lines.length) {
        // rechte Spalte: bis zum Seitenende bzw. bis zum Ende
        const r = draw(end, lines.length, L + cw + gap);
        end = r.k;
        rightY = r.y;
      }
      i = end;
      if (i < lines.length) {
        this.newPage();
        continue;
      }
      this.y = Math.max(left.y, rightY);
    }
  }

  muted(t: string) {
    this.para(t, { size: 8.5, color: MUT });
  }

  /** Tabelle mit grauen Kopfbeschriftungen und Bordeaux-Linie; Zellen werden umgebrochen. */
  table(
    cols: FormCol[],
    rows: (string[] | { group: string } | { sum: string[]; strong?: boolean })[],
    o: { size?: number } = {},
  ) {
    const size = o.size ?? 8.5;
    const xs: number[] = [];
    let x = L;
    for (const c of cols) {
      xs.push(x);
      x += c.width;
    }
    const head = () => {
      cols.forEach((c, i) =>
        c.align === 'right'
          ? this.cap(c.label, xs[i]! + c.width - 12, this.y + 8, { size: 6, right: true })
          : this.cap(c.label, xs[i]!, this.y + 8, { size: 6 }),
      );
      this.y += 12;
      this.line(L, R, this.y, INK, 0.5);
      this.y += 4;
    };
    this.ensure(40);
    head();
    for (const r of rows) {
      if ('group' in r) {
        this.ensure(16, head);
        this.text(r.group, L, this.y + 10, { size: 8.4, bold: true, color: INK });
        this.y += 15;
        continue;
      }
      const cells = 'sum' in r ? r.sum : r;
      const strong = 'sum' in r ? !!r.strong : false;
      const wrapped = cols.map((c, i) => this.wrap(cells[i] ?? '', c.width - 6, size, strong));
      const lines = Math.max(1, ...wrapped.map((w) => w.length));
      const h = lines * (size + 3) + 5;
      this.ensure(h, head);
      wrapped.forEach((ls, i) =>
        ls.forEach((l, j) => {
          const y = this.y + size + 2 + j * (size + 3);
          const color = 'sum' in r && !strong && i === 0 ? GREY : INK;
          if (cols[i]!.align === 'right')
            this.right(l, xs[i]! + cols[i]!.width - 12, y, { size, bold: strong, color });
          else
            this.text(l, xs[i]!, y, { size, bold: strong || ('sum' in r && i === cols.length - 1), color });
        }),
      );
      this.y += h;
      this.line(L, R, this.y - 1, RULE, 0.4);
    }
    this.y += 8;
  }

  /** Kennzahl-Kacheln nebeneinander (z. B. Kassenbuch: Anfangsbestand, Einnahmen, Ausgaben, Endbestand) */
  tiles(items: { label: string; value: string; sub?: string; accent?: boolean }[]) {
    const gap = 8;
    const h = 46;
    const w = (R - L - gap * (items.length - 1)) / items.length;
    this.ensure(h + 12);
    items.forEach((t, i) => {
      const x = L + i * (w + gap);
      this.rect(x, this.y, w, h, t.accent ? BORDEAUX : BOX, t.accent ? BORDEAUX : BOX_LINE);
      const c = t.accent ? rgb(1, 1, 1) : GREY;
      this.cap(t.label, x + 10, this.y + 14, { size: 6, color: c });
      this.text(this.fit(t.value, w - 20, 13), x + 10, this.y + 32, {
        size: 13,
        bold: true,
        color: t.accent ? rgb(1, 1, 1) : INK,
      });
      if (t.sub) this.text(this.fit(t.sub, w - 20, 6.5), x + 10, this.y + 41, { size: 6.5, color: c });
    });
    this.y += h + 14;
  }

  /** Hinweiskasten mit Titel (Auftragsbedingungen kurz) */
  noteBox(title: string, lines: string[], boldLines: string[] = []) {
    const size = 8;
    const all = [
      ...lines.flatMap((l) => this.wrap(l, R - L - 24, size).map((t) => ({ t, b: false }))),
      ...boldLines.flatMap((l) => this.wrap(l, R - L - 24, size, true).map((t) => ({ t, b: true }))),
    ];
    const h = 24 + all.length * (size + 3.5) + 6;
    this.ensure(h);
    this.rect(L, this.y, R - L, h, BOX);
    this.rect(L, this.y, 2.2, h, BORDEAUX);
    this.text(title, L + 12, this.y + 15, { size: 8.5, bold: true, color: BORDEAUX });
    all.forEach((l, i) =>
      this.text(l.t, L + 12, this.y + 28 + i * (size + 3.5), {
        size,
        bold: l.b,
        color: l.b ? BORDEAUX : INK,
      }),
    );
    this.y += h + 14;
  }

  /** Unterschriftslinien links/rechts; optional Text über der linken Linie und Unterschriftsbild rechts */
  signatures(
    leftLabel: string,
    rightLabel: string,
    o: { leftText?: string; png?: PDFImage | null; rightText?: string } = {},
  ) {
    this.ensure(58);
    this.y += 30;
    const half = (R - L) / 2;
    if (o.leftText) this.text(o.leftText, L, this.y - 6, { size: 9.5 });
    if (o.png) {
      const s = Math.min(150 / o.png.width, 40 / o.png.height);
      this.page.drawImage(o.png, {
        x: L + half + 12,
        y: H - this.y + 2,
        width: o.png.width * s,
        height: o.png.height * s,
      });
    }
    if (o.rightText) this.text(o.rightText, L + half + 12, this.y - 6, { size: 8 });
    this.line(L, L + half - 30, this.y, INK, 0.5);
    this.line(L + half + 12, R, this.y, INK, 0.5);
    this.text(leftLabel, L, this.y + 12, { size: 7.5, color: MUT });
    this.text(rightLabel, L + half + 12, this.y + 12, { size: 7.5, color: MUT });
    this.y += 26;
  }

  embedPng(bytes: Uint8Array) {
    return this.pdf.embedPng(bytes);
  }

  /** Text auf Breite kürzen (…) */
  fit(t: string, maxW: number, size = 9) {
    if (this.width(t, size) <= maxW) return t;
    let s = t;
    while (s.length > 1 && this.width(`${s}…`, size) > maxW) s = s.slice(0, -1);
    return `${s}…`;
  }

  async save(): Promise<Uint8Array> {
    const pages = this.pdf.getPages();
    pages.forEach((pg, i) => {
      const t = `${this.sideRef} · Seite ${i + 1} von ${pages.length}`;
      pg.drawText(t, { x: W - 22, y: 200, size: 6.2, font: this.reg, color: GREY, rotate: degrees(90) });
    });
    return this.pdf.save({ useObjectStreams: false });
  }
}

export const FORM_COLORS = { BORDEAUX, MUT };
export const FORM_X = { L, R };
export const FORM_Y = { TOP, BOTTOM, H };
