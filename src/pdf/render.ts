import { readFile } from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont, type PDFPage, degrees, rgb } from '@cantoo/pdf-lib';
import { formatDateDe } from '../domain/invoice/calc.js';
import { type InvoiceDocument, KIND_TITLES, UNIT_LABELS } from '../domain/invoice/types.js';
import { type Cents, formatEuro } from '../domain/money/money.js';
import { percentToXml, quantityToXml } from '../einvoice/mapping.js';

const FONT_DIR = new URL('../../assets/fonts/', import.meta.url);
const BORDEAUX = rgb(0x7d / 255, 0x14 / 255, 0x35 / 255);
const GREY = rgb(0.38, 0.38, 0.38);
const BLACK = rgb(0.1, 0.1, 0.1);
const LIGHT = rgb(0.96, 0.93, 0.94);

const mm = (v: number) => (v * 72) / 25.4;
const PAGE_W = mm(210);
const PAGE_H = mm(297);
const LEFT = mm(25);
const RIGHT = PAGE_W - mm(20);
const FOOTER_TOP = mm(30);

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

let fontCache: { regular: Uint8Array; bold: Uint8Array } | null = null;
async function loadFonts() {
  fontCache ??= {
    regular: await readFile(new URL('LiberationSans-Regular.ttf', FONT_DIR)),
    bold: await readFile(new URL('LiberationSans-Bold.ttf', FONT_DIR)),
  };
  return fontCache;
}

function eur(c: Cents) {
  return formatEuro(c);
}

function quantityDe(milli: bigint) {
  return quantityToXml(milli).replace('.', ',');
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate;
      } else {
        if (line) out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

class Writer {
  page!: PDFPage;
  y = 0;
  pageNo = 0;
  constructor(
    private pdf: PDFDocument,
    private fonts: Fonts,
    private doc: InvoiceDocument,
    private watermark?: string,
  ) {}

  newPage() {
    this.page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.pageNo++;
    if (this.watermark) {
      this.page.drawText(this.watermark, {
        x: mm(45),
        y: mm(90),
        size: 90,
        font: this.fonts.bold,
        color: rgb(0.93, 0.85, 0.88),
        rotate: degrees(45),
      });
    }
    this.drawFooter();
    if (this.pageNo > 1) {
      this.text(
        `${KIND_TITLES[this.doc.kind]} ${this.doc.number} – Seite ${this.pageNo}`,
        LEFT,
        PAGE_H - mm(20),
        8,
        GREY,
      );
      this.y = PAGE_H - mm(30);
    }
  }

  text(s: string, x: number, y: number, size = 9.5, color = BLACK, bold = false) {
    this.page.drawText(s, { x, y, size, font: bold ? this.fonts.bold : this.fonts.regular, color });
  }

  textRight(s: string, xRight: number, y: number, size = 9.5, color = BLACK, bold = false) {
    const font = bold ? this.fonts.bold : this.fonts.regular;
    this.text(s, xRight - font.widthOfTextAtSize(s, size), y, size, color, bold);
  }

  ensure(height: number) {
    if (this.y - height < FOOTER_TOP + mm(8)) this.newPage();
  }

  drawFooter() {
    const s = this.doc.seller;
    const cols = [
      [s.legalName, s.street, `${s.postalCode} ${s.city}`, s.phone ? `Tel. ${s.phone}` : '', s.email],
      [
        s.managingDirector ? 'Geschäftsführer:' : '',
        s.managingDirector ?? '',
        s.registerCourt ?? '',
        s.registerNumber ?? '',
        s.vatId ? `USt-IdNr.: ${s.vatId}` : '',
        s.taxNumber ? `Steuernr.: ${s.taxNumber}` : '',
      ],
      ...s.bankAccounts.slice(0, 2).map((b) => [b.name, `IBAN ${b.iban}`, `BIC ${b.bic}`]),
    ];
    this.page.drawLine({
      start: { x: LEFT, y: FOOTER_TOP },
      end: { x: RIGHT, y: FOOTER_TOP },
      thickness: 0.6,
      color: BORDEAUX,
    });
    // Spaltenanteile: Firma, Register, Bank 1, Bank 2
    const shares = [0.27, 0.19, 0.27, 0.27];
    cols.forEach((lines, i) => {
      const x = LEFT + (RIGHT - LEFT) * shares.slice(0, i).reduce((a, b) => a + b, 0);
      lines.filter(Boolean).forEach((l, j) => this.text(l, x, FOOTER_TOP - mm(4) - j * 8.5, 6.6, GREY));
    });
  }
}

/** Erzeugt die sichtbare Rechnungs-PDF (Grundlage auch für ZUGFeRD). */
export async function renderInvoicePdf(
  doc: InvoiceDocument,
  opts: { watermark?: string } = {},
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const raw = await loadFonts();
  const fonts: Fonts = {
    regular: await pdf.embedFont(raw.regular, { subset: false }),
    bold: await pdf.embedFont(raw.bold, { subset: false }),
  };
  const title = `${KIND_TITLES[doc.kind]} ${doc.number}`;
  pdf.setTitle(title);
  pdf.setAuthor(doc.seller.legalName);
  pdf.setSubject(`${title} – ${doc.buyer.name}`);
  pdf.setLanguage('de-DE');
  pdf.setCreator('Viva-Deluxe Betriebs-App');
  pdf.setProducer('Viva-Deluxe Betriebs-App');
  pdf.setCreationDate(new Date(`${doc.issueDate}T12:00:00Z`));
  pdf.setModificationDate(new Date(`${doc.issueDate}T12:00:00Z`));

  const w = new Writer(pdf, fonts, doc, opts.watermark);
  w.newPage();
  const s = doc.seller;
  const b = doc.buyer;

  // Kopf
  w.text('VIVA-DELUXE', LEFT, PAGE_H - mm(22), 20, BORDEAUX, true);
  w.text('Gebäudereinigung · Meisterbetrieb · ISO 9001 / 14001', LEFT, PAGE_H - mm(28), 8.5, GREY);

  // Anschriftfeld (DIN 5008 Form B: 45 mm von oben)
  const addrTop = PAGE_H - mm(45);
  w.text(`${s.legalName} · ${s.street} · ${s.postalCode} ${s.city}`, LEFT, addrTop + mm(2), 6.8, GREY);
  const addr = [
    b.name,
    b.name2,
    b.contactName ? `z. Hd. ${b.contactName}` : null,
    b.street,
    `${b.postalCode} ${b.city}`,
  ].filter((x): x is string => !!x);
  addr.forEach((l, i) => w.text(l, LEFT, addrTop - mm(5) - i * 12, 10));

  // Infoblock rechts
  const info: [string, string][] = [
    [`${KIND_TITLES[doc.kind]}-Nr.`, doc.number],
    ['Datum', formatDateDe(doc.issueDate)],
    ['Kunden-Nr.', b.customerNo],
  ];
  if (b.leitwegId) info.push(['Leitweg-ID', b.leitwegId]);
  if (b.supplierNo) info.push(['Lieferanten-Nr.', b.supplierNo]);
  if (doc.orderReference) info.push(['Bestell-Nr.', doc.orderReference]);
  if (doc.periodStart && doc.periodEnd) {
    info.push(['Leistungszeitraum', `${formatDateDe(doc.periodStart)} – ${formatDateDe(doc.periodEnd)}`]);
  }
  const infoX = mm(125);
  info.forEach(([k, v], i) => {
    const y = addrTop - i * 12;
    w.text(k, infoX, y, 8.5, GREY);
    w.textRight(v, RIGHT, y, 8.5, BLACK, i === 0);
  });

  w.y = addrTop - mm(42);

  // Titel
  w.text(title, LEFT, w.y, 14, BORDEAUX, true);
  w.y -= 16;
  if (doc.original) {
    const verb = doc.kind === 'cancellation' ? 'Storno' : 'Korrektur';
    w.text(
      `${verb} zur Rechnung ${doc.original.number} vom ${formatDateDe(doc.original.issueDate)}`,
      LEFT,
      w.y,
      9.5,
      BLACK,
      true,
    );
    w.y -= 13;
  }
  if (b.site) {
    const place = [b.site.street, [b.site.postalCode, b.site.city].filter(Boolean).join(' ')]
      .filter(Boolean)
      .join(', ');
    w.text(`Objekt ${b.site.siteNo}: ${b.site.name}${place ? ` – ${place}` : ''}`, LEFT, w.y, 9.5);
    w.y -= 13;
  }
  if (doc.introText) {
    w.y -= 4;
    for (const l of wrap(doc.introText, fonts.regular, 9.5, RIGHT - LEFT)) {
      w.ensure(12);
      w.text(l, LEFT, w.y);
      w.y -= 12;
    }
  }
  w.y -= 8;

  // Tabelle
  const col = {
    pos: LEFT + 2,
    desc: LEFT + mm(10),
    qty: mm(130),
    unit: mm(132),
    price: mm(166),
    total: RIGHT - 2,
  };
  const descWidth = col.qty - col.desc - mm(16);
  const header = () => {
    w.page.drawRectangle({ x: LEFT, y: w.y - 4, width: RIGHT - LEFT, height: 15, color: BORDEAUX });
    w.text('Pos.', col.pos, w.y, 8.5, rgb(1, 1, 1), true);
    w.text('Leistung', col.desc, w.y, 8.5, rgb(1, 1, 1), true);
    w.textRight('Menge', col.qty, w.y, 8.5, rgb(1, 1, 1), true);
    w.text('Einheit', col.unit, w.y, 8.5, rgb(1, 1, 1), true);
    w.textRight('Einzelpreis', col.price, w.y, 8.5, rgb(1, 1, 1), true);
    w.textRight('Gesamt', col.total, w.y, 8.5, rgb(1, 1, 1), true);
    w.y -= 18;
  };
  header();
  const multiRate = doc.vatBreakdown.length > 1;
  doc.lines.forEach((l, idx) => {
    const descLines = wrap(l.description, fonts.bold, 9, descWidth);
    const detailLines = l.detail ? wrap(l.detail, fonts.regular, 8, descWidth) : [];
    const h = descLines.length * 11 + detailLines.length * 10 + 6;
    if (w.y - h < FOOTER_TOP + mm(8)) {
      w.newPage();
      header();
    }
    if (idx % 2 === 1) {
      w.page.drawRectangle({ x: LEFT, y: w.y - h + 9, width: RIGHT - LEFT, height: h, color: LIGHT });
    }
    w.text(String(l.position), col.pos, w.y, 9);
    descLines.forEach((t, i) => w.text(t, col.desc, w.y - i * 11, 9, BLACK, true));
    detailLines.forEach((t, i) => w.text(t, col.desc, w.y - descLines.length * 11 - i * 10, 8, GREY));
    w.textRight(quantityDe(l.quantity), col.qty, w.y, 9);
    w.text(UNIT_LABELS[l.unitCode] ?? l.unitCode, col.unit, w.y, 9);
    w.textRight(eur(l.unitPrice), col.price, w.y, 9);
    w.textRight(eur(l.netAmount), col.total, w.y, 9);
    if (multiRate) w.text(`${percentToXml(l.vatRate)} %`, col.total - mm(2), w.y - 10, 7, GREY);
    w.y -= h;
  });

  // Summen
  w.ensure(110);
  w.y -= 4;
  w.page.drawLine({
    start: { x: mm(115), y: w.y + 12 },
    end: { x: RIGHT, y: w.y + 12 },
    thickness: 0.5,
    color: GREY,
  });
  const sumRow = (label: string, value: string, bold = false, color = BLACK) => {
    w.text(label, mm(115), w.y, 9.5, color, bold);
    w.textRight(value, RIGHT - 2, w.y, 9.5, color, bold);
    w.y -= 14;
  };
  sumRow('Summe netto', eur(doc.netTotal));
  for (const v of doc.vatBreakdown) {
    sumRow(
      `zzgl. ${percentToXml(v.vatRate).replace('.', ',')} % USt auf ${eur(v.taxableAmount)}`,
      eur(v.taxAmount),
    );
  }
  sumRow('Gesamtbetrag', eur(doc.grossTotal), true, BORDEAUX);

  if (doc.prepayments.length) {
    w.y -= 4;
    w.text('Abzüglich bereits berechneter Abschläge:', mm(115), w.y, 8.5, GREY, true);
    w.y -= 12;
    for (const p of doc.prepayments) {
      w.ensure(26);
      w.text(`${p.number} vom ${formatDateDe(p.issueDate)}`, mm(115), w.y, 8.5);
      w.textRight(`- ${eur(p.grossAmount)}`, RIGHT - 2, w.y, 8.5);
      w.y -= 10;
      w.text(`(netto ${eur(p.netAmount)}, darin USt ${eur(p.vatAmount)})`, mm(118), w.y, 7.5, GREY);
      w.y -= 12;
    }
    sumRow('Verbleibender Zahlbetrag', eur(doc.payableTotal), true, BORDEAUX);
  }

  // Zahlungs-/Schlusstext
  w.y -= 10;
  const primary = s.bankAccounts.find((x) => x.primary) ?? s.bankAccounts[0];
  const payText =
    doc.payableTotal < 0n
      ? `Der Betrag von ${eur(-doc.payableTotal as Cents)} wird Ihnen erstattet bzw. mit offenen Forderungen verrechnet.`
      : doc.kind === 'cancellation'
        ? 'Diese Stornorechnung hebt die oben genannte Rechnung vollständig auf.'
        : `Bitte überweisen Sie den Betrag bis zum ${formatDateDe(doc.dueDate)} ohne Abzug` +
          (primary ? ` auf unser Konto bei der ${primary.name}, IBAN ${primary.iban}` : '') +
          `, Verwendungszweck: ${doc.number}.`;
  const texts = [payText, doc.closingText].filter((t): t is string => !!t);
  if (doc.periodStart && doc.periodEnd && !doc.original) {
    texts.push(`Leistungszeitraum ${formatDateDe(doc.periodStart)} bis ${formatDateDe(doc.periodEnd)}.`);
  }
  for (const t of texts) {
    for (const l of wrap(t, fonts.regular, 9, RIGHT - LEFT)) {
      w.ensure(12);
      w.text(l, LEFT, w.y, 9);
      w.y -= 12;
    }
    w.y -= 4;
  }

  return pdf.save({ useObjectStreams: false });
}
