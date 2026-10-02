import { type Cents, type Quantity, type VatRate, lineNet, sum } from '../money/money.js';
import { computeTotals } from '../money/totals.js';

export interface DraftLineInput {
  description: string;
  detail?: string | null;
  quantity: Quantity;
  unitCode: string;
  unitPrice: Cents;
  vatRate: VatRate;
  sourceServiceId?: string | null;
}

export interface DraftLine extends DraftLineInput {
  position: number;
  netAmount: Cents;
}

export interface DraftTotals {
  lines: DraftLine[];
  net: Cents;
  vat: Cents;
  gross: Cents;
  prepaid: Cents;
  payable: Cents;
  vatBreakdown: { vatRate: VatRate; taxableAmount: Cents; taxAmount: Cents }[];
}

/** Berechnet Positionen und Summen eines Entwurfs. `prepaid` = verrechnete Abschläge (brutto). */
export function calculateDraft(inputs: readonly DraftLineInput[], prepaid: Cents = 0n as Cents): DraftTotals {
  const t = computeTotals(inputs);
  const lines = inputs.map((l, i) => ({
    ...l,
    position: i + 1,
    netAmount: lineNet(l.quantity, l.unitPrice),
  }));
  return {
    lines,
    net: t.netTotal,
    vat: t.vatTotal,
    gross: t.grossTotal,
    prepaid,
    payable: (t.grossTotal - prepaid) as Cents,
    vatBreakdown: t.vat,
  };
}

/**
 * Stornopositionen: dieselben Positionen mit negativer Menge. Einzelpreise bleiben positiv
 * (EN 16931 verbietet negative Preise, BR-27). Ergebnis hebt das Original Cent-genau auf.
 */
export function cancellationLines(original: readonly DraftLineInput[]): DraftLineInput[] {
  return original.map((l) => ({ ...l, quantity: -l.quantity as Quantity }));
}

/** Summe der verrechneten Abschläge (brutto). */
export function prepaidTotal(partials: readonly { grossAmount: Cents }[]): Cents {
  return sum(partials.map((p) => p.grossAmount));
}

export interface ServiceForRun {
  id: string;
  kind: 'monthly_flat' | 'special' | 'hourly';
  description: string;
  unitCode: string;
  quantity: Quantity;
  unitPrice: Cents;
  vatRate: VatRate;
  validFrom: string;
  validTo: string | null;
  active: boolean;
}

/** Monatslauf: nur aktive Monatspauschalen, die im Abrechnungsmonat gültig sind. */
export function monthlyRunLines(services: readonly ServiceForRun[], month: string): DraftLineInput[] {
  const { start, end } = monthBounds(month);
  return services
    .filter(
      (s) =>
        s.active && s.kind === 'monthly_flat' && s.validFrom <= end && (!s.validTo || s.validTo >= start),
    )
    .map((s) => ({
      description: s.description,
      detail: `Leistungszeitraum ${formatDateDe(start)} – ${formatDateDe(end)}`,
      quantity: s.quantity,
      unitCode: s.unitCode,
      unitPrice: s.unitPrice,
      vatRate: s.vatRate,
      sourceServiceId: s.id,
    }));
}

/** "2026-09" → { start: "2026-09-01", end: "2026-09-30" } */
export function monthBounds(month: string): { start: string; end: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new RangeError(`Ungültiger Monat: ${month}`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) throw new RangeError(`Ungültiger Monat: ${month}`);
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { start: `${m[1]}-${m[2]}-01`, end: `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}` };
}

export function formatDateDe(iso: string): string {
  const [y, mo, d] = iso.split('-');
  return `${d}.${mo}.${y}`;
}

const MONTHS_DE = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];

export function monthLabelDe(month: string): string {
  const [y, m] = month.split('-');
  return `${MONTHS_DE[Number(m) - 1] ?? m} ${y}`;
}

/** Heutiges Datum in Deutschland (YYYY-MM-DD), unabhängig von der Server-Zeitzone. */
export function todayBerlin(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(now);
}
