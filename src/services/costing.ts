import type { Sql } from '../db/client.js';
import { addDays } from '../domain/time/holidays.js';
import { getAccountingSettings } from './datev.js';
import { plannedShifts } from './time.js';

/*
 * Nachkalkulation je Objekt und Monat:
 *   Erlös (netto, ausgestellte Rechnungen inkl. Storno/Korrektur; Leistungszeitraum, sonst Rechnungsdatum)
 * − Lohnkosten (Ist-Stunden × Stundenlohn × (1 + Zuschlag für AG-Anteile, Urlaub, Krankheit, Feiertage))
 * − Material (Lagerabgänge an das Objekt × EK + Eingangsrechnungen „Material“ mit Objekt)
 * − Nachunternehmer und sonstige Eingangsrechnungen mit Objekt (Leistungsmonat)
 * = Deckungsbeitrag. Gemeinkosten (Büro, Fahrzeuge ohne Objekt) sind nicht enthalten.
 */

export interface SiteCosting {
  site_id: string;
  site_no: string;
  site_name: string;
  customer_name: string;
  revenue: bigint;
  planned_minutes: number;
  actual_minutes: number;
  labor: bigint;
  missing_wage: number;
  material: bigint;
  subcontractor: bigint;
  other: bigint;
  margin: bigint;
  margin_bp: number | null; // Marge in Basispunkten vom Erlös
}

export function monthRange(month: string) {
  const from = `${month}-01`;
  const to = addDays(`${addDays(from, 32).slice(0, 7)}-01`, -1);
  return { from, to };
}

export async function siteCosting(
  sql: Sql,
  month: string,
  siteId?: string,
): Promise<{ rows: SiteCosting[]; overheadBp: number; targetBp: number }> {
  const { from, to } = monthRange(month);
  const settings = await getAccountingSettings(sql);
  const factor = BigInt(10000 + settings.labor_overhead_bp);
  const [sites, revenue, labor, stock, incoming, shifts] = await Promise.all([
    sql<{ id: string; site_no: string; name: string; customer_name: string }[]>`
      select s.id, s.site_no, s.name, c.name as customer_name from app.sites s join app.customers c on c.id = s.customer_id
       where ${siteId ? sql`s.id = ${siteId}` : sql`s.active`} order by s.site_no`,
    // je Position: Objekt aus der Leistung (Sammelrechnungen der Rechnungsgruppen haben kein Objekt im Kopf)
    sql<{ site_id: string; net: bigint }[]>`
      select coalesce(ss.site_id, i.site_id) as site_id, sum(l.net_cents)::bigint as net
        from app.invoices i join app.invoice_lines l on l.invoice_id = i.id
        left join app.site_services ss on ss.id = l.source_service_id
       where i.status = 'issued' and coalesce(ss.site_id, i.site_id) is not null
         and coalesce(i.period_start, i.issue_date) between ${from} and ${to}
       group by 1`,
    // Lohn je Eintrag: Minuten × Stundenlohn / 60 (Cent-genau, kaufmännisch gerundet je Objekt)
    sql<{ site_id: string; minutes: number; wage_minutes_cents: bigint; missing: number }[]>`
      select t.site_id,
             sum(extract(epoch from (t.end_at - t.start_at)) / 60 - t.break_minutes)::int as minutes,
             coalesce(sum(((extract(epoch from (t.end_at - t.start_at)) / 60 - t.break_minutes)::bigint) * app.effective_wage_cents(e)), 0)::bigint as wage_minutes_cents,
             count(*) filter (where app.effective_wage_cents(e) is null)::int as missing
        from app.time_entries t join app.employees e on e.id = t.employee_id
       where t.status in ('erfasst', 'freigegeben') and t.work_date between ${from} and ${to}
       group by t.site_id`,
    sql<{ site_id: string; cost: bigint }[]>`
      select m.site_id, coalesce(sum(-m.delta_milli * coalesce(a.purchase_price_cents, 0) / 1000), 0)::bigint as cost
        from app.stock_movements m join app.articles a on a.id = m.article_id
       where m.site_id is not null and m.delta_milli < 0 and (m.created_at at time zone 'Europe/Berlin')::date between ${from} and ${to}
       group by m.site_id`,
    sql<{ site_id: string; category: string; net: bigint }[]>`
      select site_id, category::text, sum(net_cents)::bigint as net from app.incoming_invoices
       where site_id is not null and status in ('erfasst', 'freigegeben', 'bezahlt')
         and coalesce(service_month, date_trunc('month', invoice_date)::date) between ${from} and ${to}
       group by site_id, category`,
    plannedShifts(sql, { from, to, ...(siteId ? { siteId } : {}) }),
  ]);
  const rows = sites.map((s) => {
    const rev = revenue.find((r) => r.site_id === s.id)?.net ?? 0n;
    const l = labor.find((r) => r.site_id === s.id);
    // Cent je Minute → / 60; Zuschlag in Basispunkten
    const laborCents = l ? (l.wage_minutes_cents * factor + 300000n) / 600000n : 0n;
    const inc = incoming.filter((r) => r.site_id === s.id);
    const material =
      (stock.find((r) => r.site_id === s.id)?.cost ?? 0n) +
      inc.filter((r) => r.category === 'material').reduce((a, r) => a + r.net, 0n);
    const sub = inc.filter((r) => r.category === 'nachunternehmer').reduce((a, r) => a + r.net, 0n);
    const other = inc
      .filter((r) => !['material', 'nachunternehmer'].includes(r.category))
      .reduce((a, r) => a + r.net, 0n);
    const margin = rev - laborCents - material - sub - other;
    return {
      site_id: s.id,
      site_no: s.site_no,
      site_name: s.name,
      customer_name: s.customer_name,
      revenue: rev,
      planned_minutes: shifts
        .filter((x) => x.plan.site_id === s.id && !x.absence)
        .reduce((a, x) => a + x.minutes, 0),
      actual_minutes: l?.minutes ?? 0,
      labor: laborCents,
      missing_wage: l?.missing ?? 0,
      material,
      subcontractor: sub,
      other,
      margin,
      margin_bp: rev !== 0n ? Number((margin * 10000n) / rev) : null,
    };
  });
  return { rows, overheadBp: settings.labor_overhead_bp, targetBp: settings.target_margin_bp };
}
