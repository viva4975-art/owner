import type { Sql } from '../db/client.js';
import { EXPENSE_CATEGORY } from './bank.js';
import type { StatGroup } from './statistics.js';

/*
 * Ausgaben-Statistik (Ahmed 08.10.: „Ausgaben analysieren, Diagramme wie bei der Rechnungs-Statistik“).
 * Grundlage „Konto“: alle Kontoausgänge (brutto, nach Buchungstag) – Kostenart aus der zugeordneten Eingangsrechnung,
 * sonst aus der Zuordnung (Kostenart, Mitarbeiter = Personal, Zahlungslauf), sonst „noch nicht zugeordnet“.
 * Grundlage „Eingangsrechnungen“: netto nach Rechnungsdatum (Korrekturen mindern).
 */

export type ExpenseBasis = 'konto' | 'rechnung';

export interface ExpenseStats {
  periods: { key: string; cents: bigint }[];
  total: bigint;
  count: number;
  categories: { key: string; name: string; cents: bigint }[];
  payees: { id: string | null; name: string; cents: bigint }[];
}

const CATEGORY_NAME: Record<string, string> = {
  ...EXPENSE_CATEGORY,
  zahlungslauf: 'Eingangsrechnungen (SEPA-Zahlungslauf)',
  offen: 'noch nicht zugeordnet',
};

export async function expenseStats(
  sql: Sql,
  f: { from: string; to: string; group: StatGroup; basis: ExpenseBasis },
): Promise<ExpenseStats> {
  const rows =
    f.basis === 'konto'
      ? await sql<{ d: string; cents: bigint; cat: string; sid: string | null; who: string }[]>`
          select t.booking_date::text as d, (-t.amount_cents)::bigint as cents,
                 coalesce(ii.category::text, t.expense_category,
                          case when t.assigned_kind = 'mitarbeiter' then 'personal' end,
                          case when t.note like 'Zahlungslauf %' then 'zahlungslauf' end, 'offen') as cat,
                 s.id as sid,
                 coalesce(s.name, case when t.assigned_kind = 'mitarbeiter' then 'Mitarbeiter (Lohn u. a.)' end,
                          nullif(trim(t.counterparty_name), ''), 'unbekannt') as who
            from app.bank_transactions t
            left join lateral (
              select category, supplier_id from app.incoming_invoices
               where bank_transaction_id = t.id order by gross_cents desc limit 1) ii on true
            left join app.suppliers s
              on s.id = coalesce(ii.supplier_id, case when t.assigned_kind = 'lieferant' then t.assigned_id end)
           where t.amount_cents < 0 and t.booking_date between ${f.from} and ${f.to}`
      : await sql<{ d: string; cents: bigint; cat: string; sid: string | null; who: string }[]>`
          select i.invoice_date::text as d, i.net_cents as cents, i.category::text as cat, s.id as sid, s.name as who
            from app.incoming_invoices i join app.suppliers s on s.id = i.supplier_id
           where i.invoice_date between ${f.from} and ${f.to}`;
  const keyOf = (m: string) =>
    f.group === 'jahr'
      ? m.slice(0, 4)
      : f.group === 'quartal'
        ? `${m.slice(0, 4)}-Q${Math.floor((Number(m.slice(5, 7)) - 1) / 3) + 1}`
        : m;
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
  const cats = new Map<string, bigint>();
  const who = new Map<string, { id: string | null; name: string; cents: bigint }>();
  let total = 0n;
  for (const r of rows) {
    const k = keyOf(r.d.slice(0, 7));
    per.set(k, (per.get(k) ?? 0n) + r.cents);
    total += r.cents;
    cats.set(r.cat, (cats.get(r.cat) ?? 0n) + r.cents);
    const wk = r.sid ?? r.who.toUpperCase();
    const w = who.get(wk) ?? { id: r.sid, name: r.who, cents: 0n };
    w.cents += r.cents;
    who.set(wk, w);
  }
  const desc = (a: { cents: bigint }, b: { cents: bigint }) =>
    b.cents > a.cents ? 1 : b.cents < a.cents ? -1 : 0;
  return {
    periods: [...per.entries()].map(([key, cents]) => ({ key, cents })),
    total,
    count: rows.length,
    categories: [...cats.entries()]
      .map(([key, cents]) => ({ key, name: CATEGORY_NAME[key] ?? key, cents }))
      .filter((c) => c.cents !== 0n)
      .sort(desc),
    payees: [...who.values()].filter((w) => w.cents !== 0n).sort(desc),
  };
}

/** Kontoeingänge im Zeitraum (für „Einnahmen − Ausgaben“ auf Konto-Grundlage). */
export async function bankIncome(sql: Sql, from: string, to: string) {
  const [r] = await sql<{ cents: bigint }[]>`
    select coalesce(sum(amount_cents), 0)::bigint as cents from app.bank_transactions
     where amount_cents > 0 and booking_date between ${from} and ${to}`;
  return r!.cents;
}

/** Offene Eingangsrechnungen (noch nicht bezahlt), brutto. */
export async function openIncoming(sql: Sql) {
  const [r] = await sql<{ cents: bigint; n: number; overdue: bigint }[]>`
    select coalesce(sum(gross_cents), 0)::bigint as cents, count(*)::int as n,
           coalesce(sum(gross_cents) filter (where due_date < (now() at time zone 'Europe/Berlin')::date), 0)::bigint as overdue
      from app.incoming_invoices where status in ('erfasst', 'freigegeben')`;
  return r!;
}
