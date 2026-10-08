import type { Sql } from '../db/client.js';
import { monthBounds, monthlyRunLines } from '../domain/invoice/calc.js';
import { lineNet } from '../domain/money/money.js';
import { addDays, workingDays } from '../domain/time/holidays.js';
import { type LeaveBalance, leaveBalance } from './absences.js';
import { BusinessError } from './errors.js';
import { sollPlanIst } from './hr-month.js';
import { type RunService, toRunService } from './invoices.js';
import { lineRows } from './statistics.js';
import { plannedShifts } from './time.js';

/*
 * Auswertungen wie Fortytools. Alle Beträge in Cent (bigint), Zeiten in Minuten.
 */

export const nextMonth = (m: string, n = 1) => {
  const i = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
};

// ------------------------------------------------------------------ Rechnungs-Statistik

export interface InvoiceMonthStat {
  month: string;
  invoices: number;
  invoice_net: bigint;
  reversals: number; // Storno + Korrektur
  reversal_net: bigint;
  net: bigint;
}

/** Ausgestellte Belege je Monat eines Jahres, Kunden nach Umsatz, Zahlungsverhalten. */
export async function invoiceStatistics(sql: Sql, year: number) {
  // eigene Rechnungen und das Rechnungsarchiv aus Fortytools zusammen (negative Fortytools-Belege = Storno/Korrektur)
  const all = sql`
    select i.id, i.kind::text as kind, i.customer_id, i.issue_date, i.net_cents from app.invoices i where i.status = 'issued'
    union all
    select l.id, case when l.net_cents < 0 then 'correction' else 'invoice' end, l.customer_id, l.issue_date, l.net_cents
      from app.legacy_invoices l`;
  const months = await sql<InvoiceMonthStat[]>`
    with m as (select to_char(make_date(${year}::int, g, 1), 'YYYY-MM') as month from generate_series(1, 12) g),
         a as (${all})
    select m.month,
           count(i.id) filter (where i.kind in ('invoice', 'partial', 'final'))::int as invoices,
           coalesce(sum(i.net_cents) filter (where i.kind in ('invoice', 'partial', 'final')), 0)::bigint as invoice_net,
           count(i.id) filter (where i.kind in ('cancellation', 'correction'))::int as reversals,
           coalesce(sum(i.net_cents) filter (where i.kind in ('cancellation', 'correction')), 0)::bigint as reversal_net,
           coalesce(sum(i.net_cents), 0)::bigint as net
      from m left join a i on to_char(i.issue_date, 'YYYY-MM') = m.month
     group by m.month order by m.month`;
  const customers = await sql<
    { id: string; name: string; customer_no: string; count: number; net: bigint }[]
  >`
    with a as (${all})
    select c.id, c.name, c.customer_no, count(*) filter (where i.kind in ('invoice', 'partial', 'final'))::int as count,
           sum(i.net_cents)::bigint as net
      from a i join app.customers c on c.id = i.customer_id
     where extract(year from i.issue_date) = ${year}
     group by c.id order by net desc, c.name limit 15`;
  // Zahlungsdauer: vollständig bezahlte Rechnungen des Jahres, Tage vom Rechnungsdatum bis zur letzten Zahlung
  const [pay] = await sql<
    { paid: number; avg_days: number | null; late: number; open_cents: bigint; overdue_cents: bigint }[]
  >`
    with o as (select * from app.open_items where extract(year from issue_date) = ${year}),
         paid as (
           select o.invoice_id, o.due_date, max(p.paid_on) as last_paid, min(o.issue_date) as issue_date
             from o join app.payments p on p.invoice_id = o.invoice_id
            where o.open_cents = 0 group by o.invoice_id, o.due_date
           union all
           select l.id, l.due_date, l.paid_at, l.issue_date from app.legacy_invoices l
            where l.paid and l.paid_at is not null and l.gross_cents > 0 and extract(year from l.issue_date) = ${year}),
         op as (
           select open_cents, due_date from o where open_cents > 0
           union all
           select open_cents, due_date from app.legacy_open_items
            where open_cents > 0 and extract(year from issue_date) = ${year})
    select (select count(*) from paid)::int as paid,
           (select round(avg(last_paid - issue_date)) from paid)::int as avg_days,
           (select count(*) from paid where last_paid > due_date)::int as late,
           (select coalesce(sum(open_cents), 0) from op)::bigint as open_cents,
           (select coalesce(sum(open_cents), 0) from op
             where due_date < (now() at time zone 'Europe/Berlin')::date)::bigint as overdue_cents`;
  const total = months.reduce((a, m) => a + m.net, 0n);
  return { months, customers, payment: pay!, total };
}

// ------------------------------------------------------------------ Umsatz-Vorschau

export interface ForecastRow {
  customer_id: string;
  customer_name: string;
  customer_no: string;
  months: bigint[];
  total: bigint;
}

/**
 * Erwarteter Netto-Umsatz der nächsten Monate aus den regelmäßigen Leistungen (Pauschalen mit Abrechnungszyklus und
 * Gültigkeit) – genau wie der Abrechnungslauf rechnet. Regiestunden und Sonderleistungen sind nicht planbar.
 */
export async function revenueForecast(sql: Sql, fromMonth: string, count = 12) {
  const months = [...Array(count).keys()].map((i) => nextMonth(fromMonth, i));
  const services = await sql<
    (RunService & { customer_id: string; customer_name: string; customer_no: string })[]
  >`
    select ss.*, c.id as customer_id, c.name as customer_name, c.customer_no
      from app.site_services ss join app.sites s on s.id = ss.site_id join app.customers c on c.id = s.customer_id
     where ss.active and ss.kind = 'monthly_flat' and s.active and c.active
       and (ss.valid_to is null or ss.valid_to >= ${`${fromMonth}-01`})`;
  const rows = new Map<string, ForecastRow>();
  for (const sv of services) {
    const run = toRunService(sv);
    months.forEach((m, i) => {
      const [line] = monthlyRunLines([run], m);
      if (!line) return;
      const r = rows.get(sv.customer_id) ?? {
        customer_id: sv.customer_id,
        customer_name: sv.customer_name,
        customer_no: sv.customer_no,
        months: months.map(() => 0n),
        total: 0n,
      };
      const net = lineNet(line.quantity, line.unitPrice);
      r.months[i] = r.months[i]! + net;
      r.total += net;
      rows.set(sv.customer_id, r);
    });
  }
  const list = [...rows.values()].sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0));
  const totals = months.map((_, i) => list.reduce((a, r) => a + r.months[i]!, 0n));
  return { months, rows: list, totals, total: totals.reduce((a, b) => a + b, 0n) };
}

// ------------------------------------------------------------------ Stundenkontrolle

export interface HoursRow {
  id: string;
  name: string;
  personnel_no: string;
  weekly_hours: string | null;
  soll: number | null;
  plan: number;
  ist: number;
}

/** Soll / Plan / Ist aller aktiven Mitarbeitenden in einem Monat. */
export async function hoursControl(
  sql: Sql,
  month: string,
  group: string | null = null,
): Promise<HoursRow[]> {
  const { start, end } = monthBounds(month);
  const emps = await sql<{ id: string; name: string; personnel_no: string; weekly_hours: string | null }[]>`
    select id, last_name || ', ' || first_name as name, personnel_no, weekly_hours::text
      from app.employees
     where entry_date <= ${end} and (exit_date is null or exit_date >= ${start}) and status = 'aktiv'
       and ${group ? sql`planning_group = ${group}` : sql`true`}
     order by last_name, first_name`;
  const out: HoursRow[] = [];
  for (const e of emps) out.push({ ...e, ...(await sollPlanIst(sql, e.id, month)) });
  return out;
}

// ------------------------------------------------------------------ Ø Stundensätze je Objekt

export interface RateRow {
  site_id: string;
  site_no: string;
  site_name: string;
  customer_name: string;
  revenue: bigint;
  minutes: number;
  plan_minutes: number;
  /** Erlös je Ist-Stunde in Cent (null ohne Stunden) */
  per_hour: bigint | null;
  per_plan_hour: bigint | null;
  wage_avg: bigint | null; // Ø Stundenlohn der eingesetzten Mitarbeitenden (gewichtet nach Stunden)
}

/**
 * Erlös je Stunde über einen Zeitraum (Monate): Netto-Erlös (Positionen je Objekt, Leistungszeitraum) ÷ Ist-Stunden.
 * Zum Vergleich: Erlös je Plan-Stunde und Ø Stundenlohn.
 */
export async function hourlyRates(sql: Sql, fromMonth: string, toMonth: string): Promise<RateRow[]> {
  const from = monthBounds(fromMonth).start;
  const to = monthBounds(toMonth).end;
  const [sites, revenue, hours, shifts] = await Promise.all([
    sql<{ id: string; site_no: string; name: string; customer_name: string }[]>`
      select s.id, s.site_no, s.name, s.street, s.city, c.name as customer_name
        from app.sites s join app.customers c on c.id = s.customer_id where s.active order by s.site_no`,
    sql<{ site_id: string; net: bigint }[]>`
      select coalesce(ss.site_id, i.site_id) as site_id, sum(l.net_cents)::bigint as net
        from app.invoices i join app.invoice_lines l on l.invoice_id = i.id
        left join app.site_services ss on ss.id = l.source_service_id
       where i.status = 'issued' and coalesce(i.period_start, i.issue_date) between ${from} and ${to}
       group by 1`,
    sql<{ site_id: string; minutes: number; wage_minutes: bigint; wage_known_minutes: number }[]>`
      select t.site_id,
             sum(extract(epoch from (t.end_at - t.start_at)) / 60 - t.break_minutes)::int as minutes,
             coalesce(sum(((extract(epoch from (t.end_at - t.start_at)) / 60 - t.break_minutes)::bigint)
                          * app.effective_wage_cents(e)), 0)::bigint as wage_minutes,
             coalesce(sum(extract(epoch from (t.end_at - t.start_at)) / 60 - t.break_minutes)
                      filter (where app.effective_wage_cents(e) is not null), 0)::int as wage_known_minutes
        from app.time_entries t join app.employees e on e.id = t.employee_id
       where t.status in ('erfasst', 'freigegeben') and t.end_at is not null and t.work_date between ${from} and ${to}
       group by t.site_id`,
    plannedShifts(sql, { from, to }),
  ]);
  const div = (cents: bigint, minutes: number) =>
    minutes > 0 ? (cents * 60n * 2n + BigInt(minutes)) / (2n * BigInt(minutes)) : null; // kaufmännisch gerundet
  return sites
    .map((s) => {
      const rev = revenue.find((r) => r.site_id === s.id)?.net ?? 0n;
      const h = hours.find((r) => r.site_id === s.id);
      const plan = shifts
        .filter((x) => x.plan.site_id === s.id && !x.absence && !x.holiday)
        .reduce((a, x) => a + x.minutes, 0);
      const minutes = h?.minutes ?? 0;
      return {
        site_id: s.id,
        site_no: s.site_no,
        site_name: s.name,
        customer_name: s.customer_name,
        revenue: rev,
        minutes,
        plan_minutes: plan,
        per_hour: div(rev, minutes),
        per_plan_hour: div(rev, plan),
        wage_avg:
          h && h.wage_known_minutes > 0
            ? (h.wage_minutes * 2n + BigInt(h.wage_known_minutes)) / (2n * BigInt(h.wage_known_minutes))
            : null,
      };
    })
    .filter((r) => r.revenue !== 0n || r.minutes > 0 || r.plan_minutes > 0);
}

// ------------------------------------------------------------------ Urlaubskonten, Krankheitstage

export async function leaveAccounts(sql: Sql, year: number) {
  const emps = await sql<{ id: string; name: string; personnel_no: string }[]>`
    select id, last_name || ', ' || first_name as name, personnel_no from app.employees
     where status = 'aktiv' and entry_date <= ${`${year}-12-31`} and (exit_date is null or exit_date >= ${`${year}-01-01`})
     order by last_name, first_name`;
  const out: ({ id: string; name: string; personnel_no: string } & LeaveBalance)[] = [];
  for (const e of emps) out.push({ ...e, ...(await leaveBalance(sql, e.id, year)) });
  return out;
}

export interface SickRow {
  id: string;
  name: string;
  personnel_no: string;
  /** Arbeitstage krank je Monat (Index 0 = Januar), halbe Tage als 0,5 */
  months: number[];
  total: number;
  child: number; // davon Kind krank
  cases: number; // Krankmeldungen (Abwesenheiten)
  /** aus Fortytools übernommene Krankheitstage bis Stichtag (in `total` enthalten, nicht in `months`) */
  imported: number;
  importedAsOf: string | null;
}

/** Krankheitstage je Mitarbeiter und Monat (genehmigte Abwesenheiten „krank“ und „Kind krank“, Arbeitstage). */
export async function sickDays(sql: Sql, year: number): Promise<SickRow[]> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const rows = await sql<
    {
      employee_id: string;
      name: string;
      personnel_no: string;
      kind: string;
      start_date: string;
      end_date: string;
      half_day: boolean;
    }[]
  >`
    select a.employee_id, e.last_name || ', ' || e.first_name as name, e.personnel_no, a.kind::text, a.start_date,
           a.end_date, a.half_day
      from app.absences a join app.employees e on e.id = a.employee_id
     where a.status = 'genehmigt' and a.kind in ('krank', 'kind_krank') and a.start_date <= ${to} and a.end_date >= ${from}
     order by e.last_name, e.first_name`;
  // übernommener Stand aus Fortytools: eigene Krankmeldungen erst nach dem Stichtag zählen
  const openings = await sql<
    { employee_id: string; name: string; personnel_no: string; sick_as_of: string; sick_days: string }[]
  >`
    select o.employee_id, e.last_name || ', ' || e.first_name as name, e.personnel_no, o.sick_as_of::text,
           o.sick_days::text
      from app.leave_openings o join app.employees e on e.id = o.employee_id
     where o.year = ${year} and o.sick_as_of is not null`;
  const asOf = new Map(openings.map((o) => [o.employee_id, o.sick_as_of]));
  const map = new Map<string, SickRow>();
  const blank = (id: string, name: string, personnel_no: string): SickRow => ({
    id,
    name,
    personnel_no,
    months: Array<number>(12).fill(0),
    total: 0,
    child: 0,
    cases: 0,
    imported: 0,
    importedAsOf: null,
  });
  for (const o of openings) {
    const r = blank(o.employee_id, o.name, o.personnel_no);
    r.imported = Number(o.sick_days);
    r.importedAsOf = o.sick_as_of;
    r.total = r.imported;
    if (r.imported > 0) map.set(o.employee_id, r);
  }
  for (const a0 of rows) {
    const cut = asOf.get(a0.employee_id);
    if (cut && a0.end_date <= cut) continue;
    const a = cut && a0.start_date <= cut ? { ...a0, start_date: addDays(cut, 1) } : a0;
    const r = map.get(a.employee_id) ?? blank(a.employee_id, a.name, a.personnel_no);
    if (cut && !r.importedAsOf) {
      r.importedAsOf = cut;
    }
    r.cases++;
    for (let m = 0; m < 12; m++) {
      const { start, end } = monthBounds(`${year}-${String(m + 1).padStart(2, '0')}`);
      const s = a.start_date > start ? a.start_date : start;
      const e = a.end_date < end ? a.end_date : end;
      if (s > e) continue;
      const d = a.half_day ? workingDays(s, e) / 2 : workingDays(s, e);
      r.months[m]! += d;
      r.total += d;
      if (a.kind === 'kind_krank') r.child += d;
    }
    map.set(a.employee_id, r);
  }
  return [...map.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

// ------------------------------------------------------------------ Dienste-Liste

/** Alle Dienste (geplante Einsätze inkl. Vertretungen) eines Zeitraums, optional je Objekt/Mitarbeiter. */
export async function dutyList(
  sql: Sql,
  f: { from: string; to: string; siteId?: string; employeeId?: string; scope?: string[] | null },
) {
  if (f.to < f.from || addDays(f.from, 62) < f.to)
    throw new BusinessError('Zeitraum bitte höchstens 2 Monate');
  const list = await plannedShifts(sql, {
    from: f.from,
    to: f.to,
    ...(f.siteId ? { siteId: f.siteId } : {}),
    ...(f.employeeId ? { employeeId: f.employeeId } : {}),
  });
  return list.filter((s) => !f.scope || f.scope.includes(s.plan.site_id));
}

/** CSV für Excel (Semikolon, BOM). Zellen, die mit = + - @ beginnen, werden entschärft (Formel-Injektion). */
export function toCsv(head: string[], rows: (string | number)[][]): string {
  const cell = (v: string | number) => {
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?[\d.,:]+$/.test(s)) s = `'${s}`;
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [head, ...rows].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}

/**
 * Nicht monatliche Umsätze (Glas-, Grund-, Tiefgaragenreinigung, Sonderreinigung …) für die Umsatz-Vorschau
 * (Ahmed 08.10.): je Vorschau-Monat der Umsatz derselben Leistungsarten im selben Monat des Vorjahres (nach
 * Leistungszeitraum, eigene + Fortytools-Rechnungen wie die Statistik). Liefert Leistungsarten mit Jahresumsatz zur
 * Auswahl; Vorgabe = Leistungsarten ohne laufende monatliche Pauschale.
 */
export async function forecastPriorYear(sql: Sql, months: string[], types: string[] | null) {
  const first = months[0]!;
  const last = months[months.length - 1]!;
  const from = `${nextMonth(first, -12)}-01`;
  const lastPrev = nextMonth(last, -12);
  const to = monthBounds(lastPrev).end;
  const rows = await lineRows(sql, { from, to, basis: 'leistung', group: 'monat' }, false);
  const monthly = new Set(
    (
      await sql<{ name: string }[]>`
        select distinct t.name from app.site_services ss join app.service_types t on t.id = ss.service_type_id
         where ss.active and ss.kind = 'monthly_flat'
           and (ss.valid_to is null or ss.valid_to >= ${`${first}-01`})`
    ).map((r) => r.name),
  );
  const byType = new Map<string, bigint>();
  for (const r of rows) byType.set(r.type, (byType.get(r.type) ?? 0n) + r.cents);
  const available = [...byType.entries()]
    .filter(([, c]) => c > 0n)
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    .map(([name, cents]) => ({ name, cents, monthly: monthly.has(name) }));
  const chosen = new Set(
    types ??
      available
        .filter(
          (t) => !t.monthly && t.name !== 'ohne Leistungsart' && !/verkauf|fahrzeug|material/i.test(t.name),
        )
        .map((t) => t.name),
  );
  const perMonth = months.map(() => 0n);
  const perCustomer = new Map<string, { id: string | null; name: string; months: bigint[] }>();
  for (const r of rows) {
    if (!chosen.has(r.type)) continue;
    const i = months.indexOf(nextMonth(r.month, 12));
    if (i < 0) continue;
    perMonth[i] = perMonth[i]! + r.cents;
    const k = r.customer_id ?? r.customer;
    const pc = perCustomer.get(k) ?? { id: r.customer_id, name: r.customer, months: months.map(() => 0n) };
    pc.months[i] = pc.months[i]! + r.cents;
    perCustomer.set(k, pc);
  }
  return {
    available,
    chosen: [...chosen],
    perMonth,
    perCustomer,
    total: perMonth.reduce((a, b) => a + b, 0n),
  };
}
