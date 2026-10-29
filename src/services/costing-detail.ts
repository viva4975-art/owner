import type { Sql } from '../db/client.js';
import { monthRange, SPECIAL_SITE_ID, subcontractEstimates } from './costing.js';
import { COST_CATEGORY, type CostCategory } from './purchasing.js';
import { recurringCosts } from './recurring-payments.js';
import { laborFromPayroll } from './costing-labor.js';

/*
 * Aufschlüsselung einer Zeile der Nachkalkulation (Ahmed 26.10.: „die einzelne Position öffnen und sehen, welche Kosten
 * genau dahinter stecken, z. B. bei Bürokosten“). Gleiche Quellen und Regeln wie siteCosting – nur je Beleg statt summiert.
 */

export interface CostItem {
  date: string | null;
  label: string;
  sub?: string;
  href?: string;
  amount: bigint;
}

export interface LaborItem {
  employee_id: string;
  name: string;
  personnel_no: string;
  minutes: number;
  wage_cents: bigint;
  wage_assumed: boolean;
  overhead_bp: number;
  /** Lohn laut Lohnarten (ohne Lohnzuschlag) */
  gross: bigint;
  cost: bigint;
}

export interface CostBreakdown {
  revenue: CostItem[];
  labor: LaborItem[];
  material: CostItem[];
  subcontractor: CostItem[];
  equipment: CostItem[];
  other: CostItem[];
}

const sortItems = (a: CostItem, b: CostItem) =>
  (a.date ?? '').localeCompare(b.date ?? '') || a.label.localeCompare(b.label, 'de');

/** Eingangsrechnungen nach Aufteilung (Objekt bzw. allgemeine Kostenstelle) und Leistungsmonat. */
async function incomingItems(
  sql: Sql,
  target: { siteId?: string; costCenterId?: string },
  from: string,
  to: string,
) {
  const rows = await sql<
    {
      id: string;
      supplier_name: string;
      invoice_no: string;
      invoice_date: string;
      category: string;
      status: string;
      month: string;
      net: bigint;
    }[]
  >`
    select i.id, s.name as supplier_name, i.invoice_no, i.invoice_date::text as invoice_date,
           i.category::text as category, i.status::text as status, to_char(a.month, 'MM/YYYY') as month,
           sum(a.net_cents)::bigint as net
      from app.cost_allocations a join app.incoming_invoices i on i.id = a.incoming_invoice_id
      join app.suppliers s on s.id = i.supplier_id
     where ${target.siteId ? sql`a.site_id = ${target.siteId}` : sql`a.cost_center_id = ${target.costCenterId!}`}
       and i.status in ('erfasst', 'freigegeben', 'bezahlt') and a.month between ${from} and ${to}
     group by 1, 2, 3, 4, 5, 6, 7`;
  return rows.map((r) => ({
    category: r.category,
    item: {
      date: r.invoice_date,
      label: `${r.supplier_name} · Rechnung ${r.invoice_no}`,
      sub: `Eingangsrechnung · ${COST_CATEGORY[r.category as CostCategory] ?? r.category} · Leistungsmonat ${r.month} · ${r.status}`,
      href: `/rechnungseingang/${r.id}`,
      amount: r.net,
    } satisfies CostItem,
  }));
}

function bucket(b: CostBreakdown, category: string | null) {
  if (category === 'material') return b.material;
  if (category === 'nachunternehmer') return b.subcontractor;
  if (category === 'geraete') return b.equipment;
  return b.other;
}

/** Objekt (Kostenstelle = Objekt) im Zeitraum von–bis (JJJJ-MM). */
export async function siteCostBreakdown(
  sql: Sql,
  siteId: string,
  period: { from: string; to: string },
): Promise<CostBreakdown> {
  const from = monthRange(period.from).from;
  const to = monthRange(period.to).to;
  const siteOf = (expr: ReturnType<Sql>) =>
    siteId === SPECIAL_SITE_ID
      ? sql`(st.special_cleaning or ${expr} = ${siteId})`
      : sql`(${expr} = ${siteId} and not (coalesce(st.special_cleaning, false) and sp.id is not null))`;
  const [own, legacy, labor, stock, incoming, est, orders] = await Promise.all([
    sql<
      { id: string; number: string; kind: string; issue_date: string; period: string | null; net: bigint }[]
    >`
      select i.id, i.number, i.kind::text as kind, i.issue_date::text as issue_date,
             case when i.period_start is null then null
                  else to_char(i.period_start, 'DD.MM.YYYY') || coalesce(' – ' || to_char(i.period_end, 'DD.MM.YYYY'), '') end as period,
             sum(l.net_cents)::bigint as net
        from app.invoices i join app.invoice_lines l on l.invoice_id = i.id
        left join app.site_services ss on ss.id = l.source_service_id
        left join app.service_types st on st.id = coalesce(l.service_type_id, ss.service_type_id)
        left join app.sites sp on sp.id = ${SPECIAL_SITE_ID}
       where i.status = 'issued' and coalesce(ss.site_id, i.site_id) is not null
         and ${siteOf(sql`coalesce(ss.site_id, i.site_id)`)}
         and coalesce(i.period_start, i.issue_date) between ${from} and ${to}
       group by 1, 2, 3, 4, 5`,
    sql<{ id: string; number: string; issue_date: string; net: bigint }[]>`
      select i.id, i.number, i.issue_date::text as issue_date, sum(l.net_cents)::bigint as net
        from app.legacy_invoice_lines l join app.legacy_invoices i on i.id = l.invoice_id
        left join app.service_types st on lower(st.name) = lower(trim(l.service_type))
        left join app.sites sp on sp.id = ${SPECIAL_SITE_ID}
       where l.site_id is not null and ${siteOf(sql`l.site_id`)}
         and coalesce(l.period_start, i.issue_date) between ${from} and ${to}
       group by 1, 2, 3`,
    laborFromPayroll(sql, from, to),
    sql<
      {
        issue_id: string | null;
        issue_no: string | null;
        article_id: string;
        article: string;
        unit: string;
        day: string;
        qty_milli: bigint;
        cost: bigint;
      }[]
    >`
      select mi.id as issue_id, mi.issue_no, a.id as article_id, a.name as article, a.unit,
             coalesce(m.booked_on, (m.created_at at time zone 'Europe/Berlin')::date)::text as day,
             sum(-m.delta_milli)::bigint as qty_milli,
             coalesce(sum(round(-m.delta_milli * coalesce(m.unit_cost_cents, a.purchase_price_cents, 0) / 1000.0)), 0)::bigint as cost
        from app.stock_movements m join app.articles a on a.id = m.article_id
        left join app.material_issues mi on mi.id = m.material_issue_id
       where m.site_id = ${siteId} and (m.delta_milli < 0 or m.material_issue_id is not null)
         and coalesce(m.booked_on, (m.created_at at time zone 'Europe/Berlin')::date) between ${from} and ${to}
       group by 1, 2, 3, 4, 5, 6`,
    incomingItems(sql, { siteId }, from, to),
    subcontractEstimates(sql, from, to, siteId),
    sql<{ id: string; number: string; supplier: string; billing: string; frequency: string }[]>`
      select s.id, s.number, su.name as supplier, s.billing::text as billing, s.frequency::text as frequency
        from app.subcontracts s join app.suppliers su on su.id = s.supplier_id
       where s.status in ('erteilt', 'beendet') and s.valid_from <= ${to} and (s.valid_to is null or s.valid_to >= ${from})
         and (s.site_id = ${siteId} or exists (select 1 from app.subcontract_sites x where x.subcontract_id = s.id and x.site_id = ${siteId}))
       order by s.number`,
  ]);
  const kindLabel: Record<string, string> = {
    invoice: 'Rechnung',
    cancellation: 'Stornorechnung',
    correction: 'Rechnungskorrektur',
    partial: 'Abschlagsrechnung',
    final: 'Schlussrechnung',
  };
  const b: CostBreakdown = {
    revenue: [],
    labor: [],
    material: [],
    subcontractor: [],
    equipment: [],
    other: [],
  };
  for (const r of own)
    b.revenue.push({
      date: r.issue_date,
      label: `${kindLabel[r.kind] ?? 'Rechnung'} ${r.number}`,
      ...(r.period ? { sub: `Leistungszeitraum ${r.period}` } : {}),
      href: `/rechnungen/${r.id}`,
      amount: r.net,
    });
  for (const r of legacy)
    b.revenue.push({
      date: r.issue_date,
      label: `Rechnung ${r.number}`,
      sub: 'vor der Umstellung',
      href: `/rechnungen/${r.id}`,
      amount: r.net,
    });
  b.revenue.sort(sortItems);
  b.labor = labor
    .filter((l) => l.site_id === siteId && (l.cost || l.minutes))
    .map((l) => ({
      employee_id: l.employee_id,
      name: l.name,
      personnel_no: l.personnel_no,
      minutes: l.minutes,
      wage_cents: l.wage_cents,
      wage_assumed: l.wage_assumed,
      overhead_bp: l.overhead_bp,
      gross: l.gross,
      cost: l.cost,
    }))
    .sort((a, b2) => Number(b2.cost - a.cost));
  for (const m of stock) {
    const qty = (Number(m.qty_milli) / 1000).toLocaleString('de-DE', { maximumFractionDigits: 3 });
    b.material.push({
      date: m.day,
      label: `${m.article} · ${qty} ${m.unit}`,
      sub: m.issue_no ? `Materialausgabe ${m.issue_no}` : 'Lagerabgang',
      href: m.issue_id ? `/materialausgabe/${m.issue_id}` : `/artikel/${m.article_id}`,
      amount: m.cost,
    });
  }
  for (const x of incoming) bucket(b, x.category).push(x.item);
  const estCost = est.find((e) => e.site_id === siteId);
  if (estCost && estCost.cost !== 0n)
    b.subcontractor.push({
      date: null,
      label: 'Geschätzt laut Bestellung (noch keine Rechnung gebucht)',
      sub:
        `${estCost.months} Monat${estCost.months === 1 ? '' : 'e'}` +
        (orders.length ? ` · ${orders.map((o) => `${o.number} ${o.supplier}`).join(', ')}` : ''),
      ...(orders.length === 1 ? { href: `/nachunternehmer/auftraege/${orders[0]!.id}` } : {}),
      amount: BigInt(estCost.cost),
    });
  for (const k of ['material', 'subcontractor', 'equipment', 'other'] as const) b[k].sort(sortItems);
  // Büro/Lager (interne Bereiche): Material zählt nicht, wie in siteCosting (Ahmed 27.10.)
  const [own2] = await sql<{ internal: boolean }[]>`
    select coalesce(c.is_internal, false) and s.id <> ${SPECIAL_SITE_ID} as internal
      from app.sites s join app.customers c on c.id = s.customer_id where s.id = ${siteId}`;
  if (own2?.internal) b.material = [];
  return b;
}

/** Allgemeine Kostenstelle (9000 Verwaltung/Büro …): Eingangsrechnungen + wiederkehrende Zahlungen. */
export async function costCenterBreakdown(
  sql: Sql,
  costCenterId: string,
  period: { from: string; to: string },
): Promise<CostBreakdown> {
  const from = monthRange(period.from).from;
  const to = monthRange(period.to).to;
  const [incoming, rec] = await Promise.all([
    incomingItems(sql, { costCenterId }, from, to),
    recurringCosts(sql, from, to),
  ]);
  const b: CostBreakdown = {
    revenue: [],
    labor: [],
    material: [],
    subcontractor: [],
    equipment: [],
    other: [],
  };
  for (const x of incoming) bucket(b, x.category).push(x.item);
  // wiederkehrende Zahlungen je Zahlung zusammengefasst (Monate im Zeitraum)
  const byRec = new Map<
    string,
    { name: string; payee: string; category: string | null; months: string[]; net: bigint }
  >();
  for (const r of rec) {
    if (r.cost_center_id !== costCenterId) continue;
    const e = byRec.get(r.recurring_id) ?? {
      name: r.name,
      payee: r.payee,
      category: r.category,
      months: [],
      net: 0n,
    };
    e.months.push(r.month);
    e.net += r.net;
    byRec.set(r.recurring_id, e);
  }
  for (const [, e] of byRec) {
    const ms = e.months.sort();
    const fmt = (m: string) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
    bucket(b, e.category === 'material' || e.category === 'geraete' ? e.category : null).push({
      date: null,
      label: `${e.name}${e.payee && e.payee !== e.name ? ` · ${e.payee}` : ''}`,
      sub: `Wiederkehrende Zahlung (netto) · ${ms.length === 1 ? fmt(ms[0]!) : `${fmt(ms[0]!)} – ${fmt(ms[ms.length - 1]!)} (${ms.length} Monate)`}`,
      href: '/zahlungsliste/wiederkehrend',
      amount: e.net,
    });
  }
  // Material an allgemeinen Kostenstellen zählt nicht (geht über die Materialausgabe ans Objekt, Ahmed 27.10.)
  b.material = [];
  for (const k of ['material', 'subcontractor', 'equipment', 'other'] as const) b[k].sort(sortItems);
  return b;
}
