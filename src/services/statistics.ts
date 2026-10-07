import type { Sql } from '../db/client.js';

/*
 * Umsatz-Statistik wie Fortytools (Auswertungen → Statistiken): eigene Rechnungen und das Fortytools-Rechnungsarchiv
 * zusammen, ohne Unterschied. Grundlage Leistungszeitraum: jede Position wird tageweise auf die Monate ihres
 * Leistungszeitraums verteilt und je Monat auf Cent gerundet (so rechnet Fortytools – am Export geprüft: alle Monate
 * 11/2025–10/2026 centgenau gleich). Grundlage Rechnungsdatum: ganze Position im Monat des Rechnungsdatums.
 * Stornos/Korrekturen mindern (negative Beträge). Abschläge, die in einer Schlussrechnung verrechnet sind, zählen nicht
 * (sonst doppelt).
 */

export type StatBasis = 'leistung' | 'rechnung';
export type StatGroup = 'monat' | 'quartal' | 'jahr';

export interface StatFilter {
  from: string;
  to: string;
  basis: StatBasis;
  group: StatGroup;
  customerId?: string | null;
}

export interface Stats {
  periods: { key: string; cents: bigint }[];
  total: bigint;
  /** Summe nach Rechnungsdatum (Grundlage für Kunden/Leistungsarten) */
  shareTotal: bigint;
  customers: { id: string | null; name: string; cents: bigint }[];
  types: { name: string; cents: bigint }[];
}

type Row = { month: string; customer_id: string | null; customer: string; type: string; cents: bigint };

async function lineRows(sql: Sql, f: StatFilter, rechnung: boolean) {
  const cust = f.customerId ? sql`and customer_id = ${f.customerId}` : sql``;
  return sql<Row[]>`
    with src as (
      select x.net_cents, l.issue_date, l.customer_id, coalesce(c.name, 'Kunde ' || l.customer_no, 'ohne Kunde') as customer,
             coalesce(nullif(x.service_type, ''), 'ohne Leistungsart') as type,
             coalesce(x.period_start, l.issue_date) as s,
             greatest(coalesce(x.period_end, x.period_start, l.issue_date), coalesce(x.period_start, l.issue_date)) as e
        from app.legacy_invoice_lines x join app.legacy_invoices l on l.id = x.invoice_id
        left join app.customers c on c.id = l.customer_id
      union all
      select il.net_cents, i.issue_date, i.customer_id, c.name, coalesce(t.name, 'ohne Leistungsart'),
             coalesce(i.period_start, i.issue_date),
             greatest(coalesce(i.period_end, i.period_start, i.issue_date), coalesce(i.period_start, i.issue_date))
        from app.invoice_lines il join app.invoices i on i.id = il.invoice_id
        join app.customers c on c.id = i.customer_id
        left join app.service_types t on t.id = il.service_type_id
       where i.status = 'issued'
         and not exists (select 1 from app.invoice_prepayments p where p.partial_invoice_id = i.id)
    ), base as (
      select net_cents, customer_id, customer, type,
             ${rechnung ? sql`issue_date` : sql`s`} as s, ${rechnung ? sql`issue_date` : sql`e`} as e
        from src where true ${cust}
    ), seg as (
      select b.*, gs::date as ms, (gs + interval '1 month - 1 day')::date as me
        from base b, generate_series(date_trunc('month', b.s), date_trunc('month', b.e), interval '1 month') gs
    )
    select to_char(ms, 'YYYY-MM') as month, customer_id, customer, type,
           sum(round(net_cents::numeric
                     * ((least(e, me, ${f.to}::date) - greatest(s, ms, ${f.from}::date)) + 1)
                     / ((e - s) + 1)))::bigint as cents
      from seg
     where greatest(s, ms, ${f.from}::date) <= least(e, me, ${f.to}::date)
     group by 1, 2, 3, 4`;
}

export async function revenueStats(sql: Sql, f: StatFilter): Promise<Stats> {
  const rows = await lineRows(sql, f, f.basis === 'rechnung');
  // Kunden und Leistungsarten rechnet Fortytools immer nach Rechnungsdatum (am Export geprüft) → ebenso
  const byDate = f.basis === 'rechnung' ? rows : await lineRows(sql, f, true);
  const keyOf = (m: string) =>
    f.group === 'jahr'
      ? m.slice(0, 4)
      : f.group === 'quartal'
        ? `${m.slice(0, 4)}-Q${Math.floor((Number(m.slice(5, 7)) - 1) / 3) + 1}`
        : m;
  // alle Zeiträume des Bereichs zeigen (auch ohne Umsatz)
  const keys: string[] = [];
  for (
    let d = new Date(`${f.from.slice(0, 7)}-01T12:00:00Z`);
    d.toISOString().slice(0, 7) <= f.to.slice(0, 7);
  ) {
    const k = keyOf(d.toISOString().slice(0, 7));
    if (!keys.includes(k)) keys.push(k);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  const per = new Map<string, bigint>(keys.map((k) => [k, 0n]));
  const byCust = new Map<string, { id: string | null; name: string; cents: bigint }>();
  const byType = new Map<string, bigint>();
  let total = 0n;
  let shareTotal = 0n;
  for (const r of rows) {
    const k = keyOf(r.month);
    per.set(k, (per.get(k) ?? 0n) + r.cents);
    total += r.cents;
  }
  for (const r of byDate) {
    shareTotal += r.cents;
    const ck = r.customer_id ?? r.customer;
    const c = byCust.get(ck) ?? { id: r.customer_id, name: r.customer, cents: 0n };
    c.cents += r.cents;
    byCust.set(ck, c);
    byType.set(r.type, (byType.get(r.type) ?? 0n) + r.cents);
  }
  const desc = (a: { cents: bigint }, b: { cents: bigint }) =>
    b.cents > a.cents ? 1 : b.cents < a.cents ? -1 : 0;
  return {
    periods: [...per.entries()].map(([key, cents]) => ({ key, cents })),
    total,
    shareTotal,
    customers: [...byCust.values()].filter((c) => c.cents !== 0n).sort(desc),
    types: [...byType.entries()]
      .map(([name, cents]) => ({ name, cents }))
      .filter((t) => t.cents !== 0n)
      .sort(desc),
  };
}
