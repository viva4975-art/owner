import type { Cents, Quantity, VatRate } from '../money/money.js';

export type InvoiceKind = 'invoice' | 'partial' | 'final' | 'cancellation' | 'correction';
export type InvoiceFormat = 'pdf' | 'zugferd' | 'xrechnung';

export interface InvoiceLine {
  position: number;
  description: string;
  detail?: string | null;
  quantity: Quantity;
  unitCode: string;
  unitPrice: Cents;
  netAmount: Cents;
  vatRate: VatRate;
}

export interface BankAccount {
  name: string;
  iban: string;
  bic: string;
  primary?: boolean;
}

export interface SellerSnapshot {
  legalName: string;
  street: string;
  postalCode: string;
  city: string;
  countryCode: string;
  vatId: string | null;
  taxNumber: string | null;
  registerCourt: string | null;
  registerNumber: string | null;
  managingDirector: string | null;
  phone: string | null;
  email: string;
  website: string | null;
  bankAccounts: BankAccount[];
}

export interface BuyerSnapshot {
  customerNo: string;
  name: string;
  name2: string | null;
  street: string;
  postalCode: string;
  city: string;
  countryCode: string;
  vatId: string | null;
  leitwegId: string | null;
  supplierNo: string | null;
  email: string | null;
  contactName: string | null;
  site: {
    siteNo: string;
    name: string;
    street: string | null;
    postalCode: string | null;
    city: string | null;
  } | null;
}

export interface InvoiceReference {
  number: string;
  issueDate: string; // YYYY-MM-DD
}

export interface PrepaymentReference extends InvoiceReference {
  grossAmount: Cents;
  netAmount: Cents;
  vatAmount: Cents;
}

/** Vollständige, ausgestellte Rechnung – Grundlage für PDF, XRechnung und ZUGFeRD. */
export interface InvoiceDocument {
  kind: InvoiceKind;
  number: string;
  issueDate: string;
  dueDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  buyerReference: string | null;
  orderReference: string | null;
  introText: string | null;
  closingText: string | null;
  lines: InvoiceLine[];
  netTotal: Cents;
  vatTotal: Cents;
  grossTotal: Cents;
  prepaidTotal: Cents;
  payableTotal: Cents;
  vatBreakdown: { vatRate: VatRate; taxableAmount: Cents; taxAmount: Cents }[];
  seller: SellerSnapshot;
  buyer: BuyerSnapshot;
  original: InvoiceReference | null;
  prepayments: PrepaymentReference[];
}

export const KIND_TITLES: Record<InvoiceKind, string> = {
  invoice: 'Rechnung',
  partial: 'Abschlagsrechnung',
  final: 'Schlussrechnung',
  cancellation: 'Stornorechnung',
  correction: 'Rechnungskorrektur',
};

/**
 * Belegart (UNTDID 1001) für die E-Rechnung.
 * Storno und Korrektur bewusst als 384 „Korrigierte Rechnung“ mit negativen Beträgen und
 * Verweis auf das Original (BT-25) – nicht 381, dessen deutsche Bezeichnung „Gutschrift“
 * umsatzsteuerlich irreführend ist. Mit Steuerberater bestätigen.
 */
export const KIND_TYPE_CODES: Record<InvoiceKind, '380' | '326' | '384'> = {
  invoice: '380',
  partial: '326',
  final: '380',
  cancellation: '384',
  correction: '384',
};

/** UN/ECE Rec 20 → Anzeigetext */
export const UNIT_LABELS: Record<string, string> = {
  C62: 'Stk.',
  HUR: 'Std.',
  MON: 'Monat',
  MTK: 'm²',
  LS: 'pauschal',
  DAY: 'Tag',
  E48: 'Leistung',
};
