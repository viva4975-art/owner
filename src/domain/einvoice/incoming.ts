import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFString,
  PDFHexString,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';
import { create } from 'xmlbuilder2';
import { unescapeXml } from '../xml.js';

/*
 * Eingehende E-Rechnungen lesen (Rechnungseingang): XRechnung/EN 16931 in UBL (Invoice, CreditNote) oder CII
 * (CrossIndustryInvoice) sowie ZUGFeRD/Factur-X (PDF mit eingebettetem CII-XML). Ergebnis ist ein schlankes,
 * normiertes Abbild für die Vorbelegung des Eingangsformulars – Beträge als ganze Cent (bigint), Daten YYYY-MM-DD.
 * Maßgeblich bleibt das XML (bei ZUGFeRD ist das XML die Rechnung, nicht die PDF-Ansicht).
 * Sicherheit: XML mit DOCTYPE/ENTITY wird abgelehnt (XXE), es wird nichts nachgeladen.
 */

export interface IncomingLine {
  name: string;
  quantityMilli: bigint;
  unitCode: string | null;
  netCents: bigint;
  vatRateBp: number | null;
  category: string | null;
}

export interface IncomingVat {
  category: string;
  rateBp: number;
  baseCents: bigint;
  taxCents: bigint;
  exemptionReason: string | null;
}

export interface IncomingEInvoice {
  syntax: 'UBL' | 'CII';
  /** aus einer ZUGFeRD-PDF? */
  fromPdf: boolean;
  profile: string | null;
  typeCode: string;
  /** Storno/Korrektur/negative Rechnung (381, 384, UBL CreditNote) */
  isCorrection: boolean;
  invoiceNo: string;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  deliveryDate: string | null;
  buyerReference: string | null;
  orderReference: string | null;
  precedingInvoice: string | null;
  seller: {
    name: string;
    vatId: string | null;
    taxNumber: string | null;
    street: string | null;
    postalCode: string | null;
    city: string | null;
    country: string | null;
    email: string | null;
  };
  buyerName: string | null;
  buyerVatId: string | null;
  iban: string | null;
  bic: string | null;
  paymentReference: string | null;
  paymentTerms: string | null;
  skonto: { days: number; percentBp: number } | null;
  netCents: bigint;
  vatCents: bigint;
  grossCents: bigint;
  prepaidCents: bigint;
  payableCents: bigint;
  vat: IncomingVat[];
  /** § 13b: Steuerschuldnerschaft des Leistungsempfängers (Kategorie AE) */
  reverseCharge: boolean;
  lines: IncomingLine[];
  notes: string[];
}

type Node = Record<string, unknown>;

const arr = (v: unknown): Node[] => (v == null ? [] : Array.isArray(v) ? (v as Node[]) : [v as Node]);

/** Namensraum-Präfixe entfernen („ram:Name“ → „Name“), Attribute bleiben „@…“. */
function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v == null || typeof v !== 'object') return v;
  const out: Node = {};
  for (const [k, val] of Object.entries(v as Node)) {
    let key = k;
    if (k.startsWith('@')) {
      if (k.startsWith('@xmlns')) continue;
      key = '@' + k.slice(1).replace(/^[^:]*:/, '');
    } else if (k !== '#') key = k.replace(/^[^:]*:/, '');
    const s = strip(val);
    const prev = out[key];
    out[key] =
      prev === undefined ? s : Array.isArray(prev) ? [...prev, ...(Array.isArray(s) ? s : [s])] : [prev, s];
  }
  return out;
}

const txt = (v: unknown): string | null => {
  if (v == null) return null;
  if (Array.isArray(v)) return txt(v[0]);
  if (typeof v === 'string') return unescapeXml(v).trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object' && '#' in (v as Node)) return txt((v as Node)['#']);
  return null;
};
const attr = (v: unknown, name: string): string | null => {
  const n = Array.isArray(v) ? v[0] : v;
  return n && typeof n === 'object' ? txt((n as Node)[`@${name}`]) : null;
};
const get = (n: unknown, ...path: string[]): unknown => {
  let cur: unknown = n;
  for (const p of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    const c = (Array.isArray(cur) ? cur[0] : cur) as Node | undefined;
    cur = c?.[p];
  }
  return cur;
};
const t = (n: unknown, ...path: string[]) => txt(get(n, ...path));

/** „1234.5“ / „-0.125“ → Cent, kaufmännisch gerundet (half-up, weg von 0). */
export function decimalToCents(raw: string | null, scale = 2): bigint {
  if (!raw) return 0n;
  const m = /^\s*([+-]?)(\d*)(?:\.(\d*))?\s*$/.exec(raw);
  if (!m || (!m[2] && !m[3])) throw new RangeError(`Betrag nicht lesbar: ${raw}`);
  const neg = m[1] === '-';
  const frac = m[3] ?? '';
  const keep = frac.slice(0, scale).padEnd(scale, '0');
  let v = BigInt((m[2] || '0') + keep);
  if (frac.length > scale && Number(frac[scale]) >= 5) v += 1n;
  return neg ? -v : v;
}

const rateBp = (raw: string | null): number | null => (raw == null ? null : Number(decimalToCents(raw)));

function ciiDate(v: unknown): string | null {
  const s = t(v, 'DateTimeString') ?? txt(v);
  if (!s) return null;
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
const isoDate = (s: string | null) => {
  const m = s ? /^(\d{4}-\d{2}-\d{2})/.exec(s) : null;
  return m ? m[1]! : null;
};

/** Maschinenlesbares Skonto (XRechnung: „#SKONTO#TAGE=7#PROZENT=3.00#“), sonst Freitext „3 % … 7 Tage“. */
export function parseSkonto(terms: string | null): { days: number; percentBp: number } | null {
  if (!terms) return null;
  const m = /#SKONTO#TAGE=(\d+)#PROZENT=(\d+(?:\.\d+)?)#/.exec(terms);
  if (m) return { days: Number(m[1]), percentBp: Number(decimalToCents(m[2]!)) };
  const a = /(\d+(?:[.,]\d+)?)\s*%\s*Skonto[^0-9]{0,40}?(\d+)\s*Tage/i.exec(terms);
  const b = a ? null : /(\d+)\s*Tage[^0-9]{0,40}?(\d+(?:[.,]\d+)?)\s*%\s*Skonto/i.exec(terms);
  if (!a && !b) return null;
  const [pct, days] = a ? [a[1]!, a[2]!] : [b![2]!, b![1]!];
  return { days: Number(days), percentBp: Number(decimalToCents(pct.replace(',', '.'))) };
}

const normIban = (s: string | null) => (s ? s.replace(/\s/g, '').toUpperCase() : null);

function parseCii(root: Node): Omit<IncomingEInvoice, 'fromPdf'> {
  const doc = get(root, 'ExchangedDocument');
  const tx = get(root, 'SupplyChainTradeTransaction');
  const agr = get(tx, 'ApplicableHeaderTradeAgreement');
  const set = get(tx, 'ApplicableHeaderTradeSettlement');
  const del = get(tx, 'ApplicableHeaderTradeDelivery');
  const seller = get(agr, 'SellerTradeParty');
  const regs = arr(get(seller, 'SpecifiedTaxRegistration'));
  const reg = (scheme: string) => txt(regs.map((r) => r.ID).find((id) => attr(id, 'schemeID') === scheme));
  const buyerRegs = arr(get(agr, 'BuyerTradeParty', 'SpecifiedTaxRegistration'));
  const sum = get(set, 'SpecifiedTradeSettlementHeaderMonetarySummation');
  const taxTotals = arr(get(sum, 'TaxTotalAmount'));
  const currency = t(set, 'InvoiceCurrencyCode') ?? 'EUR';
  // TaxTotalAmount kann zweimal vorkommen (Rechnungs- und Buchungswährung) → die der Rechnungswährung
  const taxTotal =
    taxTotals.find((x) => attr(x, 'currencyID') === currency) ??
    taxTotals.find((x) => !attr(x, 'currencyID')) ??
    taxTotals[0];
  const means = arr(get(set, 'SpecifiedTradeSettlementPaymentMeans'));
  const withIban = means.find((m) => t(m, 'PayeePartyCreditorFinancialAccount', 'IBANID'));
  const terms = arr(get(set, 'SpecifiedTradePaymentTerms'));
  const termsText =
    terms
      .map((x) => t(x, 'Description'))
      .filter(Boolean)
      .join('\n') || null;
  const vat = arr(get(set, 'ApplicableTradeTax')).map((v) => ({
    category: t(v, 'CategoryCode') ?? 'S',
    rateBp: rateBp(t(v, 'RateApplicablePercent')) ?? 0,
    baseCents: decimalToCents(t(v, 'BasisAmount')),
    taxCents: decimalToCents(t(v, 'CalculatedAmount')),
    exemptionReason: t(v, 'ExemptionReason') ?? t(v, 'ExemptionReasonCode'),
  }));
  const lines = arr(get(tx, 'IncludedSupplyChainTradeLineItem')).map((l) => {
    const tax = get(l, 'SpecifiedLineTradeSettlement', 'ApplicableTradeTax');
    const q = get(l, 'SpecifiedLineTradeDelivery', 'BilledQuantity');
    return {
      name: t(l, 'SpecifiedTradeProduct', 'Name') ?? '',
      quantityMilli: decimalToCents(txt(q) ?? '1', 3),
      unitCode: attr(q, 'unitCode'),
      netCents: decimalToCents(
        t(
          l,
          'SpecifiedLineTradeSettlement',
          'SpecifiedTradeSettlementLineMonetarySummation',
          'LineTotalAmount',
        ),
      ),
      vatRateBp: rateBp(t(tax, 'RateApplicablePercent')),
      category: t(tax, 'CategoryCode'),
    };
  });
  const typeCode = t(doc, 'TypeCode') ?? '380';
  const period = get(set, 'BillingSpecifiedPeriod');
  return {
    syntax: 'CII',
    profile: t(root, 'ExchangedDocumentContext', 'GuidelineSpecifiedDocumentContextParameter', 'ID'),
    typeCode,
    isCorrection: ['381', '384', '261', '262', '296', '308', '396', '420', '458', '532'].includes(typeCode),
    invoiceNo: t(doc, 'ID') ?? '',
    issueDate: ciiDate(get(doc, 'IssueDateTime')) ?? '',
    dueDate: terms.map((x) => ciiDate(get(x, 'DueDateDateTime'))).find(Boolean) ?? null,
    currency,
    periodStart: ciiDate(get(period, 'StartDateTime')),
    periodEnd: ciiDate(get(period, 'EndDateTime')),
    deliveryDate: ciiDate(get(del, 'ActualDeliverySupplyChainEvent', 'OccurrenceDateTime')),
    buyerReference: t(agr, 'BuyerReference'),
    orderReference: t(agr, 'BuyerOrderReferencedDocument', 'IssuerAssignedID'),
    precedingInvoice: t(set, 'InvoiceReferencedDocument', 'IssuerAssignedID'),
    seller: {
      name: t(seller, 'Name') ?? '',
      vatId: reg('VA'),
      taxNumber: reg('FC'),
      street: t(seller, 'PostalTradeAddress', 'LineOne'),
      postalCode: t(seller, 'PostalTradeAddress', 'PostcodeCode'),
      city: t(seller, 'PostalTradeAddress', 'CityName'),
      country: t(seller, 'PostalTradeAddress', 'CountryID'),
      email:
        t(seller, 'URIUniversalCommunication', 'URIID') ??
        t(seller, 'DefinedTradeContact', 'EmailURIUniversalCommunication', 'URIID'),
    },
    buyerName: t(agr, 'BuyerTradeParty', 'Name'),
    buyerVatId: txt(buyerRegs.map((r) => r.ID).find((id) => attr(id, 'schemeID') === 'VA')),
    iban: normIban(t(withIban, 'PayeePartyCreditorFinancialAccount', 'IBANID')),
    bic: t(withIban, 'PayeeSpecifiedCreditorFinancialInstitution', 'BICID'),
    paymentReference: t(set, 'PaymentReference'),
    paymentTerms: termsText,
    skonto: parseSkonto(termsText),
    netCents: decimalToCents(t(sum, 'TaxBasisTotalAmount')),
    vatCents: decimalToCents(txt(taxTotal)),
    grossCents: decimalToCents(t(sum, 'GrandTotalAmount')),
    prepaidCents: decimalToCents(t(sum, 'TotalPrepaidAmount')),
    payableCents: decimalToCents(t(sum, 'DuePayableAmount')),
    vat,
    reverseCharge: vat.some((v) => v.category === 'AE'),
    lines,
    notes: arr(get(doc, 'IncludedNote'))
      .flatMap((n) => arr(n.Content).map((c) => txt(c) ?? ''))
      .filter(Boolean),
  };
}

function parseUbl(root: Node, credit: boolean): Omit<IncomingEInvoice, 'fromPdf'> {
  const party = get(root, 'AccountingSupplierParty', 'Party');
  const schemes = arr(get(party, 'PartyTaxScheme'));
  const vatId = txt(schemes.find((s) => t(s, 'TaxScheme', 'ID') === 'VAT')?.CompanyID) ?? null;
  const taxNo = txt(schemes.find((s) => t(s, 'TaxScheme', 'ID') !== 'VAT')?.CompanyID) ?? null;
  const buyerSchemes = arr(get(root, 'AccountingCustomerParty', 'Party', 'PartyTaxScheme'));
  const currency = t(root, 'DocumentCurrencyCode') ?? 'EUR';
  const taxTotals = arr(get(root, 'TaxTotal'));
  const main = taxTotals.find((x) => attr(x.TaxAmount, 'currencyID') === currency) ?? taxTotals[0];
  const total = get(root, 'LegalMonetaryTotal');
  const means = arr(get(root, 'PaymentMeans'));
  const withIban = means.find((m) => t(m, 'PayeeFinancialAccount', 'ID'));
  const termsText =
    arr(get(root, 'PaymentTerms'))
      .map((x) => t(x, 'Note'))
      .filter(Boolean)
      .join('\n') || null;
  const vat = arr(get(main, 'TaxSubtotal')).map((v) => ({
    category: t(v, 'TaxCategory', 'ID') ?? 'S',
    rateBp: rateBp(t(v, 'TaxCategory', 'Percent')) ?? 0,
    baseCents: decimalToCents(t(v, 'TaxableAmount')),
    taxCents: decimalToCents(t(v, 'TaxAmount')),
    exemptionReason:
      t(v, 'TaxCategory', 'TaxExemptionReason') ?? t(v, 'TaxCategory', 'TaxExemptionReasonCode'),
  }));
  const lineKey = credit ? 'CreditNoteLine' : 'InvoiceLine';
  const qtyKey = credit ? 'CreditedQuantity' : 'InvoicedQuantity';
  const lines = arr(get(root, lineKey)).map((l) => {
    const q = get(l, qtyKey);
    return {
      name: t(l, 'Item', 'Name') ?? '',
      quantityMilli: decimalToCents(txt(q) ?? '1', 3),
      unitCode: attr(q, 'unitCode'),
      netCents: decimalToCents(t(l, 'LineExtensionAmount')),
      vatRateBp: rateBp(t(l, 'Item', 'ClassifiedTaxCategory', 'Percent')),
      category: t(l, 'Item', 'ClassifiedTaxCategory', 'ID'),
    };
  });
  const typeCode = t(root, credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode') ?? (credit ? '381' : '380');
  const addr = get(party, 'PostalAddress');
  return {
    syntax: 'UBL',
    profile: t(root, 'CustomizationID'),
    typeCode,
    isCorrection: credit || ['381', '384'].includes(typeCode),
    invoiceNo: t(root, 'ID') ?? '',
    issueDate: isoDate(t(root, 'IssueDate')) ?? '',
    dueDate: isoDate(t(root, 'DueDate')) ?? isoDate(t(root, 'PaymentMeans', 'PaymentDueDate')),
    currency,
    periodStart: isoDate(t(root, 'InvoicePeriod', 'StartDate')),
    periodEnd: isoDate(t(root, 'InvoicePeriod', 'EndDate')),
    deliveryDate: isoDate(t(root, 'Delivery', 'ActualDeliveryDate')),
    buyerReference: t(root, 'BuyerReference'),
    orderReference: t(root, 'OrderReference', 'ID'),
    precedingInvoice: t(root, 'BillingReference', 'InvoiceDocumentReference', 'ID'),
    seller: {
      name: t(party, 'PartyLegalEntity', 'RegistrationName') ?? t(party, 'PartyName', 'Name') ?? '',
      vatId,
      taxNumber: taxNo,
      street: t(addr, 'StreetName'),
      postalCode: t(addr, 'PostalZone'),
      city: t(addr, 'CityName'),
      country: t(addr, 'Country', 'IdentificationCode'),
      email:
        t(party, 'Contact', 'ElectronicMail') ??
        (attr(get(party, 'EndpointID'), 'schemeID') === 'EM' ? t(party, 'EndpointID') : null),
    },
    buyerName:
      t(root, 'AccountingCustomerParty', 'Party', 'PartyLegalEntity', 'RegistrationName') ??
      t(root, 'AccountingCustomerParty', 'Party', 'PartyName', 'Name'),
    buyerVatId: txt(buyerSchemes.find((s) => t(s, 'TaxScheme', 'ID') === 'VAT')?.CompanyID) ?? null,
    iban: normIban(t(withIban, 'PayeeFinancialAccount', 'ID')),
    bic: t(withIban, 'PayeeFinancialAccount', 'FinancialInstitutionBranch', 'ID'),
    paymentReference: t(withIban ?? means[0], 'PaymentID'),
    paymentTerms: termsText,
    skonto: parseSkonto(termsText),
    netCents: decimalToCents(t(total, 'TaxExclusiveAmount')),
    vatCents: decimalToCents(txt(main?.TaxAmount)),
    grossCents: decimalToCents(t(total, 'TaxInclusiveAmount')),
    prepaidCents: decimalToCents(t(total, 'PrepaidAmount')),
    payableCents: decimalToCents(t(total, 'PayableAmount')),
    vat,
    reverseCharge: vat.some((v) => v.category === 'AE'),
    lines,
    notes: arr(root.Note)
      .map((n) => txt(n) ?? '')
      .filter(Boolean),
  };
}

export function parseEInvoiceXml(xml: string): Omit<IncomingEInvoice, 'fromPdf'> {
  const s = xml.replace(/^\uFEFF/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) throw new RangeError('XML mit DTD/Entitäten wird nicht verarbeitet');
  let obj: Node;
  try {
    obj = strip(create(s).end({ format: 'object' })) as Node;
  } catch {
    throw new RangeError('Datei ist kein lesbares XML');
  }
  if (obj.CrossIndustryInvoice) return parseCii(obj.CrossIndustryInvoice as Node);
  if (obj.Invoice) return parseUbl(obj.Invoice as Node, false);
  if (obj.CreditNote) return parseUbl(obj.CreditNote as Node, true);
  throw new RangeError('Keine E-Rechnung (weder XRechnung UBL noch CII/ZUGFeRD)');
}

const XML_NAMES = /^(factur-x|zugferd-invoice|xrechnung|order-x)\.xml$/i;

/** Eingebettete XML-Dateien einer PDF (ZUGFeRD/Factur-X) → [Name, Inhalt]. */
export async function embeddedXml(pdf: Uint8Array): Promise<{ name: string; xml: string }[]> {
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false });
  const ctx = doc.context;
  const specs: PDFDict[] = [];
  const visit = (node: PDFDict | undefined, depth = 0) => {
    if (!node || depth > 20) return;
    const names = node.lookupMaybe(PDFName.of('Names'), PDFArray);
    if (names)
      for (let i = 1; i < names.size(); i += 2) {
        const spec = names.lookupMaybe(i, PDFDict);
        if (spec) specs.push(spec);
      }
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) for (let i = 0; i < kids.size(); i++) visit(kids.lookupMaybe(i, PDFDict), depth + 1);
  };
  const namesDict = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  visit(namesDict?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict));
  const af = doc.catalog.lookupMaybe(PDFName.of('AF'), PDFArray);
  if (af)
    for (let i = 0; i < af.size(); i++) {
      const spec = af.lookupMaybe(i, PDFDict);
      if (spec && !specs.includes(spec)) specs.push(spec);
    }
  const out: { name: string; xml: string }[] = [];
  for (const spec of specs) {
    const nameObj = spec.lookup(PDFName.of('UF')) ?? spec.lookup(PDFName.of('F'));
    const name =
      nameObj instanceof PDFString || nameObj instanceof PDFHexString ? nameObj.decodeText() : 'anhang.xml';
    const ef = spec.lookupMaybe(PDFName.of('EF'), PDFDict);
    const ref = ef?.get(PDFName.of('F')) ?? ef?.get(PDFName.of('UF'));
    const stream = ref ? ctx.lookup(ref) : undefined;
    if (!(stream instanceof PDFRawStream)) continue;
    const bytes = decodePDFRawStream(stream).decode();
    if (!/\.xml$/i.test(name) && !/^\s*(<\?xml|<)/.test(new TextDecoder().decode(bytes.slice(0, 64))))
      continue;
    out.push({ name, xml: new TextDecoder('utf-8').decode(bytes) });
  }
  // bekannte ZUGFeRD-Namen zuerst
  return out.sort((a, b) => Number(XML_NAMES.test(b.name)) - Number(XML_NAMES.test(a.name)));
}

/** Datei (XML oder PDF) lesen. Wirft RangeError mit verständlicher Meldung. */
export async function readEInvoice(bytes: Uint8Array): Promise<IncomingEInvoice> {
  const head = new TextDecoder().decode(bytes.slice(0, 8));
  if (head.startsWith('%PDF')) {
    let files: { name: string; xml: string }[];
    try {
      files = await embeddedXml(bytes);
    } catch {
      throw new RangeError('PDF ist nicht lesbar');
    }
    if (!files.length)
      throw new RangeError(
        'Die PDF enthält keine eingebettete E-Rechnung (kein ZUGFeRD/Factur-X) – bitte als normale Eingangsrechnung erfassen',
      );
    let last: unknown;
    for (const f of files) {
      try {
        return { ...parseEInvoiceXml(f.xml), fromPdf: true };
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof RangeError ? last : new RangeError('Eingebettetes XML ist keine E-Rechnung');
  }
  return { ...parseEInvoiceXml(new TextDecoder('utf-8').decode(bytes)), fromPdf: false };
}

/** Plausibilität: Summen der Steueraufschlüsselung vs. Kopf, Netto + USt = Brutto. Liefert Hinweise. */
export function checkTotals(e: IncomingEInvoice): string[] {
  const w: string[] = [];
  if (!e.invoiceNo) w.push('Rechnungsnummer fehlt');
  if (!e.issueDate) w.push('Rechnungsdatum fehlt');
  if (e.currency !== 'EUR') w.push(`Währung ${e.currency} – bitte Betrag in Euro prüfen`);
  if (e.netCents + e.vatCents !== e.grossCents) w.push('Netto + USt ergibt nicht den Bruttobetrag');
  const base = e.vat.reduce((s, v) => s + v.baseCents, 0n);
  const tax = e.vat.reduce((s, v) => s + v.taxCents, 0n);
  if (e.vat.length && base !== e.netCents) w.push('Steueraufschlüsselung passt nicht zum Nettobetrag');
  if (e.vat.length && tax !== e.vatCents) w.push('Steueraufschlüsselung passt nicht zur Umsatzsteuer');
  const rates = new Set(e.vat.map((v) => v.rateBp));
  if (rates.size > 1) w.push('Mehrere Steuersätze – im Rechnungseingang wird die Summe erfasst');
  if (e.reverseCharge && e.vatCents !== 0n) w.push('§ 13b gekennzeichnet, aber Umsatzsteuer ausgewiesen');
  return w;
}
