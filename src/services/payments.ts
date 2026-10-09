import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '../db/client.js';
import { type Cents, parseEuro } from '../domain/money/money.js';
import { BusinessError } from './errors.js';

export interface OpenItem {
  invoice_id: string;
  number: string;
  kind: string;
  customer_id: string;
  customer_no: string;
  customer_name: string;
  site_name: string | null;
  issue_date: string;
  due_date: string;
  skonto_date: string | null;
  payable_cents: bigint;
  adjustments_cents: bigint;
  paid_cents: bigint;
  open_cents: bigint;
  overdue_days: number;
}

/** Offene Posten (Rechnung − Storno/Korrektur − Zahlungen ≠ 0). */
export async function listOpenItems(sql: Sql, customerId?: string) {
  return sql<OpenItem[]>`
    select o.*, c.customer_no, c.name as customer_name, s.name as site_name,
           greatest(0, (now() at time zone 'Europe/Berlin')::date - o.due_date)::int as overdue_days
      from app.open_items o
      join app.customers c on c.id = o.customer_id
      left join app.sites s on s.id = o.site_id
     where o.open_cents <> 0 and ${customerId ? sql`o.customer_id = ${customerId}` : sql`true`}
     order by c.name, o.due_date, o.number`;
}

/** Offene Posten wie Fortytools: je Rechnung Soll (Rechnung) und Haben (Zahlungen, Storno/Korrektur). */
export interface LedgerEntry {
  date: string;
  label: string;
  cents: bigint; // positiv = Haben (mindert die Forderung)
  href: string | null;
  skonto?: boolean; // Skonto-Abzug (eigene Spalte in der Kundenübersicht)
}
export async function openItemLedger(
  sql: Sql,
  f: { customerId?: string; q?: string | null; overdueOnly?: boolean } = {},
) {
  let items: (OpenItem & { legacy?: boolean })[] = [
    ...(await listOpenItems(sql, f.customerId)),
    ...(await listLegacyOpenItems(sql, f.customerId)),
  ];
  const t = f.q?.trim().toLowerCase();
  if (t)
    items = items.filter((i) => `${i.customer_no} ${i.customer_name} ${i.number}`.toLowerCase().includes(t));
  if (f.overdueOnly) items = items.filter((i) => i.overdue_days > 0);
  const ids = items.filter((i) => !i.legacy).map((i) => i.invoice_id);
  const lids = items.filter((i) => i.legacy).map((i) => i.invoice_id);
  const [lpays, ladj] = lids.length
    ? await Promise.all([
        sql<
          {
            invoice_id: string;
            paid_on: string;
            method: string;
            amount_cents: bigint;
            reference: string | null;
          }[]
        >`
          select invoice_id, paid_on::text, method, amount_cents, reference from app.legacy_payments
           where invoice_id = any(${lids}::uuid[]) order by paid_on, created_at`,
        // Korrekturen derselben Fortytools-Gruppe (negativ, noch offen) mindern die erste offene Rechnung
        sql<{ for_id: string; id: string; number: string; issue_date: string; gross_cents: bigint }[]>`
          select o.invoice_id as for_id, k.id, k.number, k.issue_date::text, k.gross_cents
            from app.legacy_open_items o join app.legacy_invoices l on l.id = o.invoice_id
            join app.legacy_invoices k on k.ft_root_id = l.ft_root_id and not k.paid and k.gross_cents < 0
                 and k.customer_id is not distinct from l.customer_id
           where o.invoice_id = any(${lids}::uuid[]) and l.id = (
             select p.id from app.legacy_invoices p where p.ft_root_id = l.ft_root_id and not p.paid
                and p.gross_cents > 0 order by p.number limit 1)`,
      ])
    : [[], []];
  const [lpart] = lids.length
    ? await sql<{ m: Record<string, string> | null }[]>`
        select jsonb_object_agg(id, paid_part_cents::text) as m from app.legacy_invoices
         where id = any(${lids}::uuid[]) and paid_part_cents > 0`
    : [{ m: null }];
  const [pays, adj] = ids.length
    ? await Promise.all([
        sql<
          {
            invoice_id: string;
            paid_on: string;
            method: string;
            amount_cents: bigint;
            reference: string | null;
          }[]
        >`
          select invoice_id, paid_on, method::text, amount_cents, reference from app.payments
           where invoice_id = any(${ids}::uuid[]) order by paid_on, created_at`,
        sql<
          {
            id: string;
            original_invoice_id: string;
            number: string;
            issue_date: string;
            kind: string;
            payable_cents: bigint;
          }[]
        >`
          select id, original_invoice_id, number, issue_date, kind::text, payable_cents from app.invoices
           where original_invoice_id = any(${ids}::uuid[]) and status = 'issued' order by issue_date`,
      ])
    : [[], []];
  const METHOD: Record<string, string> = {
    ueberweisung: 'Zahlung',
    lastschrift: 'Lastschrift',
    bar: 'Barzahlung',
    skonto: 'Skonto-Abzug',
    verrechnung: 'Verrechnung',
    korrektur: 'Korrekturbuchung',
  };
  const byCustomer = new Map<
    string,
    {
      customer_id: string;
      customer_no: string;
      customer_name: string;
      open_cents: bigint;
      items: (OpenItem & { legacy?: boolean; haben: LedgerEntry[] })[];
    }
  >();
  for (const i of items) {
    if (i.legacy) {
      const own = lpays.filter((p) => p.invoice_id === i.invoice_id);
      const booked = own.reduce((a, p) => a + p.amount_cents, 0n);
      const part = BigInt(lpart?.m?.[i.invoice_id] ?? '0');
      const haben: LedgerEntry[] = [
        ...ladj
          .filter((a) => a.for_id === i.invoice_id)
          .map((a) => ({
            date: a.issue_date,
            label: `Korrektur ${a.number}`,
            cents: -a.gross_cents,
            href: `/rechnungen/${a.id}`,
          })),
        ...own.map((p) => ({
          date: p.paid_on,
          label: `${p.method === 'skonto' ? 'Skonto-Abzug' : 'Zahlung'}${p.reference ? ` (${p.reference})` : ''}`,
          cents: p.amount_cents,
          href: null,
          skonto: p.method === 'skonto',
        })),
        ...(part > booked
          ? [{ date: i.issue_date, label: 'Teilzahlung (früher erfasst)', cents: part - booked, href: null }]
          : []),
      ].sort((a, b) => a.date.localeCompare(b.date));
      const g = byCustomer.get(i.customer_id) ?? {
        customer_id: i.customer_id,
        customer_no: i.customer_no,
        customer_name: i.customer_name,
        open_cents: 0n,
        items: [],
      };
      g.open_cents += i.open_cents;
      g.items.push({ ...i, haben });
      byCustomer.set(i.customer_id, g);
      continue;
    }
    const haben: LedgerEntry[] = [
      ...adj
        .filter((a) => a.original_invoice_id === i.invoice_id)
        .map((a) => ({
          date: a.issue_date,
          label: `${a.kind === 'cancellation' ? 'Storno' : 'Rechnungskorrektur'} ${a.number}`,
          cents: -a.payable_cents,
          href: `/rechnungen/${a.id}`,
        })),
      ...pays
        .filter((p) => p.invoice_id === i.invoice_id)
        .map((p) => ({
          date: p.paid_on,
          label: `${METHOD[p.method] ?? p.method}${p.reference ? ` (${p.reference})` : ''}`,
          cents: p.amount_cents,
          href: null,
          skonto: p.method === 'skonto',
        })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    const g = byCustomer.get(i.customer_id) ?? {
      customer_id: i.customer_id,
      customer_no: i.customer_no,
      customer_name: i.customer_name,
      open_cents: 0n,
      items: [],
    };
    g.open_cents += i.open_cents;
    g.items.push({ ...i, haben });
    byCustomer.set(i.customer_id, g);
  }
  // größte Forderung zuerst, Rechnungen je Kunde neueste zuerst (wie Fortytools)
  const groups = [...byCustomer.values()].sort((a, b) =>
    b.open_cents > a.open_cents ? 1 : b.open_cents < a.open_cents ? -1 : 0,
  );
  for (const g of groups) g.items.sort((a, b) => b.number.localeCompare(a.number));
  return groups;
}

export interface CustomerBalance {
  customer_id: string;
  customer_no: string;
  customer_name: string;
  items: number;
  open_cents: bigint;
  /** noch nicht fällig */
  due_cents: bigint;
  overdue_cents: bigint;
  max_overdue_days: number;
  /** Tage bis zur nächsten Fälligkeit (negativ = so viele Tage überfällig), wie Fortytools */
  days: number;
}

/** Wie Fortytools „Offene Posten“ auf der Startseite: je Kunde offen / überfällig / Summe, Tage bis fällig.
 *  Enthält die offenen Rechnungen aus Fortytools (Storno/Korrektur mit der Rechnung verrechnet). */
export async function listBalances(sql: Sql) {
  return sql<CustomerBalance[]>`
    with o as (
      select customer_id, open_cents, due_date from app.open_items where open_cents <> 0
      union all
      select customer_id, open_cents, due_date from app.legacy_open_items
       where customer_id is not null and open_cents <> 0
    ), t as (select (now() at time zone 'Europe/Berlin')::date as today)
    select c.id as customer_id, c.customer_no, c.name as customer_name, count(*)::int as items,
           sum(o.open_cents)::bigint as open_cents,
           coalesce(sum(o.open_cents) filter (where o.due_date >= t.today), 0)::bigint as due_cents,
           coalesce(sum(o.open_cents) filter (where o.due_date < t.today), 0)::bigint as overdue_cents,
           coalesce(max(greatest(0, t.today - o.due_date)), 0)::int as max_overdue_days,
           coalesce(min(o.due_date - t.today), 0)::int as days
      from o cross join t join app.customers c on c.id = o.customer_id
     group by c.id having sum(o.open_cents) <> 0 order by c.name`;
}

export interface PaymentRow {
  id: string;
  invoice_id: string;
  amount_cents: bigint;
  paid_on: string;
  method: string;
  reference: string | null;
  note: string | null;
  reverses_payment_id: string | null;
  reversed: boolean;
  created_by: string;
  created_at: Date;
}

export async function listPayments(sql: Sql, invoiceId: string) {
  return sql<PaymentRow[]>`
    select p.*, exists (select 1 from app.payments r where r.reverses_payment_id = p.id) as reversed
      from app.payments p where p.invoice_id = ${invoiceId} order by p.paid_on, p.created_at`;
}

export const PAYMENT_METHODS = {
  ueberweisung: 'Überweisung',
  lastschrift: 'Lastschrift',
  bar: 'Bar',
  skonto: 'Skonto-Abzug',
  verrechnung: 'Verrechnung',
  korrektur: 'Korrekturbuchung',
} as const;

export const paymentInput = z.object({
  amount: z.string().transform((v, ctx) => {
    try {
      const c = parseEuro(v);
      if (c <= 0n) throw new RangeError('Betrag muss größer 0 sein');
      return c;
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: `Betrag: ${(e as Error).message}` });
      return z.NEVER;
    }
  }),
  paid_on: z.iso.date('Datum fehlt'),
  method: z.enum(['ueberweisung', 'lastschrift', 'bar', 'skonto', 'verrechnung']),
  reference: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() ? v.trim() : null),
    z.string().nullable(),
  ),
});

/**
 * Zahlung buchen. `id` vom Formular → doppeltes Absenden bucht nicht doppelt.
 * Überzahlung wird abgelehnt (Rest bitte als Verrechnung/Rückzahlung klären).
 */
export async function bookPayment(
  sql: Sql,
  id: string,
  invoiceId: string,
  input: z.infer<typeof paymentInput>,
  actor: string,
) {
  await sql.begin(async (tx) => {
    await tx`select 1 from app.invoices where id = ${invoiceId} for update`;
    const [exists] = await tx`select 1 from app.payments where id = ${id}`;
    if (exists) return;
    const [item] = await tx<
      { open_cents: bigint }[]
    >`select open_cents from app.open_items where invoice_id = ${invoiceId}`;
    if (!item)
      throw new BusinessError('Zahlungen nur auf ausgestellte Rechnungen (nicht auf Storno/Korrektur)');
    if (input.amount > item.open_cents) {
      throw new BusinessError(
        'Betrag ist höher als der offene Posten – Überzahlung bitte klären (Verrechnung/Rückzahlung)',
      );
    }
    await tx`insert into app.payments (id, invoice_id, amount_cents, paid_on, method, reference, created_by)
             values (${id}, ${invoiceId}, ${input.amount}, ${input.paid_on}, ${input.method}, ${input.reference}, ${actor})`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'payment', 'invoice', ${invoiceId}, ${tx.json({ amount_cents: String(input.amount), method: input.method })})`;
  });
}

/** Fehlbuchung korrigieren: Gegenbuchung mit negativem Betrag (Original bleibt sichtbar). */
export async function reversePayment(sql: Sql, paymentId: string, actor: string, note: string | null) {
  await sql.begin(async (tx) => {
    const [p] = await tx<PaymentRow[]>`select * from app.payments where id = ${paymentId} for update`;
    if (!p) throw new BusinessError('Zahlung nicht gefunden');
    if (p.reverses_payment_id)
      throw new BusinessError('Eine Korrekturbuchung kann nicht erneut korrigiert werden');
    const [done] = await tx`select 1 from app.payments where reverses_payment_id = ${paymentId}`;
    if (done) return;
    await tx`insert into app.payments (invoice_id, amount_cents, paid_on, method, reference, note, reverses_payment_id, created_by)
             values (${p.invoice_id}, ${-p.amount_cents}, (now() at time zone 'Europe/Berlin')::date, 'korrektur',
                     ${p.reference}, ${note}, ${p.id}, ${actor})`;
  });
}

/** Offene Fortytools-Rechnungen im Format der offenen Posten (Storno/Korrektur der Gruppe verrechnet). */
export async function listLegacyOpenItems(sql: Sql, customerId?: string) {
  const rows = await sql<(OpenItem & { legacy: boolean })[]>`
    select o.invoice_id, o.number, 'invoice' as kind, o.customer_id, c.customer_no, c.name as customer_name,
           null::text as site_name, o.issue_date::text, coalesce(o.due_date, o.issue_date)::text as due_date,
           null::text as skonto_date, o.gross_cents as payable_cents, 0::bigint as adjustments_cents,
           (o.gross_cents - o.open_cents)::bigint as paid_cents, o.open_cents,
           greatest(0, (now() at time zone 'Europe/Berlin')::date - coalesce(o.due_date, o.issue_date))::int
             as overdue_days, true as legacy
      from app.legacy_open_items o join app.customers c on c.id = o.customer_id
     where o.open_cents <> 0 and ${customerId ? sql`o.customer_id = ${customerId}` : sql`true`}`;
  return rows;
}

/**
 * Zahlung auf einen offenen Posten wie in Fortytools: Betrag eingeben, Rest bleibt offen (Teilzahlung) oder wird als
 * Skonto ausgebucht. Gilt für eigene Rechnungen und für Rechnungen aus Fortytools. Feste IDs aus `batchId` → doppelt
 * absenden bucht nichts doppelt.
 */
export async function settleOpenItem(
  sql: Sql,
  p: {
    batchId: string;
    invoiceId: string;
    legacy: boolean;
    amount: bigint;
    date: string;
    rest: 'offen' | 'skonto';
    reference: string | null;
    actor: string;
  },
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new BusinessError('Zahlungsdatum fehlt');
  if (p.amount < 0n) throw new BusinessError('Betrag darf nicht negativ sein');
  const pid = (k: string) => idFrom(`${p.batchId}:${p.invoiceId}:${k}`);
  if (!p.legacy) {
    const [o] = await sql<{ open_cents: bigint }[]>`
      select open_cents from app.open_items where invoice_id = ${p.invoiceId}`;
    if (!o) throw new BusinessError('Rechnung ist nicht (mehr) offen');
    const [done] =
      await sql`select 1 from app.payments where id = ${pid('zahlung')} or id = ${pid('skonto')}`;
    if (done) return { paid: 0n, skonto: 0n };
    if (p.amount > o.open_cents)
      throw new BusinessError('Betrag ist höher als der offene Posten – Überzahlung bitte klären');
    if (p.amount > 0n)
      await bookPayment(
        sql,
        pid('zahlung'),
        p.invoiceId,
        { amount: p.amount as Cents, paid_on: p.date, method: 'ueberweisung', reference: p.reference },
        p.actor,
      );
    const rest = o.open_cents - p.amount;
    if (p.rest === 'skonto' && rest > 0n)
      await bookPayment(
        sql,
        pid('skonto'),
        p.invoiceId,
        { amount: rest as Cents, paid_on: p.date, method: 'skonto', reference: 'Rest als Skonto' },
        p.actor,
      );
    return { paid: p.amount, skonto: p.rest === 'skonto' ? rest : 0n };
  }
  return sql.begin(async (tx) => {
    await tx`select 1 from app.legacy_invoices where id = ${p.invoiceId} for update`;
    const [done] =
      await tx`select 1 from app.legacy_payments where id = ${pid('zahlung')} or id = ${pid('skonto')}`;
    if (done) return { paid: 0n, skonto: 0n };
    const [o] = await tx<{ open_cents: bigint }[]>`
      select open_cents from app.legacy_open_items where invoice_id = ${p.invoiceId}`;
    if (!o) throw new BusinessError('Rechnung ist nicht (mehr) offen');
    if (p.amount > o.open_cents) throw new BusinessError('Betrag ist höher als der offene Betrag');
    const rest = o.open_cents - p.amount;
    if (p.amount > 0n)
      await tx`insert into app.legacy_payments (id, invoice_id, amount_cents, paid_on, method, reference, created_by)
               values (${pid('zahlung')}, ${p.invoiceId}, ${p.amount}, ${p.date}, 'zahlung', ${p.reference}, ${p.actor})`;
    if (p.rest === 'skonto' && rest > 0n)
      await tx`insert into app.legacy_payments (id, invoice_id, amount_cents, paid_on, method, reference, created_by)
               values (${pid('skonto')}, ${p.invoiceId}, ${rest}, ${p.date}, 'skonto', 'Rest als Skonto', ${p.actor})`;
    if (rest === 0n || p.rest === 'skonto')
      await tx`update app.legacy_invoices set paid = true, paid_at = ${p.date}, paid_marked_by = ${p.actor},
                      paid_part_cents = paid_part_cents + ${p.amount}
                where id = ${p.invoiceId}`;
    else
      await tx`update app.legacy_invoices set paid_part_cents = paid_part_cents + ${p.amount} where id = ${p.invoiceId}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${p.actor}, 'payment', 'legacy_invoice', ${p.invoiceId},
                     ${tx.json({ amount_cents: String(p.amount), rest: p.rest, rest_cents: String(rest) })})`;
    return { paid: p.amount, skonto: p.rest === 'skonto' ? rest : 0n };
  });
}

/** Feste UUID aus einem Schlüssel (v4-Format). */
function idFrom(key: string) {
  const h = createHash('md5').update(key).digest('hex').split('');
  h[12] = '4';
  h[16] = '89ab'[parseInt(h[16]!, 16) & 3]!;
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
