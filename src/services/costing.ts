import { countDays } from './subcontract-days.js';
import { orderClosures } from './subcontract-days.js';
import { recurringCosts } from './recurring-payments.js';
import { sammelMonthCost } from './subcontract-sites.js';
import type { Sql } from '../db/client.js';
import { addDays } from '../domain/time/holidays.js';
import { getAccountingSettings } from './datev.js';
import { plannedShifts } from './time.js';
import { laborFromPayroll } from './costing-labor.js';

/*
 * Nachkalkulation je Objekt und Monat:
 *   Erlös (netto, ausgestellte Rechnungen inkl. Storno/Korrektur; Leistungszeitraum, sonst Rechnungsdatum)
 * − Lohnkosten laut Lohnarten (Ist, sonst Plan; Stunden inkl. Urlaub/Krank/Feiertag × Lohn bzw. Gehalt, Zuschläge)
 *   × (1 + Lohnzuschlag für AG-Anteile);
 *   Zuschlag je Beschäftigungsart: Minijob, Teilzeit bis 30 Std./Woche, darüber (Einstellungen → DATEV)
 * − Material (Lagerabgänge an das Objekt × EK + Eingangsrechnungen „Material“ mit Objekt)
 * − Nachunternehmer und sonstige Eingangsrechnungen mit Objekt (Leistungsmonat)
 * = Deckungsbeitrag. Gemeinkosten (Büro, Fahrzeuge ohne Objekt) sind nicht enthalten.
 */

export interface SiteCosting {
  site_id: string;
  site_no: string;
  site_name: string;
  customer_id: string;
  customer_name: string;
  customer_no: string | null;
  manager_user_id: string | null;
  revenue: bigint;
  planned_minutes: number;
  actual_minutes: number;
  labor: bigint;
  missing_wage: number;
  material: bigint;
  subcontractor: bigint;
  /** davon laut NU-Bestellung (Monatspauschale ohne gebuchte Rechnung) */
  subcontractor_estimated: bigint;
  /** Geräte / Wartung / Miete von Geräten (z. B. Hebebühne) */
  equipment: bigint;
  other: bigint;
  margin: bigint;
  margin_bp: number | null; // Marge in Basispunkten vom Erlös
  /** interner Bereich (Büro, Lager … beim Kunden „intern“, ohne Sonderreinigung): Gemeinkosten, separat gezeigt */
  internal: boolean;
  /** Zeile für Rechnungen an den Kunden ohne Objekt (site_id = Kunden-ID) */
  customer_only?: boolean;
}

/**
 * Nachunternehmer-Kosten laut Bestellung (Ahmed 09.10.: „NU soweit möglich einfließen lassen“): je Objekt und Monat die
 * Monatspauschale erteilter/beendeter NU-Bestellungen (mit Preisnachträgen) – nur für Monate, in denen für das Objekt
 * noch keine Nachunternehmer-Eingangsrechnung gebucht ist (sonst zählt die echte Rechnung). Abrechnung je Einsatz/Tag/
 * Stunde lässt sich ohne Rechnung nicht schätzen und bleibt außen vor.
 */
export async function subcontractEstimates(
  sql: Sql,
  from: string,
  to: string,
  siteId?: string,
  /** Plan-Kalkulation: jeden Monat laut Bestellung, auch wenn schon eine Rechnung gebucht ist; „je Stunde“ mit max. Std. */
  opts: { plan?: boolean } = {},
) {
  // ohne NU-Rechnung im Monat: Monatspauschale der Bestellung bzw. bei „je Stunde“ die erfassten Stunden
  // (Stundennachweis) × Stundensatz des Monats, je Eintrag kaufmännisch auf Cent gerundet
  const priceAt = (mon: ReturnType<Sql>) => sql`coalesce((select p.price_cents from app.subcontract_prices p
                          where p.subcontract_id = s.id and p.valid_from_month <= ${mon}
                          order by p.valid_from_month desc limit 1), s.price_cents)`;
  const noInvoice = (mon: ReturnType<Sql>) =>
    opts.plan
      ? sql`true`
      : sql`not exists (
         select 1 from app.cost_allocations a join app.incoming_invoices i on i.id = a.incoming_invoice_id
          where a.site_id = s.site_id and a.month = ${mon} and i.category = 'nachunternehmer'
            and i.status in ('erfasst', 'freigegeben', 'bezahlt'))`;
  const hours = opts.plan
    ? // Plan: regelmäßige Bestellungen „je Stunde“ mit max. Stunden × Stundensatz je Monat
      sql`select s.site_id, round(s.max_hours_month * ${priceAt(sql`m.mon`)})::bigint as cost, m.mon
            from app.subcontracts s
            join m on s.valid_from <= (m.mon + interval '1 month' - interval '1 day')::date
                  and (s.valid_to is null or s.valid_to >= m.mon)
           where s.status in ('erteilt', 'beendet') and s.billing = 'stunde' and s.site_id is not null
             and s.frequency in ('monatlich', 'woechentlich') and s.max_hours_month is not null
             and s.price_cents is not null
             and ${siteId ? sql`s.site_id = ${siteId}` : sql`true`}`
    : // erfasste Stunden „je Stunde“ und Regiestunden (Regie-Stundensatz, ggf. auf ein Objekt der Sammelbestellung)
      sql`select coalesce(h.site_id, s.site_id) as site_id,
             round(h.persons * h.minutes_per_person * (case when h.regie then coalesce(s.regie_rate_cents, 0)
                   else ${priceAt(sql`date_trunc('month', h.work_date)::date`)} end)::numeric / 60)::bigint as cost,
             date_trunc('month', h.work_date)::date as mon
        from app.subcontract_hours h join app.subcontracts s on s.id = h.subcontract_id
       where s.status in ('erteilt', 'beendet') and (s.billing = 'stunde' or h.regie)
         and coalesce(h.site_id, s.site_id) is not null
         and (s.price_cents is not null or h.regie)
         and h.work_date between date_trunc('month', ${from}::date)::date
                             and (date_trunc('month', ${to}::date) + interval '1 month' - interval '1 day')::date
         and ${siteId ? sql`coalesce(h.site_id, s.site_id) = ${siteId}` : sql`true`}
         and ${noInvoice(sql`date_trunc('month', h.work_date)::date`)}`;
  const base = await sql<{ site_id: string; cost: bigint; months: number }[]>`
    with m as (
      select generate_series(date_trunc('month', ${from}::date), date_trunc('month', ${to}::date), interval '1 month')::date as mon
    ),
    flat as (
      select s.site_id, ${priceAt(sql`m.mon`)}::bigint as cost, m.mon
        from app.subcontracts s
        join m on s.valid_from <= (m.mon + interval '1 month' - interval '1 day')::date
              and (s.valid_to is null or s.valid_to >= m.mon)
       where s.status in ('erteilt', 'beendet') and s.billing = 'pauschale_monat' and s.site_id is not null
         and not exists (select 1 from app.subcontract_sites x where x.subcontract_id = s.id)
         and s.price_cents is not null
         and ${siteId ? sql`s.site_id = ${siteId}` : sql`true`}
         and ${noInvoice(sql`m.mon`)}
    ),
    hrs as (${hours}
    )
    select site_id, sum(cost)::bigint as cost, count(distinct mon)::int as months
      from (select * from flat union all select * from hrs) x
     group by site_id`;
  // „je Tag“ (Ahmed 22.10.): Preis des Monats × Arbeitstage (Wochentage ohne Feiertage/Schließzeiten)
  const dayRows = await sql<
    {
      id: string;
      site_id: string;
      work_days: number[] | null;
      valid_from: string;
      valid_to: string | null;
      mon: string;
      price: bigint;
    }[]
  >`
    select s.id, s.site_id, s.work_days, s.valid_from::text, s.valid_to::text, to_char(m.mon, 'YYYY-MM') as mon,
           ${priceAt(sql`m.mon`)}::bigint as price
      from app.subcontracts s
      join (select generate_series(date_trunc('month', ${from}::date), date_trunc('month', ${to}::date), interval '1 month')::date as mon) m
        on s.valid_from <= (m.mon + interval '1 month' - interval '1 day')::date and (s.valid_to is null or s.valid_to >= m.mon)
     where s.status in ('erteilt', 'beendet') and s.billing = 'tag' and s.site_id is not null
       and not exists (select 1 from app.subcontract_sites x where x.subcontract_id = s.id)
       and s.price_cents is not null
       and ${siteId ? sql`s.site_id = ${siteId}` : sql`true`}
       and ${noInvoice(sql`m.mon`)}`;
  if (dayRows.length) {
    const cl = await orderClosures(sql, [...new Set(dayRows.map((r) => r.id))]);
    const byId = new Map(base.map((b) => [b.site_id, b]));
    const extraMonths = new Map<string, Set<string>>();
    for (const r of dayRows) {
      const { days } = countDays(r.mon, {
        workDays: r.work_days,
        validFrom: r.valid_from,
        validTo: r.valid_to,
        closures: cl.filter((c) => c.subcontract_id === r.id),
      });
      if (!days) continue;
      const b = byId.get(r.site_id) ?? { site_id: r.site_id, cost: 0n, months: 0 };
      b.cost = BigInt(b.cost) + BigInt(r.price) * BigInt(days);
      const ms = extraMonths.get(r.site_id) ?? new Set<string>();
      if (!ms.has(r.mon)) {
        ms.add(r.mon);
        b.months += 1;
      }
      extraMonths.set(r.site_id, ms);
      if (!byId.has(r.site_id)) {
        byId.set(r.site_id, b);
        base.push(b);
      }
    }
  }
  // Sammelbestellungen (mehrere Objekte): je Objekt nach Fläche bzw. Umsatzanteil (Ahmed 19.10.)
  const sammel = await sql<
    { id: string; billing: string; frequency: string; margin_bp: number | null; mon: string; price: bigint }[]
  >`
    select s.id, s.billing, s.frequency, s.margin_bp, to_char(m.mon, 'YYYY-MM') as mon,
           ${priceAt(sql`m.mon`)}::bigint as price
      from app.subcontracts s
      join (select generate_series(date_trunc('month', ${from}::date), date_trunc('month', ${to}::date), interval '1 month')::date as mon) m
        on s.valid_from <= (m.mon + interval '1 month' - interval '1 day')::date and (s.valid_to is null or s.valid_to >= m.mon)
     where s.status in ('erteilt', 'beendet')
       and exists (select 1 from app.subcontract_sites x where x.subcontract_id = s.id)
       and (s.billing in ('pauschale_monat', 'umsatz') or (s.billing = 'qm' and s.frequency = 'monatlich'))
       and ${siteId ? sql`exists (select 1 from app.subcontract_sites x where x.subcontract_id = s.id and x.site_id = ${siteId})` : sql`true`}`;
  if (!sammel.length) return base;
  const booked = new Set(
    opts.plan
      ? []
      : (
          await sql<{ k: string }[]>`
        select distinct a.site_id || '|' || to_char(a.month, 'YYYY-MM') as k
          from app.incoming_cost_lines a join app.incoming_invoices i on i.id = a.incoming_invoice_id
         where i.category = 'nachunternehmer' and i.status in ('erfasst', 'freigegeben', 'bezahlt')
           and a.month between date_trunc('month', ${from}::date) and ${to}::date`
        ).map((r) => r.k),
  );
  const acc = new Map<string, { cost: bigint; months: Set<string> }>();
  for (const b of base)
    acc.set(b.site_id, {
      cost: b.cost,
      months: new Set(Array.from({ length: b.months }, (_, i) => `b${i}`)),
    });
  for (const r of sammel)
    for (const x of await sammelMonthCost(
      sql,
      { id: r.id, billing: r.billing, price_cents: r.price, margin_bp: r.margin_bp },
      r.mon,
    )) {
      if ((siteId && x.site_id !== siteId) || booked.has(`${x.site_id}|${r.mon}`) || x.cost === 0n) continue;
      const e = acc.get(x.site_id) ?? { cost: 0n, months: new Set<string>() };
      e.cost += x.cost;
      e.months.add(r.mon);
      acc.set(x.site_id, e);
    }
  return [...acc].map(([site_id, e]) => ({ site_id, cost: e.cost, months: e.months.size }));
}

/** Internes Objekt „Sonderreinigung“ (Migration 20261124000002) – Erlös der Leistungsarten „Sonderreinigung“. */
export const SPECIAL_SITE_ID = 'fd5b5bba-dc84-810d-e8aa-ae9f1b1135db';

export interface OverheadRates {
  minijob: number;
  parttime: number;
  fulltime: number;
}

export function monthRange(month: string) {
  const from = `${month}-01`;
  const to = addDays(`${addDays(from, 32).slice(0, 7)}-01`, -1);
  return { from, to };
}

/** Allgemeine Kostenstelle (Büro, Fahrzeuge …) – nur Kosten, kein Erlös/Lohn je Objekt. */
export interface GeneralCost {
  cost_center_id: string;
  number: string;
  name: string;
  material: bigint;
  subcontractor: bigint;
  equipment: bigint;
  other: bigint;
  total: bigint;
}

/**
 * Nachkalkulation und Kostenstellen in einem (Ahmed 09.10.: „stimmen nicht überein, mach daraus eins“):
 * Zeitraum = ein Monat oder von–bis (JJJJ-MM). Erlös aus eigenen UND übernommenen Fortytools-Rechnungen (je Position
 * dem Objekt zugeordnet); Objekte auch inaktiv, sobald im Zeitraum Erlös, Zeiten oder Kosten anfallen; dazu die
 * allgemeinen Kostenstellen.
 */
export interface RevenueLine {
  /** null = Rechnung an den Kunden ohne Objekt (Kunde hat weder „Allgemein“ noch genau ein Objekt) */
  site_id: string | null;
  customer_id: string | null;
  invoice_id: string;
  legacy: boolean;
  number: string;
  kind: string;
  issue_date: string;
  period: string | null;
  net: bigint;
}

/**
 * Erlöse nach Leistungszeitraum: jede Rechnungsposition (eigene und von vor der Umstellung) wird tageweise auf die
 * Monate ihres Leistungszeitraums verteilt (Position, sonst Rechnung, ohne Zeitraum Rechnungsdatum) und je Monat auf
 * Cent gerundet – wie die Statistik. Gezählt wird nur der Anteil im Bereich von–bis, je Objekt und Rechnung.
 * Leistungsarten „Sonderreinigung“ → internes Objekt Sonderreinigung (falls vorhanden).
 * Rechnungen an den Kunden ohne Objekt (Ahmed 02.11.: „auch Rechnungen zum Kunden beachten“) zählen beim Objekt
 * „Allgemein“ des Kunden, sonst bei seinem einzigen Objekt, sonst ohne Objekt (site_id null) beim Kunden.
 */
export function revenueLines(sql: Sql, from: string, to: string) {
  return sql<RevenueLine[]>`
    with src as (
      select case when st.special_cleaning and sp.id is not null then sp.id
                  else coalesce(ss.site_id, i.site_id,
                 (select g.id from app.sites g where g.customer_id = i.customer_id
                    and g.name in ('Allgemein', 'Allgemein (aus Fortytools)') order by g.active desc, g.site_no limit 1),
                 (select min(g.id::text)::uuid from app.sites g where g.customer_id = i.customer_id having count(*) = 1)) end as site_id,
             i.customer_id, i.id as invoice_id, false as legacy, i.number, i.kind::text as kind, i.issue_date,
             l.net_cents,
             coalesce(l.period_start, i.period_start, i.issue_date) as s,
             case when l.period_start is not null then coalesce(l.period_end, l.period_start)
                  else coalesce(i.period_end, i.period_start, i.issue_date) end as e
        from app.invoices i join app.invoice_lines l on l.invoice_id = i.id
        left join app.site_services ss on ss.id = l.source_service_id
        left join app.service_types st on st.id = coalesce(l.service_type_id, ss.service_type_id)
        left join app.sites sp on sp.id = ${SPECIAL_SITE_ID}
       where i.status = 'issued'
      union all
      select case when st.special_cleaning and sp.id is not null then sp.id
                  else coalesce(l.site_id, (select g.id from app.sites g where g.customer_id = i.customer_id
                    and g.name in ('Allgemein', 'Allgemein (aus Fortytools)') order by g.active desc, g.site_no limit 1),
                 (select min(g.id::text)::uuid from app.sites g where g.customer_id = i.customer_id having count(*) = 1)) end,
             i.customer_id, i.id, true, i.number, 'invoice', i.issue_date, l.net_cents,
             coalesce(l.period_start, i.issue_date),
             coalesce(l.period_end, l.period_start, i.issue_date)
        from app.legacy_invoice_lines l join app.legacy_invoices i on i.id = l.invoice_id
        left join app.service_types st on lower(st.name) = lower(trim(l.service_type))
        left join app.sites sp on sp.id = ${SPECIAL_SITE_ID}
    ), norm as (
      select site_id, customer_id, invoice_id, legacy, number, kind, issue_date, net_cents, s, greatest(e, s) as e from src
       where s <= ${to}::date and greatest(e, s) >= ${from}::date
    ), seg as (
      select n.*, gs::date as ms, (gs + interval '1 month - 1 day')::date as me
        from norm n, generate_series(date_trunc('month', greatest(n.s, ${from}::date)),
                                     date_trunc('month', least(n.e, ${to}::date)), interval '1 month') gs
    ), part as (
      select site_id, customer_id, invoice_id, legacy, number, kind, issue_date, s, e, ms,
             round(sum(net_cents::numeric * ((least(e, me, ${to}::date) - greatest(s, ms, ${from}::date)) + 1)
                       / ((e - s) + 1)))::bigint as net
        from seg
       where greatest(s, ms, ${from}::date) <= least(e, me, ${to}::date)
       group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
    )
    select site_id, customer_id, invoice_id, legacy, number, kind, issue_date::text as issue_date,
           to_char(min(s), 'DD.MM.YYYY') || case when max(e) > min(s) then ' – ' || to_char(max(e), 'DD.MM.YYYY') else '' end as period,
           sum(net)::bigint as net
      from part group by 1, 2, 3, 4, 5, 6, 7`;
}

export async function siteCosting(
  sql: Sql,
  period: string | { from: string; to: string },
  siteId?: string,
  opts: { cachedLabor?: boolean } = {},
): Promise<{ rows: SiteCosting[]; general: GeneralCost[]; overhead: OverheadRates; targetBp: number }> {
  const pf = typeof period === 'string' ? period : period.from;
  const pt = typeof period === 'string' ? period : period.to;
  const from = monthRange(pf).from;
  const to = monthRange(pt).to;
  const settings = await getAccountingSettings(sql);
  const nuEst = await subcontractEstimates(sql, from, to, siteId);
  const shares = await laborFromPayroll(sql, from, to, { cached: !!opts.cachedLabor });
  const laborSites = [...new Set(shares.filter((x) => x.site_id && x.cost).map((x) => x.site_id))];
  const revenue = await revenueLines(sql, from, to);
  const revSites = [...new Set(revenue.flatMap((r) => (r.site_id ? [r.site_id] : [])))];
  const [sites, labor, stock, incoming, shifts, general] = await Promise.all([
    sql<
      {
        id: string;
        site_no: string;
        name: string;
        customer_id: string;
        customer_name: string;
        customer_no: string | null;
        manager_user_id: string | null;
        internal: boolean;
      }[]
    >`
      select s.id, s.site_no, s.name, s.street, s.city, s.customer_id, s.manager_user_id,
             c.name as customer_name, c.customer_no, coalesce(c.is_internal, false) and s.id <> ${SPECIAL_SITE_ID} as internal
        from app.sites s join app.customers c on c.id = s.customer_id
       where ${
         siteId
           ? sql`s.id = ${siteId}`
           : sql`(s.active or exists (select 1 from app.cost_allocations a where a.site_id = s.id and a.month between ${from} and ${to})
                  or exists (select 1 from app.time_entries t where t.site_id = s.id and t.work_date between ${from} and ${to})
                  or s.id = any(${nuEst.map((x) => x.site_id)}::uuid[])
                  or s.id = any(${laborSites}::uuid[])
                  or s.id = any(${revSites}::uuid[]))`
       }
       order by s.site_no`,
    // Ist-Stunden (Anzeige); der Lohn kommt aus den Lohnarten (laborFromPayroll, unten)
    sql<{ site_id: string; minutes: number }[]>`
      select t.site_id, sum(extract(epoch from (t.end_at - t.start_at)) / 60 - t.break_minutes)::int as minutes
        from app.time_entries t
       where t.status in ('erfasst', 'freigegeben') and t.work_date between ${from} and ${to}
       group by t.site_id`,
    sql<{ site_id: string; cost: bigint }[]>`
      select site_id, coalesce(sum(cost), 0)::bigint as cost from (
        select m.site_id, round(-m.delta_milli * coalesce(m.unit_cost_cents, a.purchase_price_cents, 0) / 1000.0) as cost
          from app.stock_movements m join app.articles a on a.id = m.article_id
         where m.site_id is not null and (m.delta_milli < 0 or m.material_issue_id is not null)
           and coalesce(m.booked_on, (m.created_at at time zone 'Europe/Berlin')::date) between ${from} and ${to}
        union all
        -- freie Artikel der Materialausgabe (ohne Lager), stornierte zählen nicht
        select mi.site_id, l.net_cents
          from app.material_issue_lines l join app.material_issues mi on mi.id = l.issue_id
         where l.article_id is null and mi.issue_date between ${from} and ${to}
           and not exists (select 1 from app.material_issue_cancellations x where x.issue_id = mi.id)
      ) mat group by site_id`,
    // Eingangsrechnungen (auch Nachunternehmer) nach Aufteilung auf Kostenstelle = Objekt und Leistungsmonat
    sql<{ site_id: string; category: string; net: bigint }[]>`
      select a.site_id, i.category::text as category, sum(a.net_cents)::bigint as net
        from app.incoming_cost_lines a join app.incoming_invoices i on i.id = a.incoming_invoice_id
       where a.site_id is not null and i.status in ('erfasst', 'freigegeben', 'bezahlt')
         and a.month between ${from} and ${to}
       group by a.site_id, i.category`,
    plannedShifts(sql, { from, to, ...(siteId ? { siteId } : {}) }),
    siteId
      ? Promise.resolve([])
      : sql<{ id: string; number: string; name: string; category: string; net: bigint }[]>`
          select cc.id, cc.number, cc.name, i.category::text as category, sum(a.net_cents)::bigint as net
            from app.incoming_cost_lines a join app.cost_centers cc on cc.id = a.cost_center_id
            join app.incoming_invoices i on i.id = a.incoming_invoice_id
           where a.cost_center_id is not null and i.status in ('erfasst', 'freigegeben', 'bezahlt')
             and a.month between ${from} and ${to}
           group by 1, 2, 3, 4 order by cc.number`,
  ]);
  const revBySite = new Map<string, bigint>();
  const revByCustomer = new Map<string, bigint>();
  for (const r of revenue) {
    if (r.site_id) revBySite.set(r.site_id, (revBySite.get(r.site_id) ?? 0n) + r.net);
    else if (r.customer_id)
      revByCustomer.set(r.customer_id, (revByCustomer.get(r.customer_id) ?? 0n) + r.net);
  }
  const rows: SiteCosting[] = sites.map((s) => {
    const rev = revBySite.get(s.id) ?? 0n;
    const l = labor.find((r) => r.site_id === s.id);
    // Lohn laut Lohnarten + Lohnzuschlag, nach bezahlten Minuten auf die Objekte verteilt
    const mine = shares.filter((x) => x.site_id === s.id);
    const laborCents = mine.reduce((a, x) => a + x.cost, 0n);
    const inc = incoming.filter((r) => r.site_id === s.id);
    // Material für Büro/Lager (interne Bereiche) zählt nicht (Ahmed 27.10.): es kommt über die Materialausgabe
    // beim Objekt an und stünde sonst doppelt in der Kalkulation
    const material = s.internal
      ? 0n
      : (stock.find((r) => r.site_id === s.id)?.cost ?? 0n) +
        inc.filter((r) => r.category === 'material').reduce((a, r) => a + r.net, 0n);
    const est = nuEst.find((r) => r.site_id === s.id)?.cost ?? 0n;
    const sub = inc.filter((r) => r.category === 'nachunternehmer').reduce((a, r) => a + r.net, 0n) + est;
    const equipment = inc.filter((r) => r.category === 'geraete').reduce((a, r) => a + r.net, 0n);
    const other = inc
      .filter((r) => !['material', 'nachunternehmer', 'geraete'].includes(r.category))
      .reduce((a, r) => a + r.net, 0n);
    const margin = rev - laborCents - material - sub - equipment - other;
    return {
      site_id: s.id,
      site_no: s.site_no,
      site_name: s.name,
      customer_id: s.customer_id,
      customer_name: s.customer_name,
      customer_no: s.customer_no,
      manager_user_id: s.manager_user_id,
      revenue: rev,
      planned_minutes: shifts
        .filter((x) => x.plan.site_id === s.id && !x.absence)
        .reduce((a, x) => a + x.minutes, 0),
      actual_minutes: l?.minutes ?? 0,
      labor: laborCents,
      missing_wage: mine.filter((x) => x.wage_assumed).length,
      material,
      subcontractor: sub,
      subcontractor_estimated: est,
      equipment,
      other,
      margin,
      margin_bp: rev !== 0n ? Number((margin * 10000n) / rev) : null,
      internal: s.internal,
    };
  });
  // Rechnungen an den Kunden ohne Objekt: eigene Zeile je Kunde (site_id = Kunden-ID, customer_only)
  if (!siteId && revByCustomer.size) {
    const custs = await sql<{ id: string; name: string; customer_no: string | null }[]>`
      select id, name, customer_no from app.customers where id = any(${[...revByCustomer.keys()]}::uuid[])`;
    for (const k of custs) {
      const rev = revByCustomer.get(k.id) ?? 0n;
      if (rev === 0n) continue;
      rows.push({
        site_id: k.id,
        site_no: k.customer_no ?? '',
        site_name: 'Kunde – ohne Objekt',
        customer_id: k.id,
        customer_name: k.name,
        customer_no: k.customer_no,
        manager_user_id: null,
        revenue: rev,
        planned_minutes: 0,
        actual_minutes: 0,
        labor: 0n,
        missing_wage: 0,
        material: 0n,
        subcontractor: 0n,
        subcontractor_estimated: 0n,
        equipment: 0n,
        other: 0n,
        margin: rev,
        margin_bp: 10000,
        internal: false,
        customer_only: true,
      });
    }
  }
  const gmap = new Map<string, GeneralCost>();
  for (const g of general) {
    // Material an allgemeinen Kostenstellen (Lager, Büro) nicht zählen – geht über die Materialausgabe ans Objekt
    if (g.category === 'material') continue;
    const e = gmap.get(g.id) ?? {
      cost_center_id: g.id,
      number: g.number,
      name: g.name,
      material: 0n,
      subcontractor: 0n,
      equipment: 0n,
      other: 0n,
      total: 0n,
    };
    if (g.category === 'material') e.material += g.net;
    else if (g.category === 'nachunternehmer') e.subcontractor += g.net;
    else if (g.category === 'geraete') e.equipment += g.net;
    else e.other += g.net;
    e.total += g.net;
    gmap.set(g.id, e);
  }
  // wiederkehrende Zahlungen mit Kostenstelle (Miete, Versicherung, Leasing …; Ahmed 26.10.)
  if (!siteId) {
    const rec = await recurringCosts(sql, from, to);
    if (rec.length) {
      const ccs = await sql<{ id: string; number: string; name: string }[]>`
        select id, number, name from app.cost_centers where id in ${sql([...new Set(rec.map((r) => r.cost_center_id))])}`;
      for (const r of rec) {
        const cc = ccs.find((x) => x.id === r.cost_center_id);
        if (!cc || r.category === 'material') continue;
        const e = gmap.get(cc.id) ?? {
          cost_center_id: cc.id,
          number: cc.number,
          name: cc.name,
          material: 0n,
          subcontractor: 0n,
          equipment: 0n,
          other: 0n,
          total: 0n,
        };
        if (r.category === 'material') e.material += r.net;
        else if (r.category === 'geraete') e.equipment += r.net;
        else e.other += r.net;
        e.total += r.net;
        gmap.set(cc.id, e);
      }
    }
  }
  return {
    rows,
    general: [...gmap.values()].sort((a, b) => a.number.localeCompare(b.number)),
    overhead: {
      minijob: settings.overhead_minijob_bp,
      parttime: settings.overhead_parttime_bp,
      fulltime: settings.overhead_fulltime_bp,
    },
    targetBp: settings.target_margin_bp,
  };
}

/** Eingangsrechnungen eines Objekts im Zeitraum (Leistungsmonat der Aufteilung) – „wo ist meine Rechnung?“. */
export async function siteCostDetails(sql: Sql, siteId: string, period: { from: string; to: string }) {
  const from = monthRange(period.from).from;
  const to = monthRange(period.to).to;
  return sql<
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
           i.category::text as category, i.status::text as status, to_char(a.month, 'YYYY-MM') as month,
           sum(a.net_cents)::bigint as net
      from app.incoming_cost_lines a join app.incoming_invoices i on i.id = a.incoming_invoice_id
      join app.suppliers s on s.id = i.supplier_id
     where a.site_id = ${siteId} and a.month between ${from} and ${to}
     group by 1, 2, 3, 4, 5, 6, 7 order by 7, 4`;
}
