/**
 * Vorschüsse an Nachunternehmer (Ahmed 09.10.): Zahlung vor der Rechnung festhalten und später mit
 * Eingangsrechnungen verrechnen – der Zahlbetrag der Rechnung (Zahlungsliste, SEPA, „als bezahlt“, Kontoumsätze)
 * sinkt um den verrechneten Teil. Löschen nur, solange nichts verrechnet ist (Stand ins Protokoll).
 */
import { randomUUID } from 'node:crypto';
import type { Sql, Tx } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from './errors.js';

export const ADVANCE_METHOD: Record<string, string> = {
  ueberweisung: 'Überweisung',
  bar: 'Bar',
  lastschrift: 'Lastschrift',
  kreditkarte: 'Kreditkarte',
};

export interface Advance {
  id: string;
  supplier_id: string;
  subcontract_id: string | null;
  subcontract_number: string | null;
  paid_on: string;
  amount_cents: bigint;
  method: string;
  purpose: string | null;
  bank_transaction_id: string | null;
  created_by: string;
  created_at: Date;
  used_cents: bigint;
  offsets: { invoice_id: string; invoice_no: string; amount_cents: bigint; status: string }[];
}

export async function listAdvances(sql: Sql, supplierId: string) {
  const rows = await sql<Omit<Advance, 'offsets'>[]>`
    select a.*, a.paid_on::text as paid_on, s.number as subcontract_number,
           coalesce((select sum(o.amount_cents) from app.subcontractor_advance_offsets o where o.advance_id = a.id), 0)::bigint as used_cents
      from app.subcontractor_advances a left join app.subcontracts s on s.id = a.subcontract_id
     where a.supplier_id = ${supplierId}
     order by a.paid_on desc, a.created_at desc`;
  const offs = rows.length
    ? await sql<
        { advance_id: string; invoice_id: string; invoice_no: string; amount_cents: bigint; status: string }[]
      >`
        select o.advance_id, i.id as invoice_id, i.invoice_no, o.amount_cents, i.status::text as status
          from app.subcontractor_advance_offsets o join app.incoming_invoices i on i.id = o.incoming_invoice_id
         where o.advance_id = any(${rows.map((r) => r.id)}::uuid[]) order by o.created_at`
    : [];
  return rows.map((r) => ({ ...r, offsets: offs.filter((o) => o.advance_id === r.id) })) as Advance[];
}

/** Offener (noch nicht verrechneter) Vorschuss je Lieferant. */
export async function openAdvances(sql: Sql, supplierIds?: string[]) {
  const rows = await sql<{ supplier_id: string; open: bigint }[]>`
    select a.supplier_id,
           sum(a.amount_cents - coalesce((select sum(o.amount_cents) from app.subcontractor_advance_offsets o
                                           where o.advance_id = a.id), 0))::bigint as open
      from app.subcontractor_advances a
     where ${supplierIds ? sql`a.supplier_id = any(${supplierIds}::uuid[])` : sql`true`}
     group by a.supplier_id`;
  return new Map(rows.filter((r) => r.open > 0n).map((r) => [r.supplier_id, r.open]));
}

/** Verrechnete Vorschüsse je Eingangsrechnung. */
export async function invoiceOffsets(sql: Sql | Tx, invoiceIds: string[]) {
  if (!invoiceIds.length) return new Map<string, bigint>();
  const rows = await sql<{ id: string; sum: bigint }[]>`
    select incoming_invoice_id as id, sum(amount_cents)::bigint as sum from app.subcontractor_advance_offsets
     where incoming_invoice_id = any(${invoiceIds}::uuid[]) group by 1`;
  return new Map(rows.map((r) => [r.id, r.sum]));
}

export interface AdvanceInput {
  supplierId: string;
  subcontractId: string | null;
  paidOn: string;
  amount: bigint;
  method: string;
  purpose: string | null;
  bankTransactionId?: string | null;
}

/** Vorschuss erfassen (feste ID je Formular → doppelt absenden legt nichts doppelt an). */
export async function saveAdvance(sql: Sql | Tx, id: string, p: AdvanceInput, actor: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.paidOn)) throw new BusinessError('Bitte Zahlungsdatum angeben');
  if (p.paidOn > todayBerlin()) throw new BusinessError('Zahlungsdatum liegt in der Zukunft');
  if (p.amount <= 0n) throw new BusinessError('Betrag muss größer als 0 sein');
  if (!(p.method in ADVANCE_METHOD)) throw new BusinessError('Bitte Zahlart wählen');
  const [s] = await sql<{ id: string }[]>`select id from app.suppliers where id = ${p.supplierId}`;
  if (!s) throw new BusinessError('Lieferant nicht gefunden');
  if (p.subcontractId) {
    const [sc] = await sql<
      { supplier_id: string }[]
    >`select supplier_id from app.subcontracts where id = ${p.subcontractId}`;
    if (!sc || sc.supplier_id !== p.supplierId)
      throw new BusinessError('Bestellung gehört zu einem anderen Nachunternehmer');
  }
  const r = await sql`
    insert into app.subcontractor_advances (id, supplier_id, subcontract_id, paid_on, amount_cents, method, purpose,
                                            bank_transaction_id, created_by)
    values (${id}, ${p.supplierId}, ${p.subcontractId}, ${p.paidOn}, ${p.amount}, ${p.method},
            ${p.purpose?.trim() || null}, ${p.bankTransactionId ?? null}, ${actor})
    on conflict (id) do nothing returning id`;
  if (r.length)
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${actor}, 'create', 'subcontractor_advance', ${id},
                      ${sql.json({ supplier_id: p.supplierId, amount: String(p.amount), paid_on: p.paidOn })})`;
}

/**
 * Vorschuss löschen (falsch erfasst). Gesperrt, sobald etwas verrechnet ist – erst die Verrechnung zurücknehmen.
 * Kam er aus einem Kontoumsatz, ist der Umsatz danach wieder offen.
 */
export async function deleteAdvance(sql: Sql, id: string, actor: string) {
  await sql.begin(async (tx) => {
    const [a] = await tx<
      {
        id: string;
        supplier_id: string;
        amount_cents: bigint;
        paid_on: string;
        bank_transaction_id: string | null;
      }[]
    >`
      select id, supplier_id, amount_cents, paid_on::text as paid_on, bank_transaction_id
        from app.subcontractor_advances where id = ${id} for update`;
    if (!a) return;
    const [used] = await tx`select 1 from app.subcontractor_advance_offsets where advance_id = ${id} limit 1`;
    if (used)
      throw new BusinessError(
        'Vorschuss ist schon mit einer Rechnung verrechnet – erst die Verrechnung zurücknehmen',
      );
    await tx`delete from app.subcontractor_advances where id = ${id}`;
    if (a.bank_transaction_id)
      await tx`update app.bank_transactions set status = 'offen', note = null, assigned_kind = null, assigned_id = null,
                      expense_category = null, matched_by = ${actor}, matched_at = now()
                where id = ${a.bank_transaction_id} and status = 'ignoriert'`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'delete', 'subcontractor_advance', ${id},
                     ${tx.json({ ...a, amount_cents: String(a.amount_cents) })})`;
  });
}

/**
 * Vorschuss mit einer Eingangsrechnung verrechnen: offene Vorschüsse des Lieferanten der Reihe nach (älteste zuerst)
 * bis zum Betrag bzw. höchstens bis zum offenen Rechnungsbetrag. Nur für nicht bezahlte Rechnungen.
 */
export async function offsetAdvance(sql: Sql, invoiceId: string, amount: bigint | null, actor: string) {
  return sql.begin(async (tx) => {
    const [i] = await tx<{ supplier_id: string; gross_cents: bigint; status: string; invoice_no: string }[]>`
      select supplier_id, gross_cents, status::text as status, invoice_no from app.incoming_invoices
       where id = ${invoiceId} for update`;
    if (!i) throw new BusinessError('Rechnung nicht gefunden');
    if (!['erfasst', 'freigegeben'].includes(i.status))
      throw new BusinessError('Nur offene (nicht bezahlte) Rechnungen können verrechnet werden');
    const done = (await invoiceOffsets(tx, [invoiceId])).get(invoiceId) ?? 0n;
    const rest = i.gross_cents - done;
    let want = amount ?? rest;
    if (want <= 0n) throw new BusinessError('Nichts zu verrechnen');
    if (want > rest) throw new BusinessError('Mehr als der offene Rechnungsbetrag');
    const open = await tx<{ id: string; open: bigint }[]>`
      select a.id, (a.amount_cents - coalesce((select sum(o.amount_cents) from app.subcontractor_advance_offsets o
                                              where o.advance_id = a.id), 0))::bigint as open
        from app.subcontractor_advances a where a.supplier_id = ${i.supplier_id}
       order by a.paid_on, a.created_at for update`;
    const total = open.reduce((s, a) => s + (a.open > 0n ? a.open : 0n), 0n);
    if (total <= 0n) throw new BusinessError('Kein offener Vorschuss bei diesem Nachunternehmer');
    if (amount == null && want > total) want = total;
    if (want > total) throw new BusinessError('Mehr als der offene Vorschuss');
    let left = want;
    for (const a of open) {
      if (left <= 0n || a.open <= 0n) continue;
      const take = a.open < left ? a.open : left;
      await tx`insert into app.subcontractor_advance_offsets (id, advance_id, incoming_invoice_id, amount_cents, created_by)
               values (${randomUUID()}, ${a.id}, ${invoiceId}, ${take}, ${actor})
               on conflict (advance_id, incoming_invoice_id)
               do update set amount_cents = app.subcontractor_advance_offsets.amount_cents + excluded.amount_cents`;
      left -= take;
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'advance_offset', 'incoming_invoice', ${invoiceId}, ${tx.json({ amount: String(want) })})`;
    return want;
  });
}

/** Verrechnung einer noch nicht bezahlten Rechnung zurücknehmen. */
export async function undoOffsets(sql: Sql, invoiceId: string, actor: string) {
  const [i] = await sql<
    { status: string }[]
  >`select status::text as status from app.incoming_invoices where id = ${invoiceId}`;
  if (!i) throw new BusinessError('Rechnung nicht gefunden');
  if (i.status === 'bezahlt')
    throw new BusinessError('Rechnung ist schon bezahlt – erst die Zahlung zurücknehmen');
  const r =
    await sql`delete from app.subcontractor_advance_offsets where incoming_invoice_id = ${invoiceId} returning amount_cents`;
  if (r.length)
    await sql`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, 'advance_offset_undo', 'incoming_invoice', ${invoiceId})`;
}
