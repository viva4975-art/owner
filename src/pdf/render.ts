import { readFile } from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont, type PDFImage, type PDFPage, degrees, rgb } from '@cantoo/pdf-lib';
import QRCode from 'qrcode';
import { formatDateDe } from '../domain/invoice/calc.js';
import {
  type BuyerSnapshot,
  type InvoiceDocument,
  KIND_TITLES,
  type SellerSnapshot,
} from '../domain/invoice/types.js';
import { type Cents, formatEuro } from '../domain/money/money.js';
import {
  REVERSE_CHARGE_NOTE,
  directDebitOf,
  isReverseCharge,
  paymentTermsHuman,
  percentToXml,
} from '../einvoice/mapping.js';

/*
 * Layout nach Fortytools-Rechnung 1038193 (ausgemessen, Koordinaten in pt von oben):
 * Briefpapier als Hintergrundbild, grauer Titelbalken, Tabelle Pos/Text/Menge/Einheit/Einzelpreis/Gesamtpreis,
 * Summen rechts, Zahlungsbedingung, Schlusstext + GiroCode. Folgeseiten mit schmalem Titelbalken.
 */

const ASSETS = new URL('../../assets/', import.meta.url);
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const LEFT = 56.7;
const RIGHT = 542.8;
const CONTENT_BOTTOM = 700; // letzte Grundlinie; darunter beginnt die Fußzeile des Briefpapiers
const BODY = 9; // Schriftgrößen aus Fortytools-PDF über Textbreiten ermittelt
const LH = 12.1; // Zeilenabstand Fließtext/Positionen

const INK = rgb(0.13, 0.13, 0.13);
const GREY = rgb(0.42, 0.42, 0.42);
const BAND = rgb(0.949, 0.949, 0.949);
const RULE = rgb(0.88, 0.88, 0.88);
const PILL = rgb(0.93, 0.93, 0.93);

const COL = { text: 87.3, qty: 364.5, unit: 373.5, price: 465.1, total: 538.8 };
const TEXT_WIDTH = 240;

/** In der PDF wie bei Fortytools: Pauschalen ohne Einheit. */
const PDF_UNITS: Record<string, string> = {
  C62: 'Stk.',
  HUR: 'Std.',
  MON: '',
  LS: '',
  MTK: 'm²',
  DAY: 'Tag',
  E48: '',
};

interface Assets {
  regular: Uint8Array;
  bold: Uint8Array;
  letterhead: Uint8Array;
}
let cache: Assets | null = null;
async function loadAssets(): Promise<Assets> {
  cache ??= {
    regular: await readFile(new URL('fonts/DejaVuSans.ttf', ASSETS)),
    bold: await readFile(new URL('fonts/DejaVuSans-Bold.ttf', ASSETS)),
    letterhead: await readFile(new URL('briefpapier/viva-deluxe-a4.jpg', ASSETS)),
  };
  return cache;
}

/** Schriften (DejaVu, alle europäischen Sonderzeichen) für andere PDF-Erzeuger. */
export async function pdfFonts(): Promise<{ regular: Uint8Array; bold: Uint8Array }> {
  const a = await loadAssets();
  return { regular: a.regular, bold: a.bold };
}

const eur = (c: bigint) => formatEuro(c as Cents);
type Color = ReturnType<typeof rgb>;

/** 1000 → "1,0", 2500 → "2,5", 1250 → "1,25" (mind. eine Nachkommastelle wie Fortytools) */
export function quantityPdf(milli: bigint): string {
  const neg = milli < 0n;
  const abs = neg ? -milli : milli;
  let frac = (abs % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  if (!frac) frac = '0';
  return `${neg ? '-' : ''}${abs / 1000n},${frac}`;
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) line = candidate;
      else {
        if (line) out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

/** EPC-QR-Code ("GiroCode") für SEPA-Überweisungen. */
export function girocodePayload(p: {
  bic: string;
  name: string;
  iban: string;
  amount: Cents;
  reference: string;
}): string {
  const abs = p.amount < 0n ? -p.amount : p.amount;
  const amount = `EUR${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
  return [
    'BCD',
    '002',
    '1',
    'SCT',
    p.bic,
    p.name.slice(0, 70),
    p.iban.replace(/\s/g, ''),
    amount,
    '',
    '',
    p.reference.slice(0, 140),
  ].join('\n');
}

/** Leistungsort und Zeitraum aus dem Positionstext lösen (Text wie Fortytools: „Objekt: Name (Nr.)“, Adresse, „TT.MM.JJJJ bis …“). */
export interface LinePlace {
  key: string;
  title: string;
  address: string | null;
}
export function splitLineDetail(detail: string | null | undefined): {
  place: LinePlace | null;
  period: string | null;
  rest: string | null;
} {
  const rows = (detail ?? '').split('\n');
  let place: LinePlace | null = null;
  let period: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const m = /^Objekt: (.+)$/.exec(r.trim());
    if (m && !place) {
      const next = rows[i + 1]?.trim() ?? '';
      const isAddr = !!next && /\b\d{5}\b/.test(next) && !/^\d{2}\.\d{2}\.\d{4}/.test(next);
      place = { title: m[1]!, address: isAddr ? next : null, key: `${m[1]}|${isAddr ? next : ''}` };
      if (isAddr) i++;
      continue;
    }
    const pm = /^(\d{2}\.\d{2}\.\d{4})( bis (\d{2}\.\d{2}\.\d{4}))?$/.exec(r.trim());
    if (pm && !period) {
      period = pm[3] && pm[3] !== pm[1] ? `${pm[1]} bis ${pm[3]}` : pm[1]!;
      continue;
    }
    rest.push(r);
  }
  const t = rest.join('\n').trim();
  return { place, period, rest: t || null };
}

const periodText = (a: string | null | undefined, b: string | null | undefined) =>
  a ? `${formatDateDe(a)}${b && b !== a ? ` bis ${formatDateDe(b)}` : ''}` : null;
/** „01.09.2026 bis 30.09.2026“ → „01.09.–30.09.2026“ (nur für den Kopf) */
const shortPeriod = (t: string) => t.replace(/^(\d{2}\.\d{2}\.)(\d{4}) bis (\d{2}\.\d{2}\.)\2$/, '$1–$3$2');

class Doc {
  pages: PDFPage[] = [];
  page!: PDFPage;
  y = 0; // Position von oben
  private pageLabels: ((total: number) => void)[] = [];

  constructor(
    private pdf: PDFDocument,
    private regular: PDFFont,
    private bold: PDFFont,
    private letterhead: PDFImage,
    private title: string,
    private watermark?: string,
  ) {}

  text(s: string, x: number, yTop: number, size = BODY, opts: { bold?: boolean; color?: Color } = {}) {
    this.page.drawText(s, {
      x,
      y: PAGE_H - yTop,
      size,
      font: opts.bold ? this.bold : this.regular,
      color: opts.color ?? INK,
    });
  }

  /** Einheit zwischen Menge und Einzelpreis: nie in den Preis schreiben (Fund: „pauschal“ überlappte lange Preise). */
  unit(s: string, x: number, price: string, priceRight: number, yTop: number) {
    const room = priceRight - this.regular.widthOfTextAtSize(price, BODY) - 4 - x;
    let u = s;
    if (this.regular.widthOfTextAtSize(u, BODY) > room && /^pauschal$/i.test(u)) u = 'psch.';
    const w = this.regular.widthOfTextAtSize(u, BODY);
    this.text(u, x, yTop, w > room && room > 0 ? Math.max(6, (BODY * room) / w) : BODY);
  }

  right(s: string, xRight: number, yTop: number, size = BODY, opts: { bold?: boolean; color?: Color } = {}) {
    const font = opts.bold ? this.bold : this.regular;
    this.text(s, xRight - font.widthOfTextAtSize(s, size), yTop, size, opts);
  }

  width(s: string, size = BODY) {
    return this.regular.widthOfTextAtSize(s, size);
  }

  rect(x: number, yTop: number, w: number, h: number, color = BAND, radius = 0) {
    if (!radius) {
      this.page.drawRectangle({ x, y: PAGE_H - yTop - h, width: w, height: h, color });
      return;
    }
    const r = radius;
    const path = `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
    this.page.drawSvgPath(path, { x, y: PAGE_H - yTop, color });
  }

  rule(yTop: number, x1 = LEFT + 6, x2 = RIGHT + 6) {
    this.page.drawLine({
      start: { x: x1, y: PAGE_H - yTop },
      end: { x: x2, y: PAGE_H - yTop },
      thickness: 0.5,
      color: RULE,
    });
  }

  private basePage() {
    this.page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.page.drawImage(this.letterhead, { x: 0, y: 0, width: PAGE_W, height: PAGE_H });
    if (this.watermark) {
      this.page.drawText(this.watermark, {
        x: 130,
        y: 260,
        size: 90,
        font: this.bold,
        color: rgb(0.93, 0.85, 0.88),
        rotate: degrees(45),
      });
    }
  }

  /** Erste Seite: Titelbalken mit Infoblock (Fortytools: 290–346 pt). */
  firstPage(info: [string, string][]) {
    this.basePage();
    const rows = info.length + 1; // + Seite
    const bandTop = 290;
    const bandH = Math.max(56, 18 + rows * 12.6);
    this.rect(0, bandTop, PAGE_W, bandH);
    let y = bandTop + (bandH - rows * 12.6) / 2 + 9;
    // Fortytools: Label bei 402 pt, Wert bei 490 pt. Lange Werte (Leitweg-ID) rücken den Block nach links.
    const valueX = Math.min(490.5, RIGHT - Math.max(...info.map(([, v]) => this.width(v))));
    const labelX = valueX - 88.3;
    // Langer Titel (z. B. „Arbeitsschein AS-2026-0001“) darf nicht in den Infoblock laufen → Schrift verkleinern
    const titleSize = Math.min(
      19.7,
      (19.7 * (labelX - LEFT - 14)) / this.regular.widthOfTextAtSize(this.title, 19.7),
    );
    this.text(this.title, LEFT, bandTop + bandH / 2 + 7, titleSize);
    for (const [k, v] of info) {
      this.text(k, labelX, y);
      this.text(v, valueX, y);
      y += 12.6;
    }
    this.text('Seite', labelX, y);
    const page = this.page;
    const pageNo = this.pages.length;
    const yy = y;
    this.pageLabels.push((total) =>
      page.drawText(`${pageNo} von ${total}`, {
        x: valueX,
        y: PAGE_H - yy,
        size: BODY,
        font: this.regular,
        color: INK,
      }),
    );
    this.y = bandTop + bandH + 42;
  }

  /** Folgeseite: schmaler Titelbalken (Fortytools: 141–182 pt). */
  nextPage() {
    this.basePage();
    this.rect(0, 141, PAGE_W, 41);
    this.text(this.title, LEFT, 168.5, 15.7);
    const page = this.page;
    const pageNo = this.pages.length;
    this.pageLabels.push((total) => {
      const s = `Seite ${pageNo} von ${total}`;
      page.drawText(s, {
        x: RIGHT - this.regular.widthOfTextAtSize(s, BODY),
        y: PAGE_H - 164,
        size: BODY,
        font: this.regular,
        color: INK,
      });
    });
    this.y = 201.7;
  }

  /** Prüft, ob ein Block ab der aktuellen Grundlinie noch auf die Seite passt (sonst Folgeseite). */
  ensure(height: number, onNewPage?: () => void) {
    if (this.y + height - LH > CONTENT_BOTTOM) {
      this.nextPage();
      onNewPage?.();
    }
  }

  /** Absatz zusammenhalten (wie Fortytools: Zahlungsbedingung nicht über zwei Seiten). */
  paragraph(text: string, size = BODY, width = RIGHT - LEFT) {
    const lines = wrap(text, this.regular, size, width);
    this.ensure(lines.length * LH);
    for (const l of lines) {
      this.text(l, LEFT, this.y, size);
      this.y += LH;
    }
  }

  /** GiroCode (EPC-QR) links an der aktuellen Position, mit Hinweistext. */
  girocode(payload: string) {
    const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    const size = 52;
    const cell = size / n;
    const top = this.y + 2;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.modules.get(r, c)) {
          this.page.drawRectangle({
            x: LEFT + c * cell,
            y: PAGE_H - top - (r + 1) * cell,
            width: cell + 0.05,
            height: cell + 0.05,
            color: rgb(0, 0, 0),
          });
        }
      }
    }
    this.text('Einfach Code mit Banking-App scannen und direkt überweisen.', LEFT + size + 3, top + size - 1);
    this.y = top + size + 10;
  }

  /** Absenderzeile + Anschriftfeld (Fortytools: 141,7 / 157,4 pt). */
  address(s: SellerSnapshot, b: BuyerSnapshot) {
    const sender = `${s.legalName} | ${s.street} | ${s.postalCode} ${s.city}`;
    this.text(sender, LEFT, 148, 7);
    // Strich unter der Absenderzeile (wie im Fensterbriefumschlag üblich)
    this.page.drawLine({
      start: { x: LEFT, y: PAGE_H - 150.8 },
      end: { x: LEFT + this.regular.widthOfTextAtSize(sender, 7), y: PAGE_H - 150.8 },
      thickness: 0.5,
      color: INK,
    });
    const addr = [
      b.name,
      b.name2,
      b.contactName ? `z. Hd. ${b.contactName}` : null,
      b.street,
      `${b.postalCode} ${b.city}`,
    ].filter((x): x is string => !!x);
    addr.forEach((l, i) => this.text(l, LEFT, 165.5 + i * 13.2, 10));
  }

  finish() {
    for (const f of this.pageLabels) f(this.pages.length);
  }
}

/** Standardtexte der Rechnung (im Entwurf vorbelegt bzw. angezeigt). */
export const INVOICE_INTRO_DEFAULT =
  'wir danken für Ihren Auftrag und berechnen unsere Leistungen wie folgt:';
export const INVOICE_CLOSING_PAY =
  'Wir bitten um Überweisung auf unser Konto. Für Rückfragen zu dieser Rechnung stehen wir jederzeit gerne zur Verfügung.';
export const INVOICE_CLOSING_NOPAY =
  'Für Rückfragen zu dieser Rechnung stehen wir jederzeit gerne zur Verfügung.';

const DATE_LABEL: Record<InvoiceDocument['kind'], string> = {
  invoice: 'Rechnungsdatum',
  partial: 'Rechnungsdatum',
  final: 'Rechnungsdatum',
  cancellation: 'Stornodatum',
  correction: 'Datum',
};

/** Erzeugt die sichtbare Rechnungs-PDF (Grundlage auch für ZUGFeRD). */
export async function renderInvoicePdf(
  doc: InvoiceDocument,
  opts: {
    watermark?: string;
    /** Für Angebote u. Ä.: eigener Titel statt „Rechnung“ */
    title?: string;
    /** Fette Betreffzeile über der Anrede (z. B. „Objekt: …“ im Angebot) */
    subject?: string;
    /** Infoblock rechts im Titelbalken (ersetzt den Rechnungs-Infoblock) */
    info?: [string, string][];
    /** Text unter den Summen (ersetzt die Zahlungsbedingung) */
    terms?: string;
    /** Schlusssatz (ersetzt „Wir bitten um Überweisung …“) */
    closing?: string;
    /** GiroCode anzeigen (Standard: bei offenen Rechnungsbeträgen) */
    qr?: boolean;
    /** abweichende Einheiten-Texte (z. B. Angebot: LS → „pauschal“) */
    units?: Record<string, string>;
  } = {},
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const assets = await loadAssets();
  const regular = await pdf.embedFont(assets.regular, { subset: false });
  const bold = await pdf.embedFont(assets.bold, { subset: false });
  const letterhead = await pdf.embedJpg(assets.letterhead);

  const title = opts.title ?? `${KIND_TITLES[doc.kind]} ${doc.number}`;
  pdf.setTitle(title);
  pdf.setAuthor(doc.seller.legalName);
  pdf.setSubject(`${title} – ${doc.buyer.name}`);
  pdf.setLanguage('de-DE');
  pdf.setCreator('Viva-Deluxe Betriebs-App');
  pdf.setProducer(doc.seller.legalName);
  pdf.setCreationDate(new Date(`${doc.issueDate}T12:00:00Z`));
  pdf.setModificationDate(new Date(`${doc.issueDate}T12:00:00Z`));

  const s = doc.seller;
  const b = doc.buyer;
  const w = new Doc(pdf, regular, bold, letterhead, title, opts.watermark);

  // ---------------------------------------------------------------- Seite 1: Kopf
  const info: [string, string][] = opts.info ?? [
    [DATE_LABEL[doc.kind], formatDateDe(doc.issueDate)],
    ['Kundennummer', b.customerNo],
  ];
  if (!opts.info) {
    if (b.leitwegId) info.push(['Leitweg-ID', b.leitwegId]);
    if (b.supplierNo) info.push(['Unsere Lieferantennr.', b.supplierNo]);
    if (doc.orderReference) info.push(['Bestellnummer', doc.orderReference]);
    if (doc.customerReference) info.push(['Ihre Referenz', doc.customerReference]);
  }

  // Objekt und Leistungszeitraum: nicht in jeder Position wiederholen (Ahmed 08.10.), sondern im Kopf bzw. als
  // Zwischenüberschrift je Objekt (Sammelrechnung). Angebote mit eigener Betreffzeile bleiben wie bisher.
  const sitePlaces = !opts.subject;
  const parsed = doc.lines.map((l) => splitLineDetail(l.detail));
  const docPeriod = periodText(doc.periodStart, doc.periodEnd);
  const linePeriod = (i: number) =>
    parsed[i]!.period ?? periodText(doc.lines[i]!.periodStart, doc.lines[i]!.periodEnd);
  const headPeriod =
    docPeriod && doc.lines.every((_, i) => !linePeriod(i) || linePeriod(i) === docPeriod) ? docPeriod : null;
  const keys = [...new Set(parsed.map((x) => x.place?.key ?? ''))];
  const siteOfBuyer: LinePlace | null = b.site
    ? {
        key: '',
        title: `${b.site.name} (${b.site.siteNo})`,
        address:
          [b.site.street, [b.site.postalCode, b.site.city].filter(Boolean).join(' ')]
            .filter(Boolean)
            .join(', ') || null,
      }
    : null;
  const onePlace =
    sitePlaces && keys.length <= 1 ? (parsed.find((x) => x.place)?.place ?? siteOfBuyer) : null;
  const grouped = sitePlaces && keys.length > 1;

  // Kopf (Ahmed 08.10.: „alles auf ein Ding hingeklatscht“): im grauen Balken nur Datum, Kundennummer, Seite; alle
  // weiteren Angaben (Leistungsort, Leistungszeitraum, Bestellnummer, Leitweg-ID …) als Raster unter dem Balken.
  const facts: { label: string; lines: string[]; bold?: boolean }[] = [];
  const subjectPlace = opts.subject?.startsWith('Objekt: ') ? opts.subject.slice(8) : null;
  if (onePlace)
    facts.push({
      label: 'Leistungsort / Objekt',
      lines: [onePlace.title, ...(onePlace.address ? [onePlace.address] : [])],
      bold: true,
    });
  else if (subjectPlace) {
    const [t, ...rest] = subjectPlace.split(', ');
    facts.push({
      label: 'Leistungsort / Objekt',
      lines: [t!, ...(rest.length ? [rest.join(', ')] : [])],
      bold: true,
    });
  } else if (grouped)
    facts.push({ label: 'Leistungsort', lines: [`${keys.length} Objekte (siehe Positionen)`] });
  if (headPeriod && sitePlaces) facts.push({ label: 'Leistungszeitraum', lines: [shortPeriod(headPeriod)] });
  for (const [k, v] of info.slice(2)) facts.push({ label: k, lines: [v] });
  w.firstPage(info.slice(0, 2));
  w.address(s, b);

  if (facts.length) {
    // eine Zeile (Ahmed 08.10.): Spaltenbreite nach Inhalt, der Leistungsort bekommt den Rest und bricht um
    const gap = 14;
    const avail = RIGHT - LEFT - gap * (facts.length - 1);
    const LABEL = 6.2;
    const lw = (t: string) => regular.widthOfTextAtSize(t.toUpperCase(), LABEL);
    const plan = (size: number) => {
      const nat = facts.map((f) =>
        Math.max(lw(f.label), ...f.lines.map((t) => (f.bold ? bold : regular).widthOfTextAtSize(t, size))),
      );
      const fixed = facts.reduce((a, f, i) => a + (f.bold ? 0 : nat[i]!), 0);
      const placeW = Math.min(nat[facts.findIndex((f) => f.bold)] ?? 0, avail - fixed);
      return { nat, fixed, placeW };
    };
    let size = BODY;
    let p = plan(size);
    const hasPlace = facts.some((f) => f.bold);
    while (size > 7 && (p.fixed + (hasPlace ? 120 : 0) > avail || (!hasPlace && p.fixed > avail))) {
      size -= 0.5;
      p = plan(size);
    }
    // Rest gleichmäßig verteilen, damit die Zeile die volle Breite nutzt
    const used = p.fixed + (hasPlace ? Math.max(120, p.placeW) : 0);
    const extra = Math.max(0, avail - used) / facts.length;
    const widths = facts.map((f, i) =>
      f.bold ? Math.max(120, p.placeW) + extra : Math.max(lw(f.label), p.nat[i]!) + extra,
    );
    // zu breit trotz kleinster Schrift → anteilig kürzen (Werte brechen um)
    const total = widths.reduce((a, b) => a + b, 0);
    if (total > avail) widths.forEach((wd, i) => (widths[i] = (wd * avail) / total));
    const lh = size + 2.5;
    const y = w.y - 16;
    let x = LEFT;
    let rowH = 0;
    const wrapHard = (t: string, font: PDFFont, colW: number) =>
      wrap(t, font, size, colW).flatMap((l) => {
        if (font.widthOfTextAtSize(l, size) <= colW) return [l];
        const out: string[] = [];
        let cur = '';
        for (const part of l.split(/(?<=-)/)) {
          if (cur && font.widthOfTextAtSize(cur + part, size) > colW) {
            out.push(cur);
            cur = part;
          } else cur += part;
        }
        return cur ? [...out, cur] : out;
      });
    facts.forEach((f, i) => {
      const colW = widths[i]!;
      for (const [k, l] of wrap(f.label.toUpperCase(), regular, LABEL, colW).entries())
        w.text(l, x, y + k * 7.5, LABEL, { color: GREY });
      const head = wrapHard(f.lines[0]!, f.bold ? bold : regular, colW);
      const ls = [...head, ...f.lines.slice(1).flatMap((t) => wrapHard(t, regular, colW))].slice(0, 4);
      ls.forEach((t, k) => w.text(t, x, y + 12 + k * lh, size, { bold: !!f.bold && k < head.length }));
      rowH = Math.max(rowH, 12 + ls.length * lh);
      x += colW + gap;
    });
    w.rule(y + rowH + 4, LEFT, RIGHT);
    w.y = y + rowH + 30;
  }

  // ---------------------------------------------------------------- Anrede & Einleitung
  if (opts.subject && !subjectPlace) {
    for (const l of wrap(opts.subject, bold, BODY, RIGHT - LEFT)) {
      w.text(l, LEFT, w.y, BODY, { bold: true });
      w.y += LH;
    }
    w.y += 10;
  }
  w.text('Sehr geehrte Damen und Herren,', LEFT, w.y);
  w.y += 24;
  if (doc.original) {
    w.paragraph(
      doc.kind === 'cancellation'
        ? `hiermit stornieren wir unsere Rechnung ${doc.original.number} vom ${formatDateDe(doc.original.issueDate)} vollständig.`
        : `hiermit korrigieren wir unsere Rechnung ${doc.original.number} vom ${formatDateDe(doc.original.issueDate)} wie folgt:`,
    );
  } else {
    // aus Fortytools übernommene Texte beginnen selbst mit der Anrede → nicht doppelt
    const intro = doc.introText?.replace(/^\s*Sehr geehrte Damen und Herren,?\s*/i, '').trim();
    w.paragraph(intro || INVOICE_INTRO_DEFAULT);
  }
  w.y += 28;

  // ---------------------------------------------------------------- Tabelle
  const header = () => {
    w.rect(LEFT - 4.7, w.y - 15.5, RIGHT - LEFT + 25, 25, BAND, 8);
    w.text('Pos', 62.3, w.y);
    w.text('Text', COL.text, w.y);
    w.right('Menge', COL.qty, w.y);
    w.text('Einheit', COL.unit, w.y);
    w.right('Einzelpreis', COL.price, w.y);
    w.right('Gesamtpreis', COL.total, w.y);
    w.y += 20;
    w.rule(w.y);
    w.y += 15.6;
  };
  header();
  const multiRate = doc.vatBreakdown.length > 1;
  // Sammelrechnung: Zwischensumme je Objekt (zusammenhängende Positionen gleichen Objekts)
  const groupEnd = new Map<number, { title: string; net: Cents; count: number }>();
  if (grouped) {
    let start = 0;
    for (let i = 1; i <= doc.lines.length; i++) {
      if (i === doc.lines.length || parsed[i]!.place?.key !== parsed[start]!.place?.key) {
        const net = doc.lines.slice(start, i).reduce((a, l) => a + l.netAmount, 0n) as Cents;
        groupEnd.set(i - 1, { title: parsed[start]!.place?.title ?? 'ohne Objekt', net, count: i - start });
        start = i;
      }
    }
  }
  doc.lines.forEach((l, i) => {
    const pd = parsed[i]!;
    if (grouped && (i === 0 || pd.place?.key !== parsed[i - 1]!.place?.key)) {
      const head = pd.place
        ? wrap(
            `${pd.place.title}${pd.place.address ? ` · ${pd.place.address}` : ''}`,
            bold,
            BODY,
            COL.total - COL.text,
          )
        : ['Ohne Objektbezug'];
      w.ensure(head.length * LH + 3 * LH, () => {
        w.y += 15.5;
        header();
      });
      w.y += 4;
      head.forEach((t, k) => w.text(t, COL.text, w.y + k * LH, BODY, { bold: true }));
      w.y += head.length * LH + 2;
    }
    const lp = linePeriod(i);
    const detailLines = sitePlaces
      ? [pd.rest, lp && lp !== headPeriod ? `Leistungszeitraum: ${lp}` : null].filter((x): x is string => !!x)
      : [
          l.detail ?? null,
          l.periodStart && !(l.detail ?? '').includes(formatDateDe(l.periodStart))
            ? `Leistung: ${periodText(l.periodStart, l.periodEnd)}`
            : null,
        ].filter((x): x is string => !!x);
    const textLines = [
      ...wrap(l.description, regular, BODY, TEXT_WIDTH),
      ...detailLines.flatMap((d) => wrap(d, regular, BODY, TEXT_WIDTH)),
    ];
    const descCount = wrap(l.description, regular, BODY, TEXT_WIDTH).length;
    const h = (textLines.length + (multiRate ? 1 : 0)) * LH;
    w.ensure(h + 16, () => {
      w.y += 15.5;
      header();
    });
    const top = w.y;
    w.right(String(l.position), 72.8, top);
    textLines.forEach((t, k) =>
      w.text(t, COL.text, top + k * LH, k < descCount ? BODY : 8.5, k < descCount ? {} : { color: GREY }),
    );
    w.right(quantityPdf(l.quantity), COL.qty, top);
    w.unit(
      opts.units?.[l.unitCode] ?? PDF_UNITS[l.unitCode] ?? l.unitCode,
      COL.unit,
      eur(l.unitPrice),
      COL.price,
      top,
    );
    w.right(eur(l.unitPrice), COL.price, top);
    w.right(eur(l.netAmount), COL.total, top);
    if (multiRate) {
      w.text(`MwSt ${percentToXml(l.vatRate).replace('.', ',')}%`, COL.text, top + textLines.length * LH, 8, {
        color: GREY,
      });
    }
    w.y = top + h - 3;
    w.rule(w.y);
    w.y += 15.6;
    const g = groupEnd.get(i);
    if (g && g.count > 1) {
      w.right(
        `Summe ${g.title.length > 48 ? `${g.title.slice(0, 47)}…` : g.title}`,
        COL.price,
        w.y - 2,
        8.5,
        { color: GREY },
      );
      w.right(eur(g.net), COL.total, w.y - 2, 8.5, { bold: true });
      w.y += 16;
    }
  });

  // ---------------------------------------------------------------- Summen
  const sumRows: [string, string][] = [['Gesamt netto', eur(doc.netTotal)]];
  const rc = isReverseCharge(doc);
  for (const v of doc.vatBreakdown) {
    const rate = percentToXml(v.vatRate).replace('.', ',');
    if (rc) {
      sumRows.push(['Umsatzsteuer (§ 13b UStG)', eur(v.taxAmount)]);
      continue;
    }
    sumRows.push([
      multiRate ? `zzgl. MwSt (${rate}%) auf ${eur(v.taxableAmount)}` : `zzgl. MwSt (${rate}%)`,
      eur(v.taxAmount),
    ]);
  }
  const prepay = doc.prepayments.length > 0;
  w.ensure(19.6 * (sumRows.length + 1) + (prepay ? 19.6 * (doc.prepayments.length + 1) : 0) + 10);
  w.y += 2;
  for (const [k, v] of sumRows) {
    w.right(k, COL.price, w.y);
    w.right(v, COL.total, w.y);
    w.y += 19.6;
  }
  const pill = (label: string, value: string) => {
    w.rect(COL.total - w.width(value) - 12, w.y - 12.2, w.width(value) + 30, 17.5, PILL, 8.5);
    w.right(label, COL.price, w.y);
    w.right(value, COL.total, w.y);
    w.y += 19.6;
  };
  pill('Gesamtbetrag', eur(doc.grossTotal));
  if (prepay) {
    for (const p of doc.prepayments) {
      w.right(
        `abzgl. Abschlag ${p.number} vom ${formatDateDe(p.issueDate)} (darin MwSt ${eur(p.vatAmount)})`,
        COL.price,
        w.y,
      );
      w.right(eur(-p.grossAmount), COL.total, w.y);
      w.y += 19.6;
    }
    pill('Zahlbetrag', eur(doc.payableTotal));
  }

  // ---------------------------------------------------------------- Zahlungsbedingung
  w.y += 7.4;
  if (rc) {
    // Pflichthinweis § 14a Abs. 5 UStG, fett und vor der Zahlungsbedingung
    w.ensure(LH * 2);
    w.text(REVERSE_CHARGE_NOTE, LEFT, w.y, BODY, { bold: true });
    w.y += LH;
    if (doc.buyer.vatId) {
      w.text(`USt-IdNr. des Leistungsempfängers: ${doc.buyer.vatId}`, LEFT, w.y, BODY);
      w.y += LH;
    }
    w.y += 4;
  }
  w.paragraph(opts.terms ?? paymentTermsHuman(doc));
  if (doc.closingText) {
    w.y += 4;
    w.paragraph(doc.closingText);
  }

  // ---------------------------------------------------------------- Schluss + GiroCode
  const bank = s.bankAccounts.find((x) => x.primary) ?? s.bankAccounts[0];
  const withQr =
    !!bank && !directDebitOf(doc) && (opts.qr ?? (doc.payableTotal > 0n && doc.kind !== 'cancellation'));
  const closing = opts.closing
    ? opts.closing
    : doc.payableTotal > 0n
      ? INVOICE_CLOSING_PAY
      : INVOICE_CLOSING_NOPAY;
  w.y += 10;
  w.ensure(2 * LH + (withQr ? 80 : 0));
  w.paragraph(closing);
  if (withQr) {
    w.girocode(
      girocodePayload({
        bic: bank.bic,
        name: s.legalName,
        iban: bank.iban,
        amount: doc.payableTotal,
        reference: doc.number,
      }),
    );
  }

  w.finish();
  return pdf.save({ useObjectStreams: false });
}

/**
 * Brief auf dem Briefpapier mit freier Tabelle (z. B. Mahnung): keine USt-Logik, Beträge fertig formatiert.
 * Spalten: erste links (Text), übrige rechtsbündig an den angegebenen x-Positionen.
 */
export async function renderLetterPdf(p: {
  title: string;
  date: string;
  info: [string, string][];
  seller: SellerSnapshot;
  buyer: BuyerSnapshot;
  intro: string;
  columns: { label: string; x: number; align?: 'left' | 'right' }[];
  rows: string[][];
  sums: [string, string][];
  /** letzte Summenzeile hervorgehoben (entfällt z. B. beim Arbeitsschein) */
  total?: [string, string] | null;
  paragraphs: string[];
  girocode?: { amount: bigint; reference: string } | null;
  watermark?: string;
  /** Anrede (Standard „Sehr geehrte Damen und Herren,“; null = keine) */
  greeting?: string | null;
  /** Unterschriftsfeld, z. B. Abnahme durch den Kunden */
  signature?: { label: string; png: Uint8Array | null; name: string; at: string } | null;
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const assets = await loadAssets();
  const regular = await pdf.embedFont(assets.regular, { subset: false });
  const bold = await pdf.embedFont(assets.bold, { subset: false });
  const letterhead = await pdf.embedJpg(assets.letterhead);
  pdf.setTitle(p.title);
  pdf.setAuthor(p.seller.legalName);
  pdf.setLanguage('de-DE');
  pdf.setCreator('Viva-Deluxe Betriebs-App');
  pdf.setCreationDate(new Date(`${p.date}T12:00:00Z`));
  const w = new Doc(pdf, regular, bold, letterhead, p.title, p.watermark);
  w.firstPage(p.info);
  w.address(p.seller, p.buyer);
  const greeting = p.greeting === undefined ? 'Sehr geehrte Damen und Herren,' : p.greeting;
  if (greeting) {
    w.text(greeting, LEFT, w.y);
    w.y += 24;
  }
  w.paragraph(p.intro);
  w.y += 30;
  const header = () => {
    w.rect(LEFT - 4.7, w.y - 15.5, RIGHT - LEFT + 25, 25, BAND, 8);
    for (const c of p.columns) (c.align === 'left' ? w.text : w.right).call(w, c.label, c.x, w.y);
    w.y += 20;
    w.rule(w.y);
    w.y += 15.6;
  };
  if (p.columns.length) header();
  for (const r of p.columns.length ? p.rows : []) {
    w.ensure(LH + 16, () => {
      w.y += 15.5;
      header();
    });
    p.columns.forEach((c, i) => (c.align === 'left' ? w.text : w.right).call(w, r[i] ?? '', c.x, w.y));
    w.y += LH - 3;
    w.rule(w.y);
    w.y += 15.6;
  }
  const last = p.columns[p.columns.length - 1]?.x ?? RIGHT;
  const labelX = p.columns[p.columns.length - 2]?.x ?? last - 100;
  if (!p.columns.length) w.y -= 30; // reiner Brief ohne Tabelle
  w.ensure(19.6 * (p.sums.length + 1) + 10);
  w.y += 2;
  for (const [k, v] of p.sums) {
    w.right(k, labelX, w.y);
    w.right(v, last, w.y);
    w.y += 19.6;
  }
  if (p.total) {
    const [tl, tv] = p.total;
    w.rect(last - w.width(tv) - 12, w.y - 12.2, w.width(tv) + 30, 17.5, PILL, 8.5);
    w.right(tl, labelX, w.y, BODY, { bold: true });
    w.right(tv, last, w.y, BODY, { bold: true });
  }
  w.y += 26;
  for (const para of p.paragraphs) {
    w.paragraph(para);
    w.y += 6;
  }
  if (p.signature) {
    w.ensure(120);
    w.y += 8;
    w.text(p.signature.label, LEFT, w.y, BODY, { bold: true });
    w.y += 12;
    if (p.signature.png) {
      const img = await pdf.embedPng(p.signature.png);
      const h = 60;
      const wd = Math.min(220, (img.width / img.height) * h);
      w.page.drawImage(img, { x: LEFT, y: PAGE_H - w.y - h, width: wd, height: h });
    }
    w.y += 64;
    w.rule(w.y, LEFT, LEFT + 230);
    w.y += 12;
    w.text(`${p.signature.name}${p.signature.at ? `, ${p.signature.at}` : ''}`, LEFT, w.y, 8, {
      color: GREY,
    });
    w.y += 18;
  }
  const bank = p.seller.bankAccounts.find((x) => x.primary) ?? p.seller.bankAccounts[0];
  if (p.girocode && bank && p.girocode.amount > 0n) {
    w.ensure(80);
    w.girocode(
      girocodePayload({
        bic: bank.bic,
        name: p.seller.legalName,
        iban: bank.iban,
        amount: p.girocode.amount as Cents,
        reference: p.girocode.reference,
      }),
    );
  }
  w.finish();
  return pdf.save({ useObjectStreams: false });
}
