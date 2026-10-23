import { formatEuro, type Cents } from '../domain/money/money.js';
import { renderTablePdf, type PdfCell, type PdfColumn, type PdfRow } from '../pdf/table.js';
import type { GeneralCost, SiteCosting } from './costing.js';
import type { PlanEmployeeRow, PlanSiteRow } from './plan-costing.js';

/*
 * PDF der Nach- und Plan-Kalkulation (Ahmed 23.10.): wahlweise geschwärzt – dann stehen statt Objekt-, Kunden- und
 * Mitarbeiternamen schwarze Balken bzw. „Objekt 001“; Zahlen bleiben. Zum Weitergeben (Bank, Berater, Ausschreibung).
 */

const eur = (c: bigint) => formatEuro(c as Cents);
const hm = (m: number) => `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const pct = (bp: number | null) =>
  bp === null ? '–' : `${(bp / 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`;
const BLACK: [number, number, number] = [0.08, 0.08, 0.08];
const bar = (): PdfCell => ({ text: '', fill: BLACK });
const red = (v: bigint): string | PdfCell => (v < 0n ? { text: eur(v), bold: true } : eur(v));

export interface CostingPdfOpts {
  title: string;
  period: string;
  filter?: string;
  redact: boolean;
}

function siteCells(
  i: number,
  no: string,
  name: string,
  customer: string,
  redact: boolean,
): (string | PdfCell)[] {
  if (!redact) return [no, name, customer];
  return [`Objekt ${String(i + 1).padStart(3, '0')}`, bar(), bar()];
}

export async function siteCostingPdf(
  rows: SiteCosting[],
  general: GeneralCost[],
  o: CostingPdfOpts,
): Promise<Uint8Array> {
  const columns: PdfColumn[] = [
    { label: 'Nr.', width: 62 },
    { label: 'Objekt', width: 150, wrap: true },
    { label: 'Kunde', width: 110, wrap: true },
    { label: 'Erlös', width: 64, align: 'right' },
    { label: 'Ist-Std.', width: 42, align: 'right' },
    { label: 'Lohn', width: 60, align: 'right' },
    { label: 'Material', width: 52, align: 'right' },
    { label: 'Nachunt.', width: 58, align: 'right' },
    { label: 'Geräte', width: 48, align: 'right' },
    { label: 'Sonstiges', width: 50, align: 'right' },
    { label: 'DB', width: 62, align: 'right' },
    { label: 'Marge', width: 38, align: 'right' },
  ];
  const sum = (f: (r: SiteCosting) => bigint) => rows.reduce((a, r) => a + f(r), 0n);
  const body: PdfRow[] = rows.map((r, i) => [
    ...siteCells(i, r.site_no, r.site_name, r.customer_name, o.redact),
    eur(r.revenue),
    hm(r.actual_minutes),
    eur(r.labor),
    eur(r.material),
    eur(r.subcontractor),
    eur(r.equipment),
    eur(r.other),
    red(r.margin),
    pct(r.margin_bp),
  ]);
  const genTotal = general.reduce((a, g) => a + g.total, 0n);
  if (general.length) {
    body.push({ section: 'Allgemeine Kostenstellen' });
    for (const g of general)
      body.push([
        g.number,
        g.name,
        '',
        '',
        '',
        '',
        eur(g.material),
        eur(g.subcontractor),
        eur(g.equipment),
        eur(g.other),
        eur(-g.total),
        '',
      ]);
  }
  const margin = sum((r) => r.margin);
  const rev = sum((r) => r.revenue);
  return renderTablePdf({
    title: o.title,
    subtitle: [o.period, o.filter, o.redact ? 'Namen geschwärzt' : ''].filter(Boolean).join(' · '),
    columns,
    rows: body,
    landscape: true,
    fontSize: 7,
    totals: [
      'Gesamt',
      `${rows.length} Objekte`,
      '',
      eur(rev),
      hm(rows.reduce((a, r) => a + r.actual_minutes, 0)),
      eur(sum((r) => r.labor)),
      eur(sum((r) => r.material) + general.reduce((a, g) => a + g.material, 0n)),
      eur(sum((r) => r.subcontractor) + general.reduce((a, g) => a + g.subcontractor, 0n)),
      eur(sum((r) => r.equipment) + general.reduce((a, g) => a + g.equipment, 0n)),
      eur(sum((r) => r.other) + general.reduce((a, g) => a + g.other, 0n)),
      eur(margin - genTotal),
      rev ? pct(Number(((margin - genTotal) * 10000n) / rev)) : '–',
    ],
    footnote:
      'DB = Erlös − Lohn (Ist-Stunden × Stundenlohn + Zuschlag) − Material − Nachunternehmer − Geräte − Sonstiges; ' +
      'Gesamt abzüglich allgemeiner Kostenstellen. Interne Auswertung.',
  });
}

export async function planCostingPdf(
  rows: PlanSiteRow[],
  employees: PlanEmployeeRow[] | null,
  o: CostingPdfOpts,
): Promise<Uint8Array> {
  const columns: PdfColumn[] = [
    { label: 'Nr.', width: 62 },
    { label: 'Objekt', width: 160, wrap: true },
    { label: 'Kunde', width: 120, wrap: true },
    { label: 'Erlös (Plan)', width: 66, align: 'right' },
    { label: 'Std.', width: 42, align: 'right' },
    { label: 'Lohn brutto', width: 62, align: 'right' },
    { label: 'AG-Kosten', width: 58, align: 'right' },
    { label: 'Nachunt.', width: 60, align: 'right' },
    { label: 'Material', width: 54, align: 'right' },
    { label: 'DB', width: 62, align: 'right' },
    { label: 'Marge', width: 40, align: 'right' },
  ];
  const sum = (f: (r: PlanSiteRow) => bigint) => rows.reduce((a, r) => a + f(r), 0n);
  const body: PdfRow[] = rows.map((r, i) => [
    ...siteCells(i, r.site_no, r.site_name, r.customer_name, o.redact),
    eur(r.revenue),
    hm(r.minutes),
    eur(r.gross),
    eur(r.employer),
    eur(r.subcontractor),
    eur(r.material),
    red(r.margin),
    pct(r.margin_bp),
  ]);
  if (employees?.length) {
    body.push({ section: 'Mitarbeitende im Plan (Entgelt im Zeitraum)' });
    employees.forEach((e, i) =>
      body.push([
        o.redact ? `MA ${String(i + 1).padStart(3, '0')}` : e.personnel_no,
        o.redact ? bar() : e.name,
        e.employment_type ?? '',
        '',
        hm(e.minutes),
        eur(e.gross),
        eur(e.employer),
        '',
        '',
        '',
        e.gross > 0n ? pct(Number((e.employer * 10000n) / e.gross)) : '–',
      ]),
    );
  }
  const margin = sum((r) => r.margin);
  const rev = sum((r) => r.revenue);
  return renderTablePdf({
    title: o.title,
    subtitle: [o.period, o.filter, o.redact ? 'Namen geschwärzt' : ''].filter(Boolean).join(' · '),
    columns,
    rows: body,
    landscape: true,
    fontSize: 7,
    totals: [
      'Gesamt',
      `${rows.length} Objekte`,
      '',
      eur(rev),
      hm(rows.reduce((a, r) => a + r.minutes, 0)),
      eur(sum((r) => r.gross)),
      eur(sum((r) => r.employer)),
      eur(sum((r) => r.subcontractor)),
      eur(sum((r) => r.material)),
      eur(margin),
      rev ? pct(Number((margin * 10000n) / rev)) : '–',
    ],
    footnote:
      'Plan: Erlös aus laufenden Leistungen, Lohn aus eingeplanten Einsätzen mit Arbeitgeberkosten nach Lohnhöhe ' +
      '(Minijob/Midijob/regulär), Nachunternehmer laut Bestellung, Material Ø der letzten 3 Monate. Schätzung.',
  });
}
