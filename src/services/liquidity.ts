import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, isoWeekday } from '../domain/time/holidays.js';
import { revenueForecast } from './reports.js';

/*
 * Liquiditätsvorschau (Ahmed 11.10.) für die Startseite: Kontostand heute, dann je Kalenderwoche
 *  + offene Ausgangsrechnungen nach Fälligkeit (eigene + vor der Umstellung; überfällige in der ersten Woche),
 *  + erwartete Monatsrechnungen der regelmäßigen Leistungen, die noch nicht abgerechnet sind (Schätzung, Eingang ~20.),
 *  − offene Eingangsrechnungen nach Fälligkeit (abzüglich verrechneter Vorschüsse),
 *  − laufende Ausgaben ohne Eingangsrechnung (Lohn, Steuern, Sozialversicherung, Miete …) = Ø der letzten 3 Monate
 *    aus den Kontoumsätzen, gleichmäßig auf die Tage verteilt.
 * Alles Schätzung: Kunden zahlen nicht immer pünktlich, Lohn fällt nicht gleichmäßig an.
 */

export interface LiquidityWeek {
  from: string;
  to: string;
  kw: number;
  inflow: bigint;
  outflow: bigint;
  balance: bigint;
}
export interface LiquidityForecast {
  start: bigint | null;
  startDate: string | null;
  weeks: LiquidityWeek[];
  overdueIn: bigint;
  overdueOut: bigint;
  expectedRuns: bigint;
  regularMonthly: bigint;
  low: LiquidityWeek | null;
}

const isoWeek = (d: string) => {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - y.getTime()) / 86_400_000 + 1) / 7);
};
const monthAdd = (m: string, n: number) => {
  const d = new Date(`${m}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};
/** half-up auf Cent */
const mulDiv = (a: bigint, num: bigint, den: bigint) => (a * num * 2n + den) / (den * 2n);

export async function liquidityForecast(
  sql: Sql,
  today = todayBerlin(),
  weeks = 8,
): Promise<LiquidityForecast> {
  const monday = addDays(today, 1 - isoWeekday(today));
  const end = addDays(monday, weeks * 7 - 1);
  const [bal] = await sql<{ cents: bigint | null; d: string | null }[]>`
    select sum(balance_cents)::bigint as cents, max(balance_date)::text as d
      from app.bank_feed_accounts where active and balance_cents is not null`;
  const items = await sql<{ due: string; cents: bigint }[]>`
    select due_date::text as due, open_cents as cents from app.open_items where open_cents > 0
    union all
    select coalesce(due_date, issue_date)::text, open_cents from app.legacy_open_items where open_cents > 0`;
  const bills = await sql<{ due: string; cents: bigint }[]>`
    select i.due_date::text as due,
           (i.gross_cents - coalesce((select sum(o.amount_cents) from app.subcontractor_advance_offsets o
                                       where o.incoming_invoice_id = i.id), 0))::bigint as cents
      from app.incoming_invoices i where i.status in ('erfasst', 'freigegeben')`;
  // laufende Ausgaben ohne Eingangsrechnung: Ø der letzten 3 vollen Monate
  const m0 = today.slice(0, 7);
  const [reg] = await sql<{ cents: bigint }[]>`
    select coalesce(sum(-t.amount_cents), 0)::bigint as cents from app.bank_transactions t
     where t.amount_cents < 0 and t.booking_date >= ${`${monthAdd(m0, -3)}-01`}::date
       and t.booking_date < ${`${m0}-01`}::date
       and not exists (select 1 from app.incoming_invoices i where i.bank_transaction_id = t.id)
       and coalesce(t.note, '') not like 'Zahlungslauf %'
       and coalesce(t.expense_category, '') <> 'privat'`;
  const regularMonthly = mulDiv(reg!.cents, 1n, 3n);
  // erwartete Monatsrechnungen: Monate im Zeitraum, für die noch kein Monatslauf lief
  const months: string[] = [];
  for (let m = m0; `${m}-01` <= end; m = monthAdd(m, 1)) months.push(m);
  const fc = await revenueForecast(sql, m0, months.length);
  const ran = new Set(
    (
      await sql<{ m: string }[]>`
        select distinct month as m from app.monthly_run_services where month >= ${m0}`
    ).map((r) => r.m),
  );
  const runs: { due: string; cents: bigint }[] = [];
  months.forEach((m, i) => {
    if (ran.has(m)) return;
    const gross = mulDiv(fc.totals[i] ?? 0n, 119n, 100n);
    if (gross <= 0n) return;
    const due = `${m}-20` < today ? addDays(today, 14) : `${m}-20`;
    runs.push({ due, cents: gross });
  });

  const weekOf = (d: string) =>
    d < monday
      ? 0
      : Math.floor((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${monday}T12:00:00Z`)) / (7 * 86_400_000));
  const inW = Array.from({ length: weeks }, () => 0n);
  const outW = Array.from({ length: weeks }, () => 0n);
  let overdueIn = 0n;
  let overdueOut = 0n;
  for (const x of items) {
    if (x.due < today) overdueIn += x.cents;
    const w = weekOf(x.due < today ? today : x.due);
    if (w < weeks) inW[w]! += x.cents;
  }
  for (const x of runs) {
    const w = weekOf(x.due);
    if (w < weeks) inW[w]! += x.cents;
  }
  for (const x of bills) {
    if (x.due < today) overdueOut += x.cents;
    const w = weekOf(x.due < today ? today : x.due);
    if (w < weeks) outW[w]! += x.cents;
  }
  const out: LiquidityWeek[] = [];
  let balance = bal?.cents ?? 0n;
  for (let w = 0; w < weeks; w++) {
    const from = addDays(monday, w * 7);
    const to = addDays(from, 6);
    // laufende Ausgaben je Tag, erste Woche nur ab heute
    const days = w === 0 ? 7 - (isoWeekday(today) - 1) : 7;
    const regular = mulDiv(regularMonthly * BigInt(days), 100n, 3044n);
    const outflow = outW[w]! + regular;
    balance += inW[w]! - outflow;
    out.push({ from, to, kw: isoWeek(from), inflow: inW[w]!, outflow, balance });
  }
  const low = out.reduce<LiquidityWeek | null>((a, w) => (!a || w.balance < a.balance ? w : a), null);
  return {
    start: bal?.cents ?? null,
    startDate: bal?.d ?? null,
    weeks: out,
    overdueIn,
    overdueOut,
    expectedRuns: runs.reduce((a, r) => a + r.cents, 0n),
    regularMonthly,
    low,
  };
}
