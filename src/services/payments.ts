import { z } from 'zod';
import type { Sql } from '../db/client.js';
import { parseEuro } from '../domain/money/money.js';
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
  let items: OpenItem[] = [...(await listOpenItems(sql, f.customerId))];
  const t = f.q?.trim().toLowerCase();
  if (t)
    items = items.filter((i) => `${i.customer_no} ${i.customer_name} ${i.number}`.toLowerCase().includes(t));
  if (f.overdueOnly) items = items.filter((i) => i.overdue_days > 0);
  const ids = items.map((i) => i.invoice_id);
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
      items: (OpenItem & { haben: LedgerEntry[] })[];
    }
  >();
  for (const i of items) {
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
  max_overdue_days: number;
}

/** Wie Fortytools „Offene Posten“ auf der Startseite: Summe je Kunde, Anzahl, ältester Verzug. */
export async function listBalances(sql: Sql) {
  return sql<CustomerBalance[]>`
    select c.id as customer_id, c.customer_no, c.name as customer_name, count(*)::int as items,
           sum(o.open_cents)::bigint as open_cents,
           max(greatest(0, (now() at time zone 'Europe/Berlin')::date - o.due_date))::int as max_overdue_days
      from app.open_items o join app.customers c on c.id = o.customer_id
     where o.open_cents <> 0
     group by c.id order by c.name`;
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
