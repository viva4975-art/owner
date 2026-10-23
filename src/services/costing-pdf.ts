import { formatEuro, type Cents } from '../domain/money/money.js';
import { renderTablePdf, type PdfCell, type PdfColumn, type PdfRow } from '../pdf/table.js';
import type { GeneralCost, SiteCosting } from './costing.js';
import type { PlanEmployeeRow, PlanSiteRow } from './plan-costing.js';

/*
 * PDF der Nach- und Plan-Kalkulation (Ahmed 23.10.): wahlweise „ohne Beträge“ – dann nur Objekt, Kunde, Stunden und
 * Marge in %, keine Erlöse, Kosten, Löhne oder Preise (z. B. zum Weitergeben an Objektleitungen).
 */

const eur = (c: bigint) => formatEuro(c as Cents);
const hm = (m: number) => `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const pct = (bp: number | null) =>
  bp === null ? '–' : `${(bp / 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`;
const red = (v: bigint): string | PdfCell => (v < 0n ? { text: eur(v), bold: true } : eur(v));

export interface CostingPdfOpts {
  title: string;
  period: string;
  filter?: string;
  redact: boolean;
}

const HOURS_COLS: PdfColumn[] = [
  { label: 'Nr.', width: 70 },
  { label: 'Objekt', width: 260, wrap: true },
  { label: 'Kunde', width: 210, wrap: true },
  { label: 'Std. (Plan)', width: 80, align: 'right' },
  { label: 'Std. (Ist)', width: 80, align: 'right' },
  { label: 'Marge', width: 80, align: 'right' },
];
const marginBp = (margin: bigint, rev: bigint) => (rev !== 0n ? Number((margin * 10000n) / rev) : null);
const NO_AMOUNTS = 'ohne Beträge – nur Stunden und Marge';

export async function siteCostingPdf(
  rows: SiteCosting[],
  general: GeneralCost[],
  o: CostingPdfOpts,
): Promise<Uint8Array> {
  if (o.redact) {
    const margin = rows.reduce((a, r) => a + r.margin, 0n) - general.reduce((a, g) => a + g.total, 0n);
    const rev = rows.reduce((a, r) => a + r.revenue, 0n);
    return renderTablePdf({
      title: o.title,
      subtitle: [o.period, o.filter, NO_AMOUNTS].filter(Boolean).join(' · '),
      columns: HOURS_COLS,
      rows: rows.map((r) => [
        r.site_no,
        r.site_name,
        r.customer_name,
        hm(r.planned_minutes),
        hm(r.actual_minutes),
        r.margin_bp !== null && r.margin_bp < 0 ? { text: pct(r.margin_bp), bold: true } : pct(r.margin_bp),
      ]),
      landscape: true,
      fontSize: 8,
      totals: [
        'Gesamt',
        `${rows.length} Objekte`,
        '',
        hm(rows.reduce((a, r) => a + r.planned_minutes, 0)),
        hm(rows.reduce((a, r) => a + r.actual_minutes, 0)),
        pct(marginBp(margin, rev)),
      ],
      footnote:
        'Marge = Deckungsbeitrag in % vom Erlös (Gesamt nach allgemeinen Kostenstellen). Interne Auswertung.',
    });
  }
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
  const body: PdfRow[] = rows.map((r) => [
    r.site_no,
    r.site_name,
    r.customer_name,
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
    subtitle: [o.period, o.filter].filter(Boolean).join(' · '),
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
  if (o.redact) {
    const margin = rows.reduce((a, r) => a + r.margin, 0n);
    const rev = rows.reduce((a, r) => a + r.revenue, 0n);
    return renderTablePdf({
      title: o.title,
      subtitle: [o.period, o.filter, NO_AMOUNTS].filter(Boolean).join(' · '),
      columns: HOURS_COLS.filter((c) => c.label !== 'Std. (Ist)'),
      rows: rows.map((r) => [
        r.site_no,
        r.site_name,
        r.customer_name,
        hm(r.minutes),
        r.margin_bp !== null && r.margin_bp < 0 ? { text: pct(r.margin_bp), bold: true } : pct(r.margin_bp),
      ]),
      landscape: true,
      fontSize: 8,
      totals: [
        'Gesamt',
        `${rows.length} Objekte`,
        '',
        hm(rows.reduce((a, r) => a + r.minutes, 0)),
        pct(marginBp(margin, rev)),
      ],
      footnote:
        'Plan: eingeplante Einsätze; Marge = Deckungsbeitrag (Plan) in % vom Erlös laut laufenden Leistungen.',
    });
  }
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
  const body: PdfRow[] = rows.map((r) => [
    r.site_no,
    r.site_name,
    r.customer_name,
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
    employees.forEach((e) =>
      body.push([
        e.personnel_no,
        e.name,
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
    subtitle: [o.period, o.filter].filter(Boolean).join(' · '),
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
