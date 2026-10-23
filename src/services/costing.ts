import { countDays } from './subcontract-days.js';
import { sammelMonthCost } from './subcontract-sites.js';
import type { Sql } from '../db/client.js';
import { addDays } from '../domain/time/holidays.js';
import { getAccountingSettings } from './datev.js';
import { plannedShifts } from './time.js';

/*
 * Nachkalkulation je Objekt und Monat:
 *   Erlös (netto, ausgestellte Rechnungen inkl. Storno/Korrektur; Leistungszeitraum, sonst Rechnungsdatum)
 * − Lohnkosten (Ist-Stunden × Stundenlohn × (1 + Zuschlag für AG-Anteile, Urlaub, Krankheit, Feiertage));
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
    : sql`select s.site_id,
             round(h.persons * h.minutes_per_person * ${priceAt(sql`date_trunc('month', h.work_date)::date`)}::numeric / 60)::bigint as cost,
             date_trunc('month', h.work_date)::date as mon
        from app.subcontract_hours h join app.subcontracts s on s.id = h.subcontract_id
       where s.status in ('erteilt', 'beendet') and s.billing = 'stunde' and s.site_id is not null
         and s.price_cents is not null
         and h.work_date between date_trunc('month', ${from}::date)::date
                             and (date_trunc('month', ${to}::date) + interval '1 month' - interval '1 day')::date
         and ${siteId ? sql`s.site_id = ${siteId}` : sql`true`}
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
    const cl = await sql<{ subcontract_id: string; date_from: string; date_to: string }[]>`
      select subcontract_id, date_from::text, date_to::text from app.subcontract_closures
       where subcontract_id in ${sql([...new Set(dayRows.map((r) => r.id))])}`;
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
          from app.cost_allocations a join app.incoming_invoices i on i.id = a.incoming_invoice_id
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
export async function siteCosting(
  sql: Sql,
  period: string | { from: string; to: string },
  siteId?: string,
): Promise<{ rows: SiteCosting[]; general: GeneralCost[]; overhead: OverheadRates; targetBp: number }> {
  const pf = typeof period === 'string' ? period : period.from;
  const pt = typeof period === 'string' ? period : period.to;
  const from = monthRange(pf).from;
  const to = monthRange(pt).to;
  const settings = await getAccountingSettings(sql);
  const nuEst = await subcontractEstimates(sql, from, to, siteId);
  const [sites, revenue, legacyRevenue, labor, stock, incoming, shifts, general] = await Promise.all([
    sql<
      {
        id: string;
        site_no: string;
        name: string;
        customer_id: string;
        customer_name: string;
        manager_user_id: string | null;
      }[]
    >`
      select s.id, s.site_no, s.name, s.street, s.city, s.customer_id, s.manager_user_id,
             c.name as customer_name from app.sites s join app.customers c on c.id = s.customer_id
       where ${
         siteId
           ? sql`s.id = ${siteId}`
           : sql`(s.active or exists (select 1 from app.cost_allocations a where a.site_id = s.id and a.month between ${from} and ${to})
                  or exists (select 1 from app.time_entries t where t.site_id = s.id and t.work_date between ${from} and ${to})
                  or s.id = any(${nuEst.map((x) => x.site_id)}::uuid[]))`
       }
       order by s.site_no`,
    // je Position: Objekt aus der Leistung (Sammelrechnungen der Rechnungsgruppen haben kein Objekt im Kopf);
    // Leistungsarten „Sonderreinigung“ → internes Objekt Sonderreinigung (falls vorhanden)
    sql<{ site_id: string; net: bigint }[]>`
      select case when st.special_cleaning and sp.id is not null then sp.id
                  else coalesce(ss.site_id, i.site_id) end as site_id, sum(l.net_cents)::bigint as net
        from app.invoices i join app.invoice_lines l on l.invoice_id = i.id
        left join app.site_services ss on ss.id = l.source_service_id
        left join app.service_types st on st.id = coalesce(l.service_type_id, ss.service_type_id)
        left join app.sites sp on sp.id = ${SPECIAL_SITE_ID}
       where i.status = 'issued' and coalesce(ss.site_id, i.site_id) is not null
         and coalesce(i.period_start, i.issue_date) between ${from} and ${to}
       group by 1`,
    // übernommene Fortytools-Rechnungen: Position mit Objekt, Leistungszeitraum sonst Rechnungsdatum
    sql<{ site_id: string; net: bigint }[]>`
      select case when st.special_cleaning and sp.id is not null then sp.id else l.site_id end as site_id,
             sum(l.net_cents)::bigint as net
        from app.legacy_invoice_lines l join app.legacy_invoices i on i.id = l.invoice_id
        left join app.service_types st on lower(st.name) = lower(trim(l.service_type))
        left join app.sites sp on sp.id = ${SPECIAL_SITE_ID}
       where l.site_id is not null and coalesce(l.period_start, i.issue_date) between ${from} and ${to}
       group by 1`,
    // Lohn je Eintrag: Minuten × Stundenlohn / 60 (Cent-genau, kaufmännisch gerundet je Objekt)
    sql<{ site_id: string; minutes: number; wage_minutes_cents: bigint; missing: number }[]>`
      select t.site_id,
             sum(extract(epoch from (t.end_at - t.start_at)) / 60 - t.break_minutes)::int as minutes,
             -- ohne hinterlegte Vergütung: niedrigster aktiver Tariflohn (als „angenommen“ gekennzeichnet)
             coalesce(sum(((extract(epoch from (t.end_at - t.start_at)) / 60 - t.break_minutes)::bigint)
                          * coalesce(app.effective_wage_cents(e),
                                     (select min(w.hourly_wage_cents) from app.wage_levels w where w.active))
                          -- Geschäftsführer (Tag) ohne Zuschlag (Ahmed 23.10.)
                          * (10000 + case when exists (select 1 from unnest(coalesce(e.tags, '{}')) t
                                                        where t ~* 'gesch(ä|ae)ftsf(ü|ue)hr') then 0
                                          when e.employment_type = 'minijob' then ${settings.overhead_minijob_bp}::int
                                          when coalesce(e.weekly_hours, case when e.employment_type = 'vollzeit' then 40 else 0 end) > 30
                                            then ${settings.overhead_fulltime_bp}::int
                                          else ${settings.overhead_parttime_bp}::int end)), 0)::bigint as wage_minutes_cents,
             count(*) filter (where app.effective_wage_cents(e) is null)::int as missing
        from app.time_entries t join app.employees e on e.id = t.employee_id
       where t.status in ('erfasst', 'freigegeben') and t.work_date between ${from} and ${to}
       group by t.site_id`,
    sql<{ site_id: string; cost: bigint }[]>`
      select m.site_id,
             coalesce(sum(round(-m.delta_milli * coalesce(m.unit_cost_cents, a.purchase_price_cents, 0) / 1000.0)), 0)::bigint as cost
        from app.stock_movements m join app.articles a on a.id = m.article_id
       where m.site_id is not null and (m.delta_milli < 0 or m.material_issue_id is not null)
         and coalesce(m.booked_on, (m.created_at at time zone 'Europe/Berlin')::date) between ${from} and ${to}
       group by m.site_id`,
    // Eingangsrechnungen (auch Nachunternehmer) nach Aufteilung auf Kostenstelle = Objekt und Leistungsmonat
    sql<{ site_id: string; category: string; net: bigint }[]>`
      select a.site_id, i.category::text as category, sum(a.net_cents)::bigint as net
        from app.cost_allocations a join app.incoming_invoices i on i.id = a.incoming_invoice_id
       where a.site_id is not null and i.status in ('erfasst', 'freigegeben', 'bezahlt')
         and a.month between ${from} and ${to}
       group by a.site_id, i.category`,
    plannedShifts(sql, { from, to, ...(siteId ? { siteId } : {}) }),
    siteId
      ? Promise.resolve([])
      : sql<{ id: string; number: string; name: string; category: string; net: bigint }[]>`
          select cc.id, cc.number, cc.name, i.category::text as category, sum(a.net_cents)::bigint as net
            from app.cost_allocations a join app.cost_centers cc on cc.id = a.cost_center_id
            join app.incoming_invoices i on i.id = a.incoming_invoice_id
           where a.cost_center_id is not null and i.status in ('erfasst', 'freigegeben', 'bezahlt')
             and a.month between ${from} and ${to}
           group by 1, 2, 3, 4 order by cc.number`,
  ]);
  const rows = sites.map((s) => {
    const rev =
      (revenue.find((r) => r.site_id === s.id)?.net ?? 0n) +
      (legacyRevenue.find((r) => r.site_id === s.id)?.net ?? 0n);
    const l = labor.find((r) => r.site_id === s.id);
    // Cent je Minute × (10000 + Zuschlag in Basispunkten) → / 60 / 10000, kaufmännisch gerundet
    const laborCents = l ? (l.wage_minutes_cents + 300000n) / 600000n : 0n;
    const inc = incoming.filter((r) => r.site_id === s.id);
    const material =
      (stock.find((r) => r.site_id === s.id)?.cost ?? 0n) +
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
      manager_user_id: s.manager_user_id,
      revenue: rev,
      planned_minutes: shifts
        .filter((x) => x.plan.site_id === s.id && !x.absence)
        .reduce((a, x) => a + x.minutes, 0),
      actual_minutes: l?.minutes ?? 0,
      labor: laborCents,
      missing_wage: l?.missing ?? 0,
      material,
      subcontractor: sub,
      subcontractor_estimated: est,
      equipment,
      other,
      margin,
      margin_bp: rev !== 0n ? Number((margin * 10000n) / rev) : null,
    };
  });
  const gmap = new Map<string, GeneralCost>();
  for (const g of general) {
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
  return {
    rows,
    general: [...gmap.values()],
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
      from app.cost_allocations a join app.incoming_invoices i on i.id = a.incoming_invoice_id
      join app.suppliers s on s.id = i.supplier_id
     where a.site_id = ${siteId} and a.month between ${from} and ${to}
     group by 1, 2, 3, 4, 5, 6, 7 order by 7, 4`;
}
