import { calculateDraft, cancellationLines, type DraftLineInput } from '../domain/invoice/calc.js';
import type { InvoiceDocument, SellerSnapshot, BuyerSnapshot } from '../domain/invoice/types.js';
import { type Cents, parseEuro, parseQuantity } from '../domain/money/money.js';

/** Beispieldaten für Tests (keine echten Kundendaten). */
export const SELLER: SellerSnapshot = {
  legalName: 'Viva-Deluxe Gebäudereinigung GmbH',
  street: 'Würmtalstr. 10',
  postalCode: '81375',
  city: 'München',
  countryCode: 'DE',
  vatId: 'DE341586171',
  taxNumber: null,
  registerCourt: 'Amtsgericht München',
  registerNumber: 'HRB 262567',
  managingDirector: 'Ahmed Chomontek',
  phone: '+49 89 63855496',
  email: 'info@viva-deluxe-reinigung.de',
  website: 'www.viva-deluxe-reinigung.de',
  bankAccounts: [
    { name: 'Münchner Bank', iban: 'DE39 7019 0000 0003 2978 37', bic: 'GENODEF1M01', primary: true },
    { name: 'Targobank', iban: 'DE66 7019 0000 0003 1914 27', bic: 'CMCIDEDDXXX' },
  ],
};

export const BUYER: BuyerSnapshot = {
  customerNo: 'K-10001',
  name: 'Beispielbehörde Referat für Bildung',
  name2: 'Abteilung Gebäudemanagement',
  street: 'Musterstraße 1',
  postalCode: '80331',
  city: 'München',
  countryCode: 'DE',
  vatId: null,
  leitwegId: '04011000-1234512345-06',
  supplierNo: '4711',
  email: 'rechnungseingang@example.org',
  contactName: null,
  site: {
    siteNo: 'O-2001',
    name: 'Grundschule Musterweg',
    street: 'Musterweg 5',
    postalCode: '81369',
    city: 'München',
  },
};

export const LINES: DraftLineInput[] = [
  {
    description: 'Unterhaltsreinigung Pauschale',
    detail: 'Leistungszeitraum 01.09.2026 – 30.09.2026',
    quantity: parseQuantity('1'),
    unitCode: 'MON',
    unitPrice: parseEuro('4.850,00'),
    vatRate: 1900,
  },
  {
    description: 'Glasreinigung Erdgeschoss',
    quantity: parseQuantity('1'),
    unitCode: 'C62',
    unitPrice: parseEuro('380,00'),
    vatRate: 1900,
  },
  {
    description: 'Regiestunden Sonderreinigung Turnhalle',
    detail: '12.09.2026, 2 Mitarbeiter',
    quantity: parseQuantity('6,5'),
    unitCode: 'HUR',
    unitPrice: parseEuro('29,80'),
    vatRate: 1900,
  },
];

export function sampleDocument(overrides: Partial<InvoiceDocument> = {}, lines = LINES): InvoiceDocument {
  const d = calculateDraft(lines);
  return {
    kind: 'invoice',
    number: 'RE-2026-00001',
    issueDate: '2026-10-01',
    dueDate: '2026-10-31',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    buyerReference: BUYER.leitwegId,
    orderReference: 'BE-2026-0042',
    introText: 'Für die im Leistungszeitraum erbrachten Reinigungsleistungen berechnen wir:',
    closingText: 'Vielen Dank für die gute Zusammenarbeit.',
    lines: d.lines,
    netTotal: d.net,
    vatTotal: d.vat,
    grossTotal: d.gross,
    prepaidTotal: 0n as Cents,
    payableTotal: d.payable,
    vatBreakdown: d.vatBreakdown,
    seller: SELLER,
    buyer: BUYER,
    original: null,
    prepayments: [],
    ...overrides,
  };
}

export function sampleCancellation(): InvoiceDocument {
  const d = calculateDraft(cancellationLines(LINES));
  return sampleDocument({
    kind: 'cancellation',
    number: 'RE-2026-00002',
    issueDate: '2026-10-02',
    dueDate: '2026-10-02',
    introText: null,
    original: { number: 'RE-2026-00001', issueDate: '2026-10-01' },
    lines: d.lines,
    netTotal: d.net,
    vatTotal: d.vat,
    grossTotal: d.gross,
    payableTotal: d.payable,
    vatBreakdown: d.vatBreakdown,
  });
}

export function sampleFinal(): InvoiceDocument {
  const partial = {
    number: 'RE-2026-00003',
    issueDate: '2026-09-15',
    netAmount: parseEuro('2.000,00'),
    vatAmount: parseEuro('380,00'),
    grossAmount: parseEuro('2.380,00'),
  };
  const d = calculateDraft(LINES, partial.grossAmount);
  return sampleDocument({
    kind: 'final',
    number: 'RE-2026-00004',
    lines: d.lines,
    netTotal: d.net,
    vatTotal: d.vat,
    grossTotal: d.gross,
    prepaidTotal: d.prepaid,
    payableTotal: d.payable,
    vatBreakdown: d.vatBreakdown,
    prepayments: [partial],
  });
}
