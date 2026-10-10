// Erzeugt Gestaltungsvorschläge (Rechnung + Angebot, je drei Varianten) mit Beispieldaten – nur zur Ansicht.
// Aufruf: npx tsx scripts/design-proposals.ts <Ausgabeordner>
import { mkdir, writeFile } from 'node:fs/promises';
import type { InvoiceDocument } from '../src/domain/invoice/types.js';
import type { Cents, Quantity, VatRate } from '../src/domain/money/money.js';
import { type DesignVariant, renderInvoiceDesign } from '../src/pdf/invoice-design.js';
import { renderInvoicePdf } from '../src/pdf/render.js';

const out = process.argv[2] ?? 'var/design-vorschlaege';
const c = (n: number) => BigInt(Math.round(n * 100)) as Cents;
const q = (n: number) => BigInt(Math.round(n * 1000)) as Quantity;
const vat = 1900 as VatRate;
const seller = {
  legalName: 'Viva-Deluxe Gebäudereinigung GmbH',
  street: 'Würmtalstr. 10',
  postalCode: '81375',
  city: 'München',
  countryCode: 'DE',
  vatId: 'DE341586171',
  taxNumber: '143/190/63154',
  registerCourt: 'AG München',
  registerNumber: 'HRB 262 567',
  managingDirector: 'Ahmed Chomontek',
  phone: '+49 89 63855496',
  email: 'buchhaltung@viva-deluxe-reinigung.de',
  website: 'www.viva-deluxe-reinigung.de',
  bankAccounts: [
    { name: 'Münchner Bank', iban: 'DE39701900000003297837', bic: 'GENODEF1M01', primary: true },
  ],
};
const buyer = {
  customerNo: '20017',
  name: 'Muster Wohnbau GmbH',
  name2: 'Hausverwaltung',
  street: 'Beispielstraße 12',
  postalCode: '80331',
  city: 'München',
  countryCode: 'DE',
  vatId: null,
  leitwegId: null,
  supplierNo: '4711',
  email: 'rechnung@muster-wohnbau.example',
  contactName: 'Frau Beispiel',
  site: {
    siteNo: '2001701',
    name: 'Wohnanlage Sonnenhof',
    street: 'Sonnenstr. 5',
    postalCode: '80331',
    city: 'München',
  },
};
const lines = [
  [
    'Unterhaltsreinigung',
    'Treppenhaus, Eingangsbereich und Aufzug wöchentlich\nTariflohnerhöhung ab 01.01.2026 eingerechnet',
    1,
    'LS',
    1450,
  ],
  ['Glasreinigung Eingangsbereich', 'Glasflächen innen und außen inkl. Rahmen', 1, 'LS', 280],
  ['Sonderreinigung Tiefgarage', 'Nassreinigung mit Scheuersaugmaschine, 48 Stellplätze', 1350, 'MTK', 0.85],
  ['Regiestunden Hausmeisterservice', 'Laubbeseitigung und Winterdienst-Vorbereitung', 6.5, 'HUR', 38.5],
] as const;
const docLines = lines.map(([d, det, qty, u, p], i) => ({
  position: i + 1,
  description: d,
  detail: det,
  quantity: q(qty),
  unitCode: u,
  unitPrice: c(p),
  netAmount: c(Math.round(qty * p * 100) / 100),
  vatRate: vat,
}));
const net = docLines.reduce((a, l) => a + l.netAmount, 0n) as Cents;
const tax = ((net * 19n + 50n) / 100n) as Cents;
const doc: InvoiceDocument = {
  kind: 'invoice',
  number: '1038309',
  issueDate: '2026-10-10',
  dueDate: '2026-10-30',
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  buyerReference: null,
  orderReference: 'BE-4500123',
  introText: null,
  closingText: null,
  lines: docLines,
  netTotal: net,
  vatTotal: tax,
  grossTotal: (net + tax) as Cents,
  prepaidTotal: 0n as Cents,
  payableTotal: (net + tax) as Cents,
  vatBreakdown: [{ vatRate: vat, taxableAmount: net, taxAmount: tax }],
  seller,
  buyer,
  original: null,
  prepayments: [],
  skonto: {
    percentBp: 300,
    days: 7,
    date: '2026-10-17',
    amount: c(Number(net + tax) * 0.0003),
    payable: c(Number(net + tax) * 0.0097),
  },
};
// Angebot: monatlich + einmalig
const offerLines = [
  { ...docLines[0]!, detail: 'monatlich' },
  { ...docLines[1]!, detail: 'monatlich' },
  { ...docLines[2]!, position: 3, detail: 'einmalig' },
];
const sum = (ls: typeof offerLines) => ls.reduce((a, l) => a + l.netAmount, 0n);
const block = (label: string, n: bigint) => ({
  label,
  net: n,
  vat: (n * 19n + 50n) / 100n,
  gross: n + (n * 19n + 50n) / 100n,
});
const oNet = sum(offerLines) as Cents;
const oTax = ((oNet * 19n + 50n) / 100n) as Cents;
const offer: InvoiceDocument = {
  ...doc,
  number: '3897',
  lines: offerLines,
  netTotal: oNet,
  vatTotal: oTax,
  grossTotal: (oNet + oTax) as Cents,
  payableTotal: (oNet + oTax) as Cents,
  vatBreakdown: [{ vatRate: vat, taxableAmount: oNet, taxAmount: oTax }],
  introText: 'vielen Dank für Ihre Anfrage. Gerne unterbreiten wir Ihnen folgendes Angebot:',
  skonto: null,
};
const offerOpts = {
  title: 'Angebot 3897',
  subject: 'Objekt: Wohnanlage Sonnenhof (2001701), Sonnenstr. 5, 80331 München',
  info: [
    ['Angebotsnummer', '3897'],
    ['Angebotsdatum', '10.10.2026'],
    ['Kundennummer', '20017'],
    ['Gültig bis', '10.11.2026'],
  ] as [string, string][],
  terms: 'Dieses Angebot ist gültig bis zum 10.11.2026. Es gelten unsere Allgemeinen Geschäftsbedingungen.',
  closing:
    'Wir würden uns über Ihren Auftrag sehr freuen. Für Rückfragen stehen wir Ihnen jederzeit gerne zur Verfügung.',
  qr: false,
  totalsSplit: [block('Monatlich', sum(offerLines.slice(0, 2))), block('Einmalig', sum(offerLines.slice(2)))],
  contact: { name: 'Ahmed Chomontek', phone: '089 63855496', email: 'info@viva-deluxe-reinigung.de' },
  acceptance: true,
};
await mkdir(out, { recursive: true });
await writeFile(`${out}/0-rechnung-heute.pdf`, await renderInvoicePdf(doc));
for (const [i, v] of (['klar', 'akzent', 'kompakt'] as DesignVariant[]).entries()) {
  await writeFile(`${out}/${i + 1}-rechnung-${v}.pdf`, await renderInvoiceDesign(doc, { variant: v }));
  await writeFile(
    `${out}/${i + 1}-angebot-${v}.pdf`,
    await renderInvoiceDesign(offer, { variant: v, ...offerOpts }),
  );
}
console.log('fertig:', out);
