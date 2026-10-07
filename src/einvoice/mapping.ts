import type { Invoice } from '@e-invoice-eu/core';
import { type Cents, formatEuro, toXmlDecimal } from '../domain/money/money.js';
import { formatDateDe, percentDe } from '../domain/invoice/calc.js';
import { type InvoiceDocument, KIND_TITLES, KIND_TYPE_CODES } from '../domain/invoice/types.js';

type UBL = Invoice['ubl:Invoice'];

const CUR = 'EUR' as const;
const amt = (c: Cents) => toXmlDecimal(c);

/** Tausendstel → "2.5" (ohne überflüssige Nullen). */
export function quantityToXml(milli: bigint): string {
  const neg = milli < 0n;
  const abs = neg ? -milli : milli;
  const int = abs / 1000n;
  const frac = (abs % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/** Basispunkte → Prozent-String: 1900 → "19", 750 → "7.5" */
export function percentToXml(bp: number): string {
  const int = Math.trunc(bp / 100);
  const frac = String(bp % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return frac ? `${int}.${frac}` : String(int);
}

/** § 13b UStG: Pflichthinweis (§ 14a Abs. 5 UStG) – identisch in PDF und E-Rechnung. */
export const REVERSE_CHARGE_NOTE = 'Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG)';

/** 0 % gibt es bei uns nur als § 13b (Reverse Charge, Kategorie AE); sonst Normalsatz S. */
function taxCategory(vatRate: number) {
  if (vatRate <= 0)
    return { 'cbc:ID': 'AE', 'cbc:Percent': '0', 'cac:TaxScheme': { 'cbc:ID': 'VAT' } } as const;
  return {
    'cbc:ID': 'S',
    'cbc:Percent': percentToXml(vatRate),
    'cac:TaxScheme': { 'cbc:ID': 'VAT' },
  } as const;
}

/** Steuerkategorie in der Steueraufschlüsselung: bei AE mit Befreiungsgrund (BR-AE-10). */
function breakdownCategory(vatRate: number) {
  if (vatRate > 0) return taxCategory(vatRate);
  return {
    'cbc:ID': 'AE',
    'cbc:Percent': '0',
    'cbc:TaxExemptionReasonCode': 'VATEX-EU-AE',
    'cbc:TaxExemptionReason': REVERSE_CHARGE_NOTE,
    'cac:TaxScheme': { 'cbc:ID': 'VAT' },
  } as const;
}

/** § 13b gilt für die ganze Rechnung: keine Mischung aus 0 % und Normalsatz, USt-IdNr. des Kunden Pflicht. */
export function isReverseCharge(doc: Pick<InvoiceDocument, 'lines'>): boolean {
  return doc.lines.length > 0 && doc.lines.every((l) => l.vatRate <= 0);
}
function checkReverseCharge(doc: InvoiceDocument) {
  const zero = doc.lines.filter((l) => l.vatRate <= 0).length;
  if (zero && zero !== doc.lines.length)
    throw new Error('§ 13b gilt für die ganze Rechnung – Positionen mit 0 % und 19 % nicht mischen');
  if (zero && !doc.buyer.vatId) throw new Error('§ 13b: USt-IdNr. des Kunden fehlt');
}

/** Lastschrift nur für zu zahlende Rechnungen (nicht Storno/Korrektur/Erstattung). */
export function directDebitOf(doc: InvoiceDocument) {
  const dd = doc.buyer.directDebit;
  return dd && doc.payableTotal > 0n && ['invoice', 'partial', 'final'].includes(doc.kind) ? dd : null;
}

/** DE12 3456 … → DE12 **** **** **** **12 34 (Vorabankündigung ohne volle IBAN auf Papier) */
export function maskIban(iban: string): string {
  const s = iban.replace(/\s/g, '');
  const masked = s.slice(0, 4) + '*'.repeat(Math.max(0, s.length - 8)) + s.slice(-4);
  return masked.replace(/(.{4})/g, '$1 ').trim();
}

/** Text der Zahlungsbedingung – identisch für PDF und E-Rechnung. */
export function paymentTermsHuman(doc: InvoiceDocument): string {
  const eur = (c: Cents) => formatEuro(c);
  if (doc.payableTotal < 0n) {
    return `Der Betrag von ${eur(-doc.payableTotal as Cents)} wird Ihnen erstattet bzw. mit offenen Forderungen verrechnet.`;
  }
  if (doc.kind === 'cancellation')
    return 'Diese Stornorechnung hebt die oben genannte Rechnung vollständig auf.';
  const dd = directDebitOf(doc);
  if (dd) {
    return (
      `Der Rechnungsbetrag von ${eur(doc.payableTotal)} wird am ${formatDateDe(doc.dueDate)} per SEPA-` +
      `${dd.scheme === 'B2B' ? 'Firmenlastschrift' : 'Lastschrift'} von Ihrem Konto ${maskIban(dd.iban)} eingezogen ` +
      `(Mandatsreferenz ${dd.mandateRef}, Gläubiger-ID ${dd.creditorId}). Bitte sorgen Sie für ausreichende Deckung.`
    );
  }
  if (doc.skonto) {
    const s = doc.skonto;
    return (
      `Zahlbar bis zum ${formatDateDe(s.date)} mit ${percentDe(s.percentBp)}% Skonto ` +
      `(Skontobetrag: ${eur(s.amount)}, Zahlbetrag: ${eur(s.payable)}) oder ohne Abzug bis zum ${formatDateDe(doc.dueDate)}.`
    );
  }
  return `Zahlbar ohne Abzug bis zum ${formatDateDe(doc.dueDate)}.`;
}

/**
 * BT-20: Skonto maschinenlesbar nach XRechnung-Vorgabe (#SKONTO#TAGE=..#PROZENT=..#, Zeilenumbruch),
 * danach der Klartext.
 */
export function paymentTermsText(doc: InvoiceDocument): string {
  const human = paymentTermsHuman(doc);
  if (!doc.skonto || directDebitOf(doc)) return human;
  const pct = (doc.skonto.percentBp / 100).toFixed(2);
  return `#SKONTO#TAGE=${doc.skonto.days}#PROZENT=${pct}#\n${human}`;
}

/**
 * Wandelt eine ausgestellte Rechnung in das (UBL-nahe) Datenmodell von @e-invoice-eu/core.
 * Daraus entstehen XRechnung (UBL) und ZUGFeRD/Factur-X (CII im PDF/A-3).
 */
export function toEInvoice(doc: InvoiceDocument): Invoice {
  const { seller, buyer } = doc;
  const primaryBank = seller.bankAccounts.find((b) => b.primary) ?? seller.bankAccounts[0];
  if (!primaryBank) throw new Error('Keine Bankverbindung im Firmenstamm hinterlegt');
  if (!seller.vatId && !seller.taxNumber)
    throw new Error('USt-ID oder Steuernummer des Rechnungsstellers fehlt');
  if (doc.lines.length === 0) throw new Error('Rechnung ohne Positionen');
  checkReverseCharge(doc);

  const dd = directDebitOf(doc);
  const notes: string[] = [];
  if (doc.kind !== 'invoice') notes.push(KIND_TITLES[doc.kind]);
  // Kundenreferenz zusätzlich als Hinweis, wenn BT-10 schon die Leitweg-ID trägt
  if (doc.customerReference && (doc.buyerReference ?? buyer.leitwegId))
    notes.push(`Ihre Referenz: ${doc.customerReference}`);
  if (doc.introText) notes.push(doc.introText);
  if (doc.closingText) notes.push(doc.closingText);
  if (isReverseCharge(doc)) notes.push(REVERSE_CHARGE_NOTE);
  if (doc.prepayments.length) {
    notes.push(
      'Verrechnete Abschlagsrechnungen: ' +
        doc.prepayments.map((p) => `${p.number} vom ${formatDateDe(p.issueDate)}`).join(', '),
    );
  }

  const billingRefs = [
    ...(doc.original ? [doc.original] : []),
    ...doc.prepayments.map((p) => ({ number: p.number, issueDate: p.issueDate })),
  ].map((r) => ({ 'cac:InvoiceDocumentReference': { 'cbc:ID': r.number, 'cbc:IssueDate': r.issueDate } }));

  const buyerEndpoint = buyer.leitwegId
    ? { 'cbc:EndpointID': buyer.leitwegId, 'cbc:EndpointID@schemeID': '0204' as const }
    : buyer.email
      ? { 'cbc:EndpointID': buyer.email, 'cbc:EndpointID@schemeID': 'EM' as const }
      : {};

  const ubl: UBL = {
    'cbc:ID': doc.number,
    'cbc:IssueDate': doc.issueDate,
    'cbc:DueDate': doc.dueDate,
    'cbc:InvoiceTypeCode': KIND_TYPE_CODES[doc.kind],
    ...(notes.length ? { 'cbc:Note': notes } : {}),
    'cbc:DocumentCurrencyCode': CUR,
    // BT-10 ist in XRechnung Pflicht: Leitweg-ID, sonst Kundennummer.
    'cbc:BuyerReference': doc.buyerReference ?? buyer.leitwegId ?? doc.customerReference ?? buyer.customerNo,
    ...(doc.periodStart && doc.periodEnd
      ? { 'cac:InvoicePeriod': { 'cbc:StartDate': doc.periodStart, 'cbc:EndDate': doc.periodEnd } }
      : {}),
    ...(doc.orderReference ? { 'cac:OrderReference': { 'cbc:ID': doc.orderReference } } : {}),
    ...(billingRefs.length ? { 'cac:BillingReference': billingRefs } : {}),
    'cac:AccountingSupplierParty': {
      'cac:Party': {
        'cbc:EndpointID': seller.email,
        'cbc:EndpointID@schemeID': 'EM',
        ...(buyer.supplierNo || dd
          ? {
              'cac:PartyIdentification': [
                ...(buyer.supplierNo ? [{ 'cbc:ID': buyer.supplierNo }] : []),
                // BT-90 Gläubiger-ID (Lastschrift)
                ...(dd ? [{ 'cbc:ID': dd.creditorId, 'cbc:ID@schemeID': 'SEPA' as const }] : []),
              ],
            }
          : {}),
        'cac:PostalAddress': {
          'cbc:StreetName': seller.street,
          'cbc:CityName': seller.city,
          'cbc:PostalZone': seller.postalCode,
          'cac:Country': { 'cbc:IdentificationCode': seller.countryCode as 'DE' },
        },
        'cac:PartyTaxScheme': [
          ...(seller.vatId ? [{ 'cbc:CompanyID': seller.vatId, 'cac:TaxScheme': { 'cbc:ID': 'VAT' } }] : []),
          ...(seller.taxNumber
            ? [{ 'cbc:CompanyID': seller.taxNumber, 'cac:TaxScheme': { 'cbc:ID': 'FC' } }]
            : []),
        ] as NonNullable<UBL['cac:AccountingSupplierParty']['cac:Party']['cac:PartyTaxScheme']>,
        'cac:PartyLegalEntity': {
          'cbc:RegistrationName': seller.legalName,
          ...(seller.registerNumber
            ? { 'cbc:CompanyID': `${seller.registerCourt ?? ''} ${seller.registerNumber}`.trim() }
            : {}),
          ...(seller.managingDirector
            ? { 'cbc:CompanyLegalForm': `Geschäftsführer: ${seller.managingDirector}` }
            : {}),
        },
        'cac:Contact': {
          'cbc:Name': 'Buchhaltung',
          ...(seller.phone ? { 'cbc:Telephone': seller.phone } : {}),
          'cbc:ElectronicMail': seller.email,
        },
      },
    },
    'cac:AccountingCustomerParty': {
      'cac:Party': {
        ...buyerEndpoint,
        'cac:PartyIdentification': { 'cbc:ID': buyer.customerNo },
        'cac:PostalAddress': {
          'cbc:StreetName': buyer.street,
          ...(buyer.name2 ? { 'cbc:AdditionalStreetName': buyer.name2 } : {}),
          'cbc:CityName': buyer.city,
          'cbc:PostalZone': buyer.postalCode,
          'cac:Country': { 'cbc:IdentificationCode': buyer.countryCode as 'DE' },
        },
        ...(buyer.vatId
          ? { 'cac:PartyTaxScheme': { 'cbc:CompanyID': buyer.vatId, 'cac:TaxScheme': { 'cbc:ID': 'VAT' } } }
          : {}),
        'cac:PartyLegalEntity': { 'cbc:RegistrationName': buyer.name },
        ...(buyer.contactName || buyer.email
          ? {
              'cac:Contact': {
                ...(buyer.contactName ? { 'cbc:Name': buyer.contactName } : {}),
                ...(buyer.email ? { 'cbc:ElectronicMail': buyer.email } : {}),
              },
            }
          : {}),
      },
    },
    // Leistungsdatum/-ort: CII (ZUGFeRD) verlangt das Liefer-Element zwingend.
    'cac:Delivery': {
      'cbc:ActualDeliveryDate': doc.periodEnd ?? doc.issueDate,
      ...(buyer.site
        ? {
            'cac:DeliveryLocation': {
              'cbc:ID': buyer.site.siteNo,
              ...(buyer.site.city
                ? {
                    'cac:Address': {
                      ...(buyer.site.street ? { 'cbc:StreetName': buyer.site.street } : {}),
                      'cbc:CityName': buyer.site.city,
                      ...(buyer.site.postalCode ? { 'cbc:PostalZone': buyer.site.postalCode } : {}),
                      'cac:Country': { 'cbc:IdentificationCode': 'DE' },
                    },
                  }
                : {}),
            },
            'cac:DeliveryParty': { 'cac:PartyName': { 'cbc:Name': buyer.site.name } },
          }
        : {}),
    },
    'cac:PaymentMeans': [
      dd
        ? {
            // 59 = SEPA-Lastschrift: BT-89 Mandatsreferenz, BT-91 belastetes Konto
            'cbc:PaymentMeansCode': '59',
            'cbc:PaymentID': doc.number,
            'cac:PaymentMandate': {
              'cbc:ID': dd.mandateRef,
              'cac:PayerFinancialAccount': { 'cbc:ID': dd.iban },
            },
          }
        : {
            'cbc:PaymentMeansCode': '58',
            'cbc:PaymentID': doc.number,
            'cac:PayeeFinancialAccount': {
              'cbc:ID': primaryBank.iban.replace(/\s/g, ''),
              'cbc:Name': seller.legalName,
              'cac:FinancialInstitutionBranch': { 'cbc:ID': primaryBank.bic },
            },
          },
    ],
    'cac:PaymentTerms': { 'cbc:Note': paymentTermsText(doc) },
    'cac:TaxTotal': [
      {
        'cbc:TaxAmount': amt(doc.vatTotal),
        'cbc:TaxAmount@currencyID': CUR,
        'cac:TaxSubtotal': doc.vatBreakdown.map((v) => ({
          'cbc:TaxableAmount': amt(v.taxableAmount),
          'cbc:TaxableAmount@currencyID': CUR,
          'cbc:TaxAmount': amt(v.taxAmount),
          'cbc:TaxAmount@currencyID': CUR,
          'cac:TaxCategory': breakdownCategory(v.vatRate),
        })),
      },
    ],
    'cac:LegalMonetaryTotal': {
      'cbc:LineExtensionAmount': amt(doc.netTotal),
      'cbc:LineExtensionAmount@currencyID': CUR,
      'cbc:TaxExclusiveAmount': amt(doc.netTotal),
      'cbc:TaxExclusiveAmount@currencyID': CUR,
      'cbc:TaxInclusiveAmount': amt(doc.grossTotal),
      'cbc:TaxInclusiveAmount@currencyID': CUR,
      ...(doc.prepaidTotal !== 0n
        ? { 'cbc:PrepaidAmount': amt(doc.prepaidTotal), 'cbc:PrepaidAmount@currencyID': CUR }
        : {}),
      'cbc:PayableAmount': amt(doc.payableTotal),
      'cbc:PayableAmount@currencyID': CUR,
    } as UBL['cac:LegalMonetaryTotal'],
    'cac:InvoiceLine': doc.lines.map((l) => ({
      'cbc:ID': String(l.position),
      'cbc:InvoicedQuantity': quantityToXml(l.quantity),
      'cbc:InvoicedQuantity@unitCode': l.unitCode as 'C62',
      'cbc:LineExtensionAmount': amt(l.netAmount),
      'cbc:LineExtensionAmount@currencyID': CUR,
      ...(l.periodStart
        ? { 'cac:InvoicePeriod': { 'cbc:StartDate': l.periodStart, 'cbc:EndDate': l.periodEnd ?? l.periodStart } }
        : {}),
      'cac:Item': {
        ...(l.detail ? { 'cbc:Description': l.detail } : {}),
        'cbc:Name': l.description,
        'cac:ClassifiedTaxCategory': taxCategory(l.vatRate),
      },
      'cac:Price': { 'cbc:PriceAmount': amt(l.unitPrice), 'cbc:PriceAmount@currencyID': CUR },
    })) as UBL['cac:InvoiceLine'],
  };

  return { 'ubl:Invoice': ubl };
}
