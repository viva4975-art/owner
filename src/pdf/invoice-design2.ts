import { readFile } from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
import {
  PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setCharacterSpacing,
} from '@cantoo/pdf-lib';
import QRCode from 'qrcode';
import { formatDateDe } from '../domain/invoice/calc.js';
import { type InvoiceDocument, KIND_TITLES } from '../domain/invoice/types.js';
import { type Cents, formatEuro } from '../domain/money/money.js';
import { REVERSE_CHARGE_NOTE, isReverseCharge, paymentTermsHuman } from '../einvoice/mapping.js';
import {
  INVOICE_INTRO_DEFAULT,
  addressLines,
  girocodePayload,
  quantityPdf,
  splitLineDetail,
  wrap,
} from './render.js';

/*
 * Gestaltungsvorschläge, Runde 2 (Ahmed 10.10.: „gut, aber nicht perfekt – noch schönere Vorlagen“).
 * Schrift Inter (SIL OFL, in vier Schnitten eingebettet) statt DejaVu, feines Raster, Kapitälchen-Beschriftungen mit
 * Sperrung, Haarlinien statt Kästen, Zahlen rechtsbündig. Drei Varianten auf dem Briefpapier:
 *   edel    – ruhig und hochwertig: Kopfblock rechts mit großer Nummer und Leistungsort, Summen mit Bordeaux-Kante,
 *             Zahlungsleiste (Zahlungsbedingung · GiroCode; Bankverbindung steht in der Fußzeile)
 *   modern  – „Betrag zuerst“: Bordeaux-Karte mit Rechnungsbetrag und Fälligkeit oben rechts, Positionen als Karten-
 *             Tabelle mit weichem Kopf, Zahlung als heller Kasten
 *   gross   – klar & groß (Schweizer Stil): großer Titel, Angaben als Zeile mit vier Spalten, starke Linien, viel Weiß
 * Angebote: Wertübersicht (monatlich / einmalig) als Kacheln, Ansprechpartner-Karte, Feld „Auftragserteilung“.
 */

export type Design2 = 'edel' | 'modern' | 'gross';

const ASSETS = new URL('../../assets/', import.meta.url);
const W = 595.28;
const H = 841.89;
const L = 56.7;
const R = 538.6;
const BOTTOM = 704;

const INK = rgb(0.1, 0.09, 0.1);
const INK2 = rgb(0.25, 0.23, 0.25);
const GREY = rgb(0.47, 0.45, 0.47);
const FAINT = rgb(0.62, 0.6, 0.62);
const HAIR = rgb(0.86, 0.85, 0.86);
const BRD = rgb(125 / 255, 20 / 255, 53 / 255);
const BRD2 = rgb(0.43, 0.06, 0.18);
const TINT = rgb(0.982, 0.955, 0.965);
const SOFT = rgb(0.972, 0.968, 0.97);
const WHITE = rgb(1, 1, 1);
type Color = ReturnType<typeof rgb>;
type Weight = 'r' | 'm' | 's' | 'b';

// Inter: kontextabhängige Formen (calt/case) verschieben Klammern/Striche ohne passende Breiten in der PDF → aus
const NOFEAT = { calt: false, case: false, ccmp: false, liga: false, kern: true } as const;

const eur = (c: bigint) => formatEuro(c as Cents);
const UNITS: Record<string, string> = {
  C62: 'Stk.',
  HUR: 'Std.',
  MON: 'Monat',
  LS: 'pausch.',
  MTK: 'm²',
  DAY: 'Tag',
  E48: '',
};

export interface Design2Options {
  variant: Design2;
  title?: string;
  info?: [string, string][];
  subject?: string;
  terms?: string;
  closing?: string;
  qr?: boolean;
  totalsSplit?: { label: string; net: bigint; vat: bigint; gross: bigint }[];
  contact?: { name: string; role?: string; phone?: string | null; email?: string | null };
  acceptance?: boolean;
  validUntil?: string;
}

class P {
  pages: PDFPage[] = [];
  page!: PDFPage;
  y = 0;
  labels: ((n: number) => void)[] = [];
  constructor(
    private pdf: PDFDocument,
    private f: Record<Weight, PDFFont>,
    private lh: PDFImage,
    private running: string,
  ) {}
  font(w: Weight = 'r') {
    return this.f[w];
  }
  add() {
    this.page = this.pdf.addPage([W, H]);
    this.pages.push(this.page);
    this.page.drawImage(this.lh, { x: 0, y: 0, width: W, height: H });
  }
  follow(onNew?: () => void) {
    this.add();
    this.text(this.running, L, 142, 9.5, 's');
    const page = this.page;
    const no = this.pages.length;
    this.labels.push((n) => {
      const s = `Seite ${no} von ${n}`;
      page.drawText(s, {
        x: R - this.f.r.widthOfTextAtSize(s, 7.5),
        y: H - 142,
        size: 7.5,
        font: this.f.r,
        color: GREY,
      });
    });
    this.line(L, 150, R, 150, 0.4, HAIR);
    this.y = 176;
    onNew?.();
  }
  ensure(h: number, onNew?: () => void) {
    if (this.y + h > BOTTOM) this.follow(onNew);
  }
  w(s: string, size: number, wt: Weight = 'r', sp = 0) {
    return this.f[wt].widthOfTextAtSize(s, size) + sp * Math.max(0, s.length - 1);
  }
  text(s: string, x: number, y: number, size = 8.6, wt: Weight = 'r', color: Color = INK, sp = 0) {
    if (sp) this.page.pushOperators(pushGraphicsState(), setCharacterSpacing(sp));
    this.page.drawText(s, { x, y: H - y, size, font: this.f[wt], color });
    if (sp) this.page.pushOperators(setCharacterSpacing(0), popGraphicsState());
  }
  right(s: string, xr: number, y: number, size = 8.6, wt: Weight = 'r', color: Color = INK, sp = 0) {
    this.text(s, xr - this.w(s, size, wt, sp), y, size, wt, color, sp);
  }
  /** Kapitälchen-Beschriftung (gesperrt) */
  cap(s: string, x: number, y: number, color: Color = GREY, size = 6.4, right = false) {
    const t = s.toUpperCase();
    if (right) this.right(t, x, y, size, 's', color, 0.7);
    else this.text(t, x, y, size, 's', color, 0.7);
  }
  rect(x: number, y: number, w: number, h: number, color: Color, r = 0) {
    if (!r) {
      this.page.drawRectangle({ x, y: H - y - h, width: w, height: h, color });
      return;
    }
    const p = `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
    this.page.drawSvgPath(p, { x, y: H - y, color });
  }
  frame(x: number, y: number, w: number, h: number, color: Color, r = 0, t = 0.6) {
    if (!r) {
      this.page.drawRectangle({ x, y: H - y - h, width: w, height: h, borderColor: color, borderWidth: t });
      return;
    }
    const p = `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
    this.page.drawSvgPath(p, { x, y: H - y, borderColor: color, borderWidth: t });
  }
  line(x1: number, y1: number, x2: number, y2: number, t = 0.4, color: Color = HAIR) {
    this.page.drawLine({ start: { x: x1, y: H - y1 }, end: { x: x2, y: H - y2 }, thickness: t, color });
  }
  para(s: string, x = L, width = R - L, size = 8.6, wt: Weight = 'r', color: Color = INK2, lead = 12.6) {
    const ls = wrap(s, this.f[wt], size, width);
    this.ensure(ls.length * lead);
    for (const l of ls) {
      this.text(l, x, this.y, size, wt, color);
      this.y += lead;
    }
  }
  qr(payload: string, x: number, y: number, size: number) {
    const q = QRCode.create(payload, { errorCorrectionLevel: 'M' });
    const n = q.modules.size;
    const c = size / n;
    for (let r = 0; r < n; r++)
      for (let k = 0; k < n; k++)
        if (q.modules.get(r, k))
          this.page.drawRectangle({
            x: x + k * c,
            y: H - y - (r + 1) * c,
            width: c + 0.05,
            height: c + 0.05,
            color: INK,
          });
  }
  pageNo(x: number, y: number, size = 8.4, rightAlign = true) {
    const page = this.page;
    const no = this.pages.length;
    this.labels.push((n) => {
      const s = `${no} / ${n}`;
      const xx = rightAlign ? x - this.f.m.widthOfTextAtSize(s, size) : x;
      page.drawText(s, { x: xx, y: H - y, size, font: this.f.m, color: INK });
    });
  }
}

export async function renderInvoiceDesign2(doc: InvoiceDocument, o: Design2Options): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [r, m, s, b, lhB] = await Promise.all([
    readFile(new URL('fonts/inter/Inter-Regular.ttf', ASSETS)),
    readFile(new URL('fonts/inter/Inter-Medium.ttf', ASSETS)),
    readFile(new URL('fonts/inter/Inter-SemiBold.ttf', ASSETS)),
    readFile(new URL('fonts/inter/Inter-Bold.ttf', ASSETS)),
    readFile(new URL('briefpapier/viva-deluxe-a4.jpg', ASSETS)),
  ]);
  const f = {
    r: await pdf.embedFont(r, { subset: false, features: NOFEAT }),
    m: await pdf.embedFont(m, { subset: false, features: NOFEAT }),
    s: await pdf.embedFont(s, { subset: false, features: NOFEAT }),
    b: await pdf.embedFont(b, { subset: false, features: NOFEAT }),
  };
  const lh = await pdf.embedJpg(lhB);
  const v = o.variant;
  const isOffer = !!o.title && !/rechnung/i.test(o.title);
  const kind = isOffer ? o.title!.replace(/\s+\S+$/, '') : KIND_TITLES[doc.kind];
  const no = doc.number;
  const full = `${kind} ${no}`;
  pdf.setTitle(full);
  pdf.setAuthor(doc.seller.legalName);
  pdf.setLanguage('de-DE');
  const p = new P(pdf, f, lh, full);
  const S = doc.seller;
  const B = doc.buyer;

  // ---------------------------------------------------------------- Daten
  const parsed = doc.lines.map((l) => splitLineDetail(l.detail));
  const subjPlace = o.subject?.startsWith('Objekt: ') ? o.subject.slice(8) : null;
  const place =
    parsed.find((x) => x.place)?.place ??
    (B.site
      ? {
          title: `${B.site.name} (${B.site.siteNo})`,
          address: [B.site.street, [B.site.postalCode, B.site.city].filter(Boolean).join(' ')]
            .filter(Boolean)
            .join(', '),
        }
      : subjPlace
        ? { title: subjPlace.split(', ')[0]!, address: subjPlace.split(', ').slice(1).join(', ') }
        : null);
  const period =
    doc.periodStart && doc.periodEnd && doc.periodStart !== doc.periodEnd
      ? `${formatDateDe(doc.periodStart)} – ${formatDateDe(doc.periodEnd)}`
      : doc.periodStart
        ? formatDateDe(doc.periodStart)
        : null;
  const dateLabel = isOffer ? 'Datum' : doc.kind === 'cancellation' ? 'Stornodatum' : 'Rechnungsdatum';
  const meta: [string, string][] = o.info
    ? o.info.filter(([k]) => !/nummer$/i.test(k) || /kunden/i.test(k))
    : [
        [dateLabel, formatDateDe(doc.issueDate)],
        ['Kundennummer', B.customerNo],
        ...(period ? ([['Leistungszeitraum', period]] as [string, string][]) : []),
        ...(B.leitwegId ? ([['Leitweg-ID', B.leitwegId]] as [string, string][]) : []),
        ...(B.supplierNo ? ([['Unsere Lieferantennr.', B.supplierNo]] as [string, string][]) : []),
        ...(doc.orderReference ? ([['Ihre Bestellnummer', doc.orderReference]] as [string, string][]) : []),
      ];
  const due = formatDateDe(doc.dueDate);
  const bank = S.bankAccounts.find((x) => x.primary) ?? S.bankAccounts[0];
  const withQr = !!bank && !isOffer && (o.qr ?? (doc.payableTotal > 0n && doc.kind !== 'cancellation'));
  const rc = isReverseCharge(doc);
  const blocks = o.totalsSplit?.length
    ? o.totalsSplit
    : [{ label: '', net: doc.netTotal, vat: doc.vatTotal, gross: doc.grossTotal }];
  const amountLabel = isOffer ? 'Angebotssumme' : doc.prepayments.length ? 'Zahlbetrag' : 'Rechnungsbetrag';
  const payTotal = doc.prepayments.length ? doc.payableTotal : doc.grossTotal;

  // ---------------------------------------------------------------- Kopf
  p.add();
  const sender = `${S.legalName} · ${S.street} · ${S.postalCode} ${S.city}`;
  p.text(sender, L, 145, 6.2, 'r', GREY);
  p.line(L, 147.5, L + p.w(sender, 6.2), 147.5, 0.35, FAINT);
  for (const [i, l] of addressLines(B, f.r).lines.entries())
    p.text(l.text, L, 162 + i * (l.lead + 0.6), l.size - 0.4, i === 0 ? 'm' : 'r', INK);

  const IX = 340; // Kopfblock rechts
  const metaRows = (y0: number, rows: [string, string][], size = 8.2) => {
    let y = y0;
    for (const [k, val] of rows) {
      p.text(k, IX, y, 7.4, 'r', GREY);
      const vs = wrap(val, f.m, size, R - IX - 82);
      vs.forEach((t, i) => p.right(t, R, y + i * (size + 2.4), size, 'm', INK));
      y += Math.max(1, vs.length) * (size + 2.4) + 2.6;
    }
    p.text('Seite', IX, y, 7.4, 'r', GREY);
    p.pageNo(R, y, size);
    return y;
  };

  if (v === 'edel') {
    p.cap(kind, IX, 140, BRD, 7);
    p.text(no, IX, 162, 20, 's', INK);
    p.line(IX, 171, R, 171, 0.5, INK);
    // Objekt im Kopfblock (Ahmed 10.10.: kein Betreff, Objekt woanders)
    let oy = 185;
    if (place) {
      p.cap(isOffer ? 'Objekt' : 'Leistungsort', IX, oy, BRD, 6.4);
      oy += 11;
      for (const t of wrap(place.title, f.s, 8.6, R - IX)) {
        p.text(t, IX, oy, 8.6, 's', INK);
        oy += 10.6;
      }
      if (place.address)
        for (const t of wrap(place.address, f.r, 7.8, R - IX)) {
          p.text(t, IX, oy, 7.8, 'r', GREY);
          oy += 9.8;
        }
      oy += 5;
      p.line(IX, oy, R, oy, 0.35, HAIR);
      oy += 13;
    }
    p.y = Math.max(262, metaRows(oy, meta) + 24);
  } else if (v === 'modern') {
    // Betrag zuerst: Bordeaux-Karte rechts
    const cardH = 74;
    p.rect(IX - 8, 134, R - IX + 8, cardH, BRD, 8);
    p.cap(isOffer ? `${kind} ${no}` : `${kind} ${no}`, IX + 6, 151, rgb(1, 0.85, 0.9), 6.4);
    p.text(eur(isOffer ? blocks[0]!.gross : payTotal), IX + 6, 177, 19, 's', WHITE);
    p.text(
      isOffer
        ? `${blocks.length > 1 ? `${blocks[0]!.label} brutto · ` : 'brutto · '}gültig bis ${o.validUntil ?? '–'}`
        : doc.payableTotal > 0n
          ? `fällig am ${due}`
          : 'kein Zahlbetrag',
      IX + 6,
      195,
      7.8,
      'm',
      rgb(1, 0.88, 0.92),
    );
    p.y = Math.max(258, metaRows(220, meta, 7.8) + 22);
  } else {
    p.y = Math.max(262, metaRows(146, meta, 8) + 26);
  }

  // Titel / Betreff
  if (v === 'gross') {
    p.text(kind, L, p.y + 4, 26, 's', INK);
    p.right(no, R, p.y + 4, 26, 'r', FAINT);
    p.y += 14;
    p.line(L, p.y, R, p.y, 1.4, INK);
    p.y += 20;
    if (place) {
      p.cap('Leistungsort', L, p.y);
      p.text(place.title, L + 74, p.y, 8.8, 's');
      if (place.address) p.text(place.address, L + 74 + p.w(place.title, 8.8, 's') + 8, p.y, 8.4, 'r', GREY);
      p.y += 24;
    }
  } else {
    const subj = place ? place.title : null;
    if (v === 'edel') {
      void subj; // Objekt steht im Kopfblock
    } else if (place) {
      p.cap(isOffer ? 'Objekt' : 'Leistungsort', L, p.y);
      p.y += 13;
      p.text(place.title, L, p.y, 11, 's');
      if (place.address) p.text(place.address, L + p.w(place.title, 11, 's') + 10, p.y, 8.4, 'r', GREY);
      p.y += 22;
    } else {
      p.text(`${kind} ${no}`, L, p.y, 15, 's');
      p.y += 26;
    }
  }

  // Anrede
  if (o.subject && !subjPlace) {
    p.para(o.subject, L, R - L, 9, 's', INK);
    p.y += 4;
  }
  p.text('Sehr geehrte Damen und Herren,', L, p.y, 8.8, 'r', INK2);
  p.y += 15;
  const intro = doc.original
    ? doc.kind === 'cancellation'
      ? `hiermit stornieren wir unsere Rechnung ${doc.original.number} vom ${formatDateDe(doc.original.issueDate)} vollständig.`
      : `hiermit korrigieren wir unsere Rechnung ${doc.original.number} vom ${formatDateDe(doc.original.issueDate)} wie folgt:`
    : doc.introText?.replace(/^\s*Sehr geehrte Damen und Herren,?\s*/i, '').trim() || INVOICE_INTRO_DEFAULT;
  p.para(intro, L, R - L, 8.8, 'r', INK2, 12.8);
  p.y += 8;

  // Angebot: Wertübersicht als Kacheln
  if (isOffer && blocks.length > 1) {
    p.ensure(52);
    const gap = 10;
    const tw = (R - L - gap * (blocks.length - 1)) / blocks.length;
    blocks.forEach((t, i) => {
      const x = L + i * (tw + gap);
      p.rect(x, p.y, tw, 44, v === 'modern' ? TINT : SOFT, 6);
      p.cap(`${t.label} · netto`, x + 12, p.y + 15, BRD);
      p.text(eur(t.net), x + 12, p.y + 34, 15, 's', INK);
      p.right(`brutto ${eur(t.gross)}`, x + tw - 12, p.y + 34, 7.8, 'r', GREY);
    });
    p.y += 62;
  }

  // ---------------------------------------------------------------- Positionen
  const C = { pos: L + 12, text: L + 22, qty: 350, unit: 356, price: 460, total: R };
  const TW = 240;
  const head = () => {
    const y = p.y;
    if (v === 'modern') p.rect(L - 8, y - 12, R - L + 16, 20, SOFT, 5);
    const col = v === 'modern' ? INK2 : GREY;
    p.cap('Pos.', C.pos, y, col, 6.2, true);
    p.cap(isOffer ? 'Leistung' : 'Leistung', C.text, y, col, 6.2);
    p.cap('Menge', C.qty, y, col, 6.2, true);
    p.cap('Einheit', C.unit, y, col, 6.2);
    p.cap('Einzelpreis', C.price, y, col, 6.2, true);
    p.cap('Betrag', C.total, y, col, 6.2, true);
    if (v === 'edel') p.line(L, y + 6, R, y + 6, 0.5, INK);
    if (v === 'gross') p.line(L, y + 6, R, y + 6, 1, INK);
    p.y = y + 22;
  };
  head();
  doc.lines.forEach((l, i) => {
    const pd = parsed[i]!;
    const d1 = wrap(l.description, f.m, 8.8, TW);
    const d2 = pd.rest ? wrap(pd.rest, f.r, 7.6, TW).slice(0, 8) : [];
    const h = d1.length * 11.6 + d2.length * 10 + 7;
    p.ensure(h + 4, () => head());
    const t = p.y;
    p.right(String(l.position).padStart(2, '0'), C.pos, t, 7.6, 'm', FAINT);
    d1.forEach((x, k) => p.text(x, C.text, t + k * 11.6, 8.8, 'm', INK));
    d2.forEach((x, k) => p.text(x, C.text, t + d1.length * 11.6 + k * 10, 7.6, 'r', GREY));
    p.right(quantityPdf(l.quantity), C.qty, t, 8.6, 'r', INK2);
    p.text(UNITS[l.unitCode] ?? l.unitCode, C.unit, t, 8.2, 'r', GREY);
    p.right(eur(l.unitPrice), C.price, t, 8.6, 'r', INK2);
    p.right(eur(l.netAmount), C.total, t, 8.8, 's', INK);
    p.y = t + h;
    p.line(v === 'modern' ? L - 8 : L, p.y - 8, v === 'modern' ? R + 8 : R, p.y - 8, 0.35, HAIR);
    p.y += 4;
  });

  // ---------------------------------------------------------------- Summen
  const SX = 336;
  const vatLabel = rc ? 'Umsatzsteuer (§ 13b UStG)' : 'zzgl. 19 % Umsatzsteuer';
  const sumH = blocks.length * 64 + doc.prepayments.length * 14 + 6;
  p.ensure(sumH);
  p.y += 6;
  for (const t of blocks) {
    const lab = t.label ? `${t.label} ` : '';
    p.text(`${lab}netto`.replace(/^netto$/, 'Summe netto'), SX, p.y, 8.4, 'r', GREY);
    p.right(eur(t.net), R, p.y, 8.6, 'm', INK2);
    p.y += 14;
    p.text(vatLabel, SX, p.y, 8.4, 'r', GREY);
    p.right(eur(t.vat), R, p.y, 8.6, 'm', INK2);
    p.y += 10;
    const gl = t.label ? `${t.label} brutto` : amountLabel;
    if (v === 'edel') {
      p.rect(SX - 10, p.y, 2.2, 28, BRD);
      p.rect(SX - 7.8, p.y, R - SX + 7.8, 28, TINT);
      p.text(gl, SX, p.y + 18, 9, 's', BRD2);
      p.right(eur(t.gross), R - 6, p.y + 18.5, 13, 's', BRD2);
      p.y += 40;
    } else if (v === 'modern') {
      p.line(SX, p.y + 2, R, p.y + 2, 0.5, INK);
      p.text(gl, SX, p.y + 18, 9.2, 's', INK);
      p.right(eur(t.gross), R, p.y + 18.5, 13, 's', BRD);
      p.y += 34;
    } else {
      p.line(SX, p.y + 2, R, p.y + 2, 1.2, INK);
      p.text(gl, SX, p.y + 19, 10, 's', INK);
      p.right(eur(t.gross), R, p.y + 19.5, 15, 's', INK);
      p.y += 36;
    }
  }
  for (const pp of doc.prepayments) {
    p.text(`abzgl. Abschlag ${pp.number}`, SX, p.y, 8.2, 'r', GREY);
    p.right(eur(-pp.grossAmount), R, p.y, 8.6, 'm');
    p.y += 14;
  }
  if (doc.prepayments.length) {
    p.text('Zahlbetrag', SX, p.y + 4, 10, 's');
    p.right(eur(doc.payableTotal), R, p.y + 4, 13, 's', BRD);
    p.y += 22;
  }
  if (rc) {
    p.y += 4;
    p.para(REVERSE_CHARGE_NOTE, L, R - L, 8.6, 's', INK);
    if (B.vatId) p.para(`USt-IdNr. des Leistungsempfängers: ${B.vatId}`, L, R - L, 8.4);
  }

  // ---------------------------------------------------------------- Zahlung / Konditionen
  const terms = o.terms ?? paymentTermsHuman(doc);
  p.y += 6;
  if (!isOffer) {
    // Bankverbindung steht in der Fußzeile des Briefpapiers → hier nur Zahlungsbedingung, dafür breiter
    const colW = withQr ? R - L - 82 : R - L;
    const tl = wrap(terms, f.r, 8.2, colW - 16);
    const boxH = Math.max(withQr ? 70 : 0, 30 + tl.length * 11);
    p.ensure(boxH + 10);
    const top = p.y;
    if (v === 'modern') p.rect(L - 8, top - 4, R - L + 16, boxH + 4, SOFT, 8);
    else p.line(L, top - 2, R, top - 2, v === 'gross' ? 1 : 0.5, INK);
    const x1 = L;
    p.cap('Zahlung', x1, top + 12, BRD);
    tl.forEach((t, k) => p.text(t, x1, top + 26 + k * 11, 8.2, 'r', INK2));
    if (withQr) {
      const qs = 56;
      const qx = R - qs;
      p.qr(
        girocodePayload({
          bic: bank!.bic,
          name: S.legalName,
          iban: bank!.iban,
          amount: doc.payableTotal,
          reference: no,
        }),
        qx,
        top + 4,
        qs,
      );
      p.right('GiroCode', R, top + qs + 13, 6, 'm', GREY);
    }
    p.y = top + boxH + 14;
  } else {
    p.ensure(30);
    p.para(terms, L, R - L, 8.2, 'r', INK2, 11.8);
    p.y += 6;
  }

  // ---------------------------------------------------------------- Ansprechpartner (Angebot)
  if (o.contact) {
    const c = o.contact;
    p.ensure(46);
    const top = p.y;
    const ini = c.name
      .split(/\s+/)
      .map((x) => x[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
    p.page.drawCircle({ x: L + 15, y: H - top - 15, size: 15, color: TINT });
    p.text(ini, L + 15 - p.w(ini, 9, 's') / 2, top + 18.5, 9, 's', BRD);
    p.cap('Ihr Ansprechpartner', L + 40, top + 9);
    p.text(c.name, L + 40, top + 22, 9.6, 's');
    p.text(
      [c.phone ? `Tel. ${c.phone}` : null, c.email].filter(Boolean).join('   ·   '),
      L + 40,
      top + 34,
      8,
      'r',
      INK2,
    );
    p.y = top + 48;
  }

  // ---------------------------------------------------------------- Schluss
  if (doc.closingText) p.para(doc.closingText, L, R - L, 8.6, 'r', INK2);
  const closing =
    o.closing ??
    (isOffer
      ? ''
      : 'Vielen Dank für Ihren Auftrag. Bei Fragen zu dieser Rechnung sind wir gerne für Sie da.');
  if (closing) {
    const ls = wrap(closing, f.r, 8.6, R - L);
    if (o.closing || p.y + ls.length * 12.6 <= BOTTOM) p.para(closing, L, R - L, 8.6, 'r', INK2);
  }
  if (o.acceptance) {
    const ah = 78;
    p.ensure(ah + 12);
    const top = p.y + 8;
    if (v === 'modern') p.rect(L - 8, top, R - L + 16, ah, SOFT, 8);
    else p.frame(L, top, R - L, ah, v === 'edel' ? BRD : INK, v === 'gross' ? 0 : 6, v === 'gross' ? 1 : 0.6);
    const x = v === 'modern' ? L : L + 12;
    p.cap('Auftragserteilung', x, top + 16, BRD);
    p.text(
      `Hiermit beauftragen wir die Leistungen gemäß Angebot ${no} zu den genannten Bedingungen.`,
      x,
      top + 30,
      8,
      'r',
      INK2,
    );
    const ly = top + ah - 16;
    p.line(x, ly, x + 150, ly, 0.5, GREY);
    p.line(x + 170, ly, R - 12, ly, 0.5, GREY);
    p.text('Ort, Datum', x, ly + 9, 6.6, 'r', GREY);
    p.text('Unterschrift und Firmenstempel', x + 170, ly + 9, 6.6, 'r', GREY);
    p.y = top + ah + 10;
  }

  for (const fn of p.labels) fn(p.pages.length);
  return pdf.save({ useObjectStreams: false });
}
