import { type Cents, type Quantity, type VatRate, divRoundHalfUp, lineNet, sum } from '../money/money.js';
import type { SkontoTerms } from './types.js';
import { computeTotals } from '../money/totals.js';

export interface DraftLineInput {
  description: string;
  detail?: string | null;
  quantity: Quantity;
  unitCode: string;
  unitPrice: Cents;
  vatRate: VatRate;
  sourceServiceId?: string | null;
  /** Leistungsart (Stammliste) */
  serviceTypeId?: string | null;
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
  note?: string | null;
  /** Abrechnungszyklus (Standard monatlich); fällig ab dem Monat von validFrom im Abstand des Zyklus */
  cycle?: BillingCycle;
}

export type BillingCycle =
  | 'monatlich'
  | 'zweimonatlich'
  | 'quartalsweise'
  | 'halbjaehrlich'
  | 'jaehrlich'
  | 'einmalig'
  | 'je_ausfuehrung';
/** Regelmäßige Zyklen (Monatslauf); „einmalig“ und „je Ausführung“ werden über „Leistungen verrichten“ abgerechnet. */
export type PeriodicCycle = Exclude<BillingCycle, 'einmalig' | 'je_ausfuehrung'>;
export const isPeriodic = (c: BillingCycle): c is PeriodicCycle => c !== 'einmalig' && c !== 'je_ausfuehrung';
export const CYCLE_MONTHS: Record<PeriodicCycle, number> = {
  monatlich: 1,
  zweimonatlich: 2,
  quartalsweise: 3,
  halbjaehrlich: 6,
  jaehrlich: 12,
};
export const CYCLE_LABEL: Record<BillingCycle, string> = {
  monatlich: 'monatlich',
  zweimonatlich: 'alle 2 Monate',
  quartalsweise: 'quartalsweise',
  halbjaehrlich: 'halbjährlich',
  jaehrlich: 'jährlich',
  einmalig: 'einmalig',
  je_ausfuehrung: 'je Ausführung',
};

const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const monthOf = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

/**
 * Abrechnungszeitraum einer Leistung, wenn sie im Abrechnungsmonat fällig ist (sonst null).
 * Fällig im Monat des Leistungsbeginns und danach alle n Monate; der Zeitraum umfasst n Monate
 * (z. B. quartalsweise ab 01.02.: Feb–Apr, Mai–Jul …).
 */
export function billingPeriod(
  cycle: BillingCycle,
  validFrom: string,
  month: string,
): { start: string; end: string } | null {
  if (!isPeriodic(cycle)) return null;
  const n = CYCLE_MONTHS[cycle];
  const diff = monthIndex(month) - monthIndex(validFrom.slice(0, 7));
  if (diff < 0 || diff % n !== 0) return null;
  return { start: monthBounds(month).start, end: monthBounds(monthOf(monthIndex(month) + n - 1)).end };
}

export interface SiteForRun {
  siteNo: string;
  name: string;
  street: string | null;
  postalCode: string | null;
  city: string | null;
}

/**
 * Positionstext wie bei Fortytools:
 *   Unterhaltsreinigung
 *   3.099,86 € + 5,07% Tariflohnerhöhung ab 01.01.2026   ← Zusatztext der Leistung
 *   Objekt: Baubüro VE30 (2000201)
 *   Richelstr. 1c, 80634 München
 *   01.09.2026 bis 30.09.2026
 */
export function serviceDetail(
  note: string | null | undefined,
  site: SiteForRun | null,
  start: string,
  end: string,
): string {
  const place = site
    ? [site.street, [site.postalCode, site.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')
    : '';
  return [
    note?.trim() || null,
    site ? `Objekt: ${site.name} (${site.siteNo})` : null,
    place || null,
    `${formatDateDe(start)} bis ${formatDateDe(end)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Abrechnungslauf: aktive Pauschalen, die im Abrechnungsmonat fällig und im Zeitraum gültig sind. */
export function monthlyRunLines(
  services: readonly ServiceForRun[],
  month: string,
  site: SiteForRun | null = null,
): DraftLineInput[] {
  return services.flatMap((s) => {
    if (!s.active || s.kind !== 'monthly_flat') return [];
    const p = billingPeriod(s.cycle ?? 'monatlich', s.validFrom, month);
    if (!p || s.validFrom > p.end || (s.validTo && s.validTo < p.start)) return [];
    return [
      {
        description: s.description,
        detail: serviceDetail(s.note, site, p.start, p.end),
        quantity: s.quantity,
        unitCode: s.unitCode,
        unitPrice: s.unitPrice,
        vatRate: s.vatRate,
        sourceServiceId: s.id,
      },
    ];
  });
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

/** Datum + Tage (YYYY-MM-DD, kalendarisch, ohne Zeitzonenfehler). */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Skonto auf den Zahlbetrag (brutto), kaufmännisch gerundet.
 * Fortytools-Beispiel: 3 % von 3.875,89 € = 116,28 €, Zahlbetrag 3.759,61 €.
 */
export function skontoTerms(payable: Cents, percentBp: number, days: number, issueDate: string): SkontoTerms {
  const amount = divRoundHalfUp(payable * BigInt(percentBp), 10_000n) as Cents;
  return { percentBp, days, date: addDays(issueDate, days), amount, payable: (payable - amount) as Cents };
}

/** 300 → "3", 250 → "2,5" */
export function percentDe(bp: number): string {
  const int = Math.trunc(bp / 100);
  const frac = String(bp % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return frac ? `${int},${frac}` : String(int);
}

/** Aktuelle Stunde in Berlin (0–23). Fund 07.10.: toLocaleString liefert „08 Uhr“ → Number() = NaN → immer „Guten Abend“. */
export function hourBerlin(now: Date = new Date()): number {
  const h = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(now)
    .find((p) => p.type === 'hour')?.value;
  return Number(h ?? 0);
}
