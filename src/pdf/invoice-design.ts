import { readFile } from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont, type PDFImage, type PDFPage, rgb } from '@cantoo/pdf-lib';
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
 * Gestaltungsvorschläge für Rechnung und Angebot (Ahmed 10.10.: „mehrere Vorschläge, komplett neu, mit unserem
 * Briefkopf“). Gleiche Daten wie die bisherige Rechnung (InvoiceDocument), drei Varianten:
 *   klar     – ruhig, viel Weißraum, Angaben rechts neben der Anschrift, Gesamtbetrag als Bordeaux-Balken
 *   akzent   – Bordeaux-Titelband, Kennzahl-Kacheln (Datum, Kunde, Zeitraum, fällig), Tabelle mit Zebrastreifen
 *   kompakt  – alles auf einer Seite: kleine Schrift, Summen + Zahlung + GiroCode nebeneinander unten
 * Anschrift bleibt im DIN-Fenster (Fensterumschlag), Fußzeile/Briefkopf kommen vom Briefpapier.
 */

export type DesignVariant = 'klar' | 'akzent' | 'kompakt';

const ASSETS = new URL('../../assets/', import.meta.url);
const W = 595.28;
const H = 841.89;
const L = 56.7;
const R = 538.6;
const BOTTOM = 704;

const INK = rgb(0.12, 0.11, 0.12);
const GREY = rgb(0.45, 0.42, 0.44);
const LINE = rgb(0.86, 0.84, 0.85);
const BRD = rgb(125 / 255, 20 / 255, 53 / 255);
const BRD_SOFT = rgb(0.976, 0.937, 0.949);
const ZEBRA = rgb(0.975, 0.972, 0.973);
const WHITE = rgb(1, 1, 1);
type Color = ReturnType<typeof rgb>;

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

export interface DesignOptions {
  variant: DesignVariant;
  title?: string;
  /** Angaben im Kopf (Label, Wert) – ersetzen die Rechnungsangaben */
  info?: [string, string][];
  subject?: string;
  terms?: string;
  closing?: string;
  qr?: boolean;
  totalsSplit?: { label: string; net: bigint; vat: bigint; gross: bigint }[];
  /** Angebot: Ansprechpartner und Feld zur Auftragserteilung */
  contact?: { name: string; phone?: string | null; email?: string | null };
  acceptance?: boolean;
}

interface Style {
  body: number;
  lh: number;
  small: number;
}

class Pager {
  pages: PDFPage[] = [];
  page!: PDFPage;
  y = 0;
  labels: ((n: number) => void)[] = [];
  constructor(
    private pdf: PDFDocument,
    public reg: PDFFont,
    public bold: PDFFont,
    private letterhead: PDFImage,
    private runningTitle: string,
    public st: Style,
  ) {}
  newPage() {
    this.page = this.pdf.addPage([W, H]);
    this.pages.push(this.page);
    this.page.drawImage(this.letterhead, { x: 0, y: 0, width: W, height: H });
  }
  /** Folgeseite mit schmaler Kopfzeile */
  follow(onNew?: () => void) {
    this.newPage();
    this.text(this.runningTitle, L, 142, 11, { bold: true });
    const page = this.page;
    const no = this.pages.length;
    this.labels.push((n) => {
      const s = `Seite ${no} von ${n}`;
      page.drawText(s, {
        x: R - this.reg.widthOfTextAtSize(s, 8),
        y: H - 142,
        size: 8,
        font: this.reg,
        color: GREY,
      });
    });
    this.line(L, 150, R, 150, 0.6, LINE);
    this.y = 176;
    onNew?.();
  }
  ensure(h: number, onNew?: () => void) {
    if (this.y + h > BOTTOM) this.follow(onNew);
  }
  text(s: string, x: number, y: number, size = this.st.body, o: { bold?: boolean; color?: Color } = {}) {
    this.page.drawText(s, { x, y: H - y, size, font: o.bold ? this.bold : this.reg, color: o.color ?? INK });
  }
  right(s: string, xr: number, y: number, size = this.st.body, o: { bold?: boolean; color?: Color } = {}) {
    const f = o.bold ? this.bold : this.reg;
    this.text(s, xr - f.widthOfTextAtSize(s, size), y, size, o);
  }
  w(s: string, size = this.st.body, b = false) {
    return (b ? this.bold : this.reg).widthOfTextAtSize(s, size);
  }
  rect(x: number, y: number, w: number, h: number, color: Color, r = 0) {
    if (!r) {
      this.page.drawRectangle({ x, y: H - y - h, width: w, height: h, color });
      return;
    }
    const p = `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
    this.page.drawSvgPath(p, { x, y: H - y, color });
  }
  frame(x: number, y: number, w: number, h: number, color: Color) {
    this.page.drawRectangle({ x, y: H - y - h, width: w, height: h, borderColor: color, borderWidth: 0.7 });
  }
  line(x1: number, y1: number, x2: number, y2: number, t = 0.5, color: Color = LINE) {
    this.page.drawLine({ start: { x: x1, y: H - y1 }, end: { x: x2, y: H - y2 }, thickness: t, color });
  }
  para(s: string, x = L, width = R - L, size = this.st.body, o: { bold?: boolean; color?: Color } = {}) {
    const ls = wrap(s, o.bold ? this.bold : this.reg, size, width);
    this.ensure(ls.length * this.st.lh);
    for (const l of ls) {
      this.text(l, x, this.y, size, o);
      this.y += this.st.lh;
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
  pageLabelAt(x: number, y: number, size: number, rightAlign = false) {
    const page = this.page;
    const no = this.pages.length;
    this.labels.push((n) => {
      const s = `${no} von ${n}`;
      const xx = rightAlign ? x - this.reg.widthOfTextAtSize(s, size) : x;
      page.drawText(s, { x: xx, y: H - y, size, font: this.reg, color: INK });
    });
  }
}

export async function renderInvoiceDesign(doc: InvoiceDocument, o: DesignOptions): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [regB, boldB, lhB] = await Promise.all([
    readFile(new URL('fonts/DejaVuSans.ttf', ASSETS)),
    readFile(new URL('fonts/DejaVuSans-Bold.ttf', ASSETS)),
    readFile(new URL('briefpapier/viva-deluxe-a4.jpg', ASSETS)),
  ]);
  const reg = await pdf.embedFont(regB, { subset: false });
  const bold = await pdf.embedFont(boldB, { subset: false });
  const lh = await pdf.embedJpg(lhB);
  const v = o.variant;
  const st: Style = v === 'kompakt' ? { body: 8.3, lh: 11, small: 7.2 } : { body: 9, lh: 12.4, small: 7.8 };
  const kindTitle = o.title ? o.title.replace(/\s+\S+$/, '') : KIND_TITLES[doc.kind];
  const number = doc.number;
  const fullTitle = `${kindTitle} ${number}`;
  pdf.setTitle(fullTitle);
  pdf.setAuthor(doc.seller.legalName);
  pdf.setLanguage('de-DE');
  const p = new Pager(pdf, reg, bold, lh, fullTitle, st);
  const s = doc.seller;
  const b = doc.buyer;
  const isOffer = !!o.title && !/rechnung/i.test(o.title);

  // ------------------------------------------------------------ Angaben sammeln
  const parsed = doc.lines.map((l) => splitLineDetail(l.detail));
  const place =
    parsed.find((x) => x.place)?.place ??
    (b.site
      ? {
          title: `${b.site.name} (${b.site.siteNo})`,
          address: [b.site.street, [b.site.postalCode, b.site.city].filter(Boolean).join(' ')]
            .filter(Boolean)
            .join(', '),
        }
      : o.subject?.startsWith('Objekt: ')
        ? {
            title: o.subject.slice(8).split(', ')[0]!,
            address: o.subject.slice(8).split(', ').slice(1).join(', '),
          }
        : null);
  const period =
    doc.periodStart && doc.periodEnd
      ? `${formatDateDe(doc.periodStart)} – ${formatDateDe(doc.periodEnd)}`.replace(
          /^(\d{2}\.\d{2}\.)(\d{4}) – (\d{2}\.\d{2}\.)\2$/,
          '$1–$3$2',
        )
      : doc.periodStart
        ? formatDateDe(doc.periodStart)
        : null;
  const info: [string, string][] = o.info ?? [
    [`${kindTitle}snr.`.replace('Rechnungsnr.', 'Rechnungsnummer'), number],
    [doc.kind === 'cancellation' ? 'Stornodatum' : 'Rechnungsdatum', formatDateDe(doc.issueDate)],
    ['Kundennummer', b.customerNo],
    ...(period ? ([['Leistungszeitraum', period]] as [string, string][]) : []),
    ...(b.leitwegId ? ([['Leitweg-ID', b.leitwegId]] as [string, string][]) : []),
    ...(b.supplierNo ? ([['Unsere Lieferantennr.', b.supplierNo]] as [string, string][]) : []),
    ...(doc.orderReference ? ([['Bestellnummer', doc.orderReference]] as [string, string][]) : []),
  ];
  const due = isOffer ? null : formatDateDe(doc.dueDate);

  // ------------------------------------------------------------ Seite 1: Kopf
  p.newPage();
  const sender = `${s.legalName} · ${s.street} · ${s.postalCode} ${s.city}`;
  p.text(sender, L, 146, 6.6, { color: GREY });
  p.line(L, 148.6, L + p.w(sender, 6.6), 148.6, 0.4, GREY);
  for (const [i, l] of addressLines(b, reg).lines.entries()) p.text(l.text, L, 163 + i * l.lead, l.size);

  const infoX = 352;
  const drawInfo = (rows: [string, string][], y0: number, size: number) => {
    let y = y0;
    for (const [k, val] of rows) {
      p.text(k, infoX, y, st.small, { color: GREY });
      const vs = wrap(val, reg, size, R - infoX - 80);
      vs.forEach((t, i) => p.right(t, R, y + i * (size + 2), size, { bold: k === rows[0]![0] }));
      y += Math.max(1, vs.length) * (size + 2) + 4.5;
    }
    p.text('Seite', infoX, y, st.small, { color: GREY });
    p.pageLabelAt(R, y, size, true);
    return y;
  };

  if (v === 'klar') {
    p.rect(infoX - 12, 138, 2, 96, BRD);
    drawInfo(info, 146, 8.6);
    p.y = 262;
    p.text(kindTitle, L, p.y, 21, { bold: true, color: BRD });
    p.text(number, L + p.w(kindTitle, 21, true) + 10, p.y, 21, { color: INK });
    p.y += 12;
    p.line(L, p.y, R, p.y, 0.6, LINE);
    p.y += 18;
    if (place) {
      p.text('Leistungsort', L, p.y, st.small, { color: GREY });
      p.text(`${place.title}${place.address ? ` · ${place.address}` : ''}`, L + 62, p.y, st.body, {
        bold: true,
      });
      p.y += 22;
    }
  } else if (v === 'akzent') {
    const rest = info.slice(3).filter(([k]) => k !== 'Leistungszeitraum' && k !== 'Gültig bis');
    if (rest.length) drawInfo(rest, 152, 8.4);
    else {
      p.text('Seite', infoX, 152, st.small, { color: GREY });
      p.pageLabelAt(R, 152, 8.4, true);
    }
    p.rect(0, 240, W, 34, BRD);
    p.text(kindTitle.toUpperCase(), L, 262, 14, { bold: true, color: WHITE });
    p.right(`Nr. ${number}`, R, 262, 12, { color: WHITE });
    const tiles: [string, string][] = [
      [info[1]![0], info[1]![1]],
      ['Kundennummer', b.customerNo],
      isOffer
        ? ['Gültig bis', o.info?.find((x) => x[0] === 'Gültig bis')?.[1] ?? '30 Tage']
        : ['Leistungszeitraum', period ?? '–'],
      isOffer ? ['Ansprechpartner', o.contact?.name ?? '–'] : ['Fällig am', due!],
    ];
    const tw = (R - L - 3 * 8) / 4;
    tiles.forEach(([k, val], i) => {
      const x = L + i * (tw + 8);
      p.rect(x, 284, tw, 34, BRD_SOFT, 5);
      p.text(k.toUpperCase(), x + 9, 296, 6.2, { color: BRD });
      let size = 10;
      while (size > 7 && p.w(val, size, true) > tw - 16) size -= 0.5;
      p.text(val, x + 9, 311, size, { bold: true });
    });
    p.y = 338;
    if (place) {
      p.text('LEISTUNGSORT', L, p.y, 6.2, { color: GREY });
      p.text(`${place.title}${place.address ? ` · ${place.address}` : ''}`, L, p.y + 12, st.body, {
        bold: true,
      });
      p.y += 32;
    }
  } else {
    drawInfo(info, 146, 8);
    p.y = 262;
    p.text(fullTitle, L, p.y, 14, { bold: true });
    if (place)
      p.right(`${place.title}${place.address ? `, ${place.address}` : ''}`, R, p.y, 7.8, { color: GREY });
    p.y += 6;
    p.line(L, p.y, R, p.y, 1.2, BRD);
    p.y += 18;
  }

  // ------------------------------------------------------------ Anrede
  if (o.subject && !o.subject.startsWith('Objekt: ')) {
    p.para(o.subject, L, R - L, st.body, { bold: true });
    p.y += 6;
  }
  p.text('Sehr geehrte Damen und Herren,', L, p.y);
  p.y += v === 'kompakt' ? 13 : 16;
  const intro = doc.original
    ? doc.kind === 'cancellation'
      ? `hiermit stornieren wir unsere Rechnung ${doc.original.number} vom ${formatDateDe(doc.original.issueDate)} vollständig.`
      : `hiermit korrigieren wir unsere Rechnung ${doc.original.number} vom ${formatDateDe(doc.original.issueDate)} wie folgt:`
    : doc.introText?.replace(/^\s*Sehr geehrte Damen und Herren,?\s*/i, '').trim() || INVOICE_INTRO_DEFAULT;
  p.para(intro);
  p.y += v === 'kompakt' ? 10 : 14;

  // ------------------------------------------------------------ Tabelle
  const C = { pos: L + 14, text: L + 24, qty: 352, unit: 358, price: 455, total: R };
  const TW = 245;
  const head = () => {
    const hy = p.y;
    if (v === 'akzent') p.rect(L - 6, hy - 12, R - L + 12, 19, BRD_SOFT, 3);
    const hs = v === 'kompakt' ? 6.8 : 7;
    const hc = v === 'akzent' ? BRD : GREY;
    p.right('POS', C.pos, hy, hs, { color: hc, bold: v === 'akzent' });
    p.text('LEISTUNG', C.text, hy, hs, { color: hc, bold: v === 'akzent' });
    p.right('MENGE', C.qty, hy, hs, { color: hc, bold: v === 'akzent' });
    p.text('EINHEIT', C.unit, hy, hs, { color: hc, bold: v === 'akzent' });
    p.right('EINZELPREIS', C.price, hy, hs, { color: hc, bold: v === 'akzent' });
    p.right('GESAMT', C.total, hy, hs, { color: hc, bold: v === 'akzent' });
    if (v === 'klar') p.line(L, hy + 6, R, hy + 6, 1, BRD);
    if (v === 'kompakt') p.line(L, hy + 5, R, hy + 5, 0.6, INK);
    p.y = hy + (v === 'kompakt' ? 16 : 22);
  };
  head();
  doc.lines.forEach((l, i) => {
    const pd = parsed[i]!;
    const desc = wrap(l.description, bold, st.body, TW);
    const detail = (pd.rest ? wrap(pd.rest, reg, st.small, TW) : []).slice(0, 8);
    const rowH = desc.length * st.lh + detail.length * (st.small + 2.6) + (v === 'kompakt' ? 3 : 6);
    p.ensure(rowH + 6, () => head());
    const top = p.y;
    if (v === 'akzent' && i % 2 === 1) p.rect(L - 6, top - 11, R - L + 12, rowH + 2, ZEBRA);
    p.right(String(l.position), C.pos, top, st.body, { color: GREY });
    desc.forEach((t, k) => p.text(t, C.text, top + k * st.lh, st.body, { bold: true }));
    detail.forEach((t, k) =>
      p.text(t, C.text, top + desc.length * st.lh + k * (st.small + 2.6), st.small, { color: GREY }),
    );
    p.right(quantityPdf(l.quantity), C.qty, top);
    p.text(UNITS[l.unitCode] ?? l.unitCode, C.unit, top, st.body, { color: GREY });
    p.right(eur(l.unitPrice), C.price, top);
    p.right(eur(l.netAmount), C.total, top, st.body, { bold: true });
    p.y = top + rowH;
    if (v !== 'akzent') p.line(L, p.y - 8, R, p.y - 8, 0.4, LINE);
    p.y += v === 'kompakt' ? 4 : 6;
  });

  // ------------------------------------------------------------ Summen
  const rc = isReverseCharge(doc);
  const vatLabel = rc ? 'Umsatzsteuer (§ 13b UStG)' : 'zzgl. 19 % MwSt';
  const blocks = o.totalsSplit?.length
    ? o.totalsSplit
    : [{ label: '', net: doc.netTotal, vat: doc.vatTotal, gross: doc.grossTotal }];
  const sumX = 340;
  const bank = s.bankAccounts.find((x) => x.primary) ?? s.bankAccounts[0];
  const withQr = !!bank && (o.qr ?? (doc.payableTotal > 0n && doc.kind !== 'cancellation' && !isOffer));
  const terms = o.terms ?? paymentTermsHuman(doc);

  const sums = (x: number, top: number) => {
    let y = top;
    for (const t of blocks) {
      const lbl = t.label ? `${t.label} ` : '';
      p.text(`${lbl}netto`.replace(/^netto$/, 'Summe netto'), x, y, st.body, { color: GREY });
      p.right(eur(t.net), R, y);
      y += st.lh + 2;
      p.text(vatLabel, x, y, st.body, { color: GREY });
      p.right(eur(t.vat), R, y);
      y += st.lh + 4;
      const gl = t.label
        ? `${t.label} brutto`
        : doc.prepayments.length
          ? 'Gesamtbetrag'
          : isOffer
            ? 'Angebotssumme'
            : 'Rechnungsbetrag';
      if (v === 'klar') {
        p.rect(x - 8, y - 13, R - x + 16, 22, BRD);
        p.text(gl, x, y + 1.5, 10, { bold: true, color: WHITE });
        p.right(eur(t.gross), R - 2, y + 1.5, 11, { bold: true, color: WHITE });
        y += 26;
      } else if (v === 'akzent') {
        p.line(x, y - 9, R, y - 9, 0.8, BRD);
        p.text(gl, x, y + 4, 10, { bold: true, color: BRD });
        p.right(eur(t.gross), R, y + 4, 12.5, { bold: true, color: BRD });
        y += 26;
      } else {
        p.line(x, y - 8, R, y - 8, 0.6, INK);
        p.text(gl, x, y + 2, 9.4, { bold: true });
        p.right(eur(t.gross), R, y + 2, 10, { bold: true });
        y += 20;
      }
    }
    for (const pp of doc.prepayments) {
      p.text(`abzgl. Abschlag ${pp.number}`, x, y, st.body, { color: GREY });
      p.right(eur(-pp.grossAmount), R, y);
      y += st.lh + 2;
    }
    if (doc.prepayments.length) {
      p.text('Zahlbetrag', x, y + 2, 10, { bold: true });
      p.right(eur(doc.payableTotal), R, y + 2, 10.5, { bold: true });
      y += 22;
    }
    return y;
  };
  const sumH =
    blocks.length * (st.lh * 2 + 32) + doc.prepayments.length * 16 + (doc.prepayments.length ? 22 : 0);

  if (v === 'kompakt') {
    // Summen rechts, links daneben Zahlung + Bank, GiroCode – alles auf einer Höhe
    const boxH = Math.max(sumH, 78);
    p.ensure(boxH + 12);
    const top = p.y + 6;
    const endSum = sums(sumX, top);
    let y = top;
    if (rc) {
      for (const t of wrap(REVERSE_CHARGE_NOTE, bold, st.small, sumX - L - 20)) {
        p.text(t, L, y, st.small, { bold: true });
        y += st.small + 3;
      }
    }
    const qrS = withQr ? 54 : 0;
    const tx = L + (withQr ? qrS + 10 : 0);
    if (withQr) {
      p.qr(
        girocodePayload({
          bic: bank.bic,
          name: s.legalName,
          iban: bank.iban,
          amount: doc.payableTotal,
          reference: number,
        }),
        L,
        y - 7,
        qrS,
      );
      p.text('GiroCode', L, y + qrS + 1, 6.2, { color: GREY });
    }
    for (const t of wrap(terms, reg, st.small, sumX - tx - 20)) {
      p.text(t, tx, y, st.small);
      y += st.small + 3;
    }
    if (bank && !isOffer) {
      y += 2;
      p.text(`${bank.name} · BIC ${bank.bic}`, tx, y, 6.6, { color: GREY });
      y += 9;
      p.text(`IBAN ${bank.iban.replace(/(.{4})/g, '$1 ').trim()}`, tx, y, 6.6, { color: GREY });
      y += 9;
      p.text(`Verwendungszweck: ${number}`, tx, y, 6.6, { color: GREY });
      y += 9;
    }
    p.y = Math.max(endSum, y, top + qrS + 10) + 8;
  } else if (v === 'akzent') {
    // Zahlung links als Kasten, Summen rechts daneben
    const bw = sumX - L - 22;
    const qs = withQr ? 58 : 0;
    const tl = wrap(terms, reg, st.small + 0.4, bw - 24 - (qs ? qs + 10 : 0));
    const bh = Math.max(qs + 30, 30 + tl.length * (st.small + 4) + (bank && !isOffer ? 26 : 0), sumH - 6);
    p.ensure(Math.max(bh, sumH) + 12);
    const top = p.y + 4;
    p.rect(L, top, bw, bh, BRD_SOFT, 6);
    p.text(isOffer ? 'KONDITIONEN' : 'ZAHLUNG', L + 12, top + 15, 6.6, { bold: true, color: BRD });
    let y = top + 28;
    for (const t of tl) {
      p.text(t, L + 12, y, st.small + 0.4);
      y += st.small + 4;
    }
    if (bank && !isOffer) {
      y += 3;
      p.text(`${bank.name} · BIC ${bank.bic}`, L + 12, y, 6.6, { color: GREY });
      p.text(`IBAN ${bank.iban.replace(/(.{4})/g, '$1 ').trim()}`, L + 12, y + 9, 6.6, { color: GREY });
      p.text(`Verwendungszweck: ${number}`, L + 12, y + 18, 6.6, { color: GREY });
    }
    if (withQr) {
      const qx = L + bw - qs - 10;
      p.rect(qx - 4, top + 10, qs + 8, qs + 8, WHITE, 3);
      p.qr(
        girocodePayload({
          bic: bank.bic,
          name: s.legalName,
          iban: bank.iban,
          amount: doc.payableTotal,
          reference: number,
        }),
        qx,
        top + 14,
        qs,
      );
    }
    const endSum = sums(sumX, top + 14);
    p.y = Math.max(top + bh, endSum) + 14;
    if (rc) {
      p.para(REVERSE_CHARGE_NOTE, L, R - L, st.body, { bold: true });
      if (b.vatId) p.para(`USt-IdNr. des Leistungsempfängers: ${b.vatId}`);
      p.y += 4;
    }
  } else {
    p.ensure(sumH + 10);
    p.y = sums(sumX, p.y + 8) + 4;
    if (rc) {
      p.para(REVERSE_CHARGE_NOTE, L, R - L, st.body, { bold: true });
      if (b.vatId) p.para(`USt-IdNr. des Leistungsempfängers: ${b.vatId}`);
      p.y += 4;
    }
    // Zahlung: Kasten mit Bedingung, Bankverbindung und GiroCode
    const tw = R - L - (withQr ? 96 : 24);
    const tl = wrap(terms, reg, st.body, tw);
    const extra = bank && !isOffer ? 2 : 0;
    const bh = Math.max(withQr ? 84 : 0, 22 + (tl.length + extra) * st.lh + 8);
    p.ensure(bh + 14);
    const top = p.y + 4;
    if (v === 'klar') {
      p.frame(L, top, R - L, bh, LINE);
      p.rect(L, top, 3, bh, BRD);
    } else p.rect(L, top, R - L, bh, BRD_SOFT, 6);
    p.text(isOffer ? 'KONDITIONEN' : 'ZAHLUNG', L + 14, top + 16, 6.8, { bold: true, color: BRD });
    let y = top + 30;
    for (const t of tl) {
      p.text(t, L + 14, y);
      y += st.lh;
    }
    if (bank && !isOffer) {
      p.text(`${bank.name}  ·  IBAN ${bank.iban}  ·  BIC ${bank.bic}`, L + 14, y + 2, st.small, {
        color: GREY,
      });
      p.text(`Verwendungszweck: ${number}`, L + 14, y + 2 + st.small + 4, st.small, { color: GREY });
    }
    if (withQr) {
      const qs = 62;
      const qx = R - qs - 12;
      p.rect(qx - 4, top + 8, qs + 8, qs + 8, WHITE, 3);
      p.qr(
        girocodePayload({
          bic: bank.bic,
          name: s.legalName,
          iban: bank.iban,
          amount: doc.payableTotal,
          reference: number,
        }),
        qx,
        top + 12,
        qs,
      );
      p.right('GiroCode', qx + qs, top + qs + 22, 6.2, { color: GREY });
    }
    p.y = top + bh + 18;
  }

  // ------------------------------------------------------------ Angebot: Ansprechpartner + Auftragserteilung
  if (o.contact) {
    p.ensure(40);
    const c = o.contact;
    p.text('Ihr Ansprechpartner', L, p.y, st.small, { color: GREY });
    p.y += st.lh;
    p.text(
      [c.name, c.phone ? `Tel. ${c.phone}` : null, c.email].filter(Boolean).join('  ·  '),
      L,
      p.y,
      st.body,
      { bold: true },
    );
    p.y += st.lh + 8;
  }
  if (doc.closingText) p.para(doc.closingText);
  // Rechnung: Zahlungshinweis steht im Kasten – nur ein kurzer Schlusssatz, damit es auf eine Seite passt
  const closing =
    o.closing ??
    (isOffer
      ? ''
      : 'Vielen Dank für Ihren Auftrag. Bei Fragen zu dieser Rechnung sind wir gerne für Sie da.');
  // Rechnung: Dankessatz nur, wenn er noch auf die Seite passt (keine eigene Folgeseite nur dafür)
  const fits = p.y + wrap(closing, reg, st.body, R - L).length * st.lh <= BOTTOM;
  if (closing && (fits || o.closing)) p.para(closing);
  if (o.acceptance) {
    const ah = v === 'kompakt' ? 58 : 74;
    p.ensure(ah + 16);
    const top = p.y + 8;
    p.frame(L, top, R - L, ah, v === 'klar' ? BRD : LINE);
    p.text('AUFTRAGSERTEILUNG', L + 12, top + 15, 6.8, { bold: true, color: BRD });
    p.text(
      `Hiermit beauftragen wir die Leistungen gemäß Angebot ${number} zu den genannten Bedingungen.`,
      L + 12,
      top + 29,
      st.small,
    );
    const ly = top + ah - 14;
    p.line(L + 12, ly, L + 170, ly, 0.5, GREY);
    p.line(L + 190, ly, R - 12, ly, 0.5, GREY);
    p.text('Ort, Datum', L + 12, ly + 9, 6.4, { color: GREY });
    p.text('Unterschrift und Firmenstempel', L + 190, ly + 9, 6.4, { color: GREY });
    p.y = top + ah + 12;
  }
  for (const f of p.labels) f(p.pages.length);
  return pdf.save({ useObjectStreams: false });
}
