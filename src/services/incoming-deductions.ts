/**
 * Abzüge bei der Prüfung einer Eingangsrechnung (z. B. Reinigung nicht erfolgt, Mangel, Menge falsch).
 * Die Rechnung des Lieferanten bleibt unverändert; der Abzug mindert Zahlbetrag (Zahlungsliste, SEPA, Bankabgleich),
 * die Kosten der Kostenstelle (Nachkalkulation) und erscheint im DATEV-Export als Gegenbuchung.
 * USt anteilig wie die Rechnung (bei § 13b 0). Bezahlte Rechnungen: Abzüge fest (DB-Trigger).
 */
import type { Sql, Tx } from '../db/client.js';
import { divRoundHalfUp } from '../domain/money/money.js';
import { BusinessError } from './errors.js';
import { invoiceOffsets } from './advances.js';

export type DeductionKind = 'nicht_gereinigt' | 'mangel' | 'menge' | 'sonstiges';
export const DEDUCTION_KIND: Record<DeductionKind, string> = {
  nicht_gereinigt: 'Reinigung nicht erfolgt',
  mangel: 'Mangelhafte Leistung',
  menge: 'Menge/Stunden zu viel berechnet',
  sonstiges: 'Sonstiges',
};

export interface Deduction {
  id: string;
  incoming_invoice_id: string;
  reason_kind: DeductionKind;
  reason: string;
  service_from: string | null;
  service_to: string | null;
  site_id: string | null;
  cost_center_id: string | null;
  month: string;
  net_cents: bigint;
  vat_cents: bigint;
  gross_cents: bigint;
  created_by: string;
  created_at: string;
  target_name: string | null;
}

export async function listDeductions(sql: Sql | Tx, invoiceId: string) {
  return sql<Deduction[]>`
    select d.id, d.incoming_invoice_id, d.reason_kind, d.reason, d.service_from::text, d.service_to::text,
           d.site_id, d.cost_center_id, d.month::text, d.net_cents, d.vat_cents, d.gross_cents, d.created_by,
           d.created_at::text,
           coalesce(s.site_no || ' ' || s.name, c.number || ' ' || c.name) as target_name
      from app.incoming_deductions d
      left join app.sites s on s.id = d.site_id left join app.cost_centers c on c.id = d.cost_center_id
     where d.incoming_invoice_id = ${invoiceId} order by d.created_at`;
}

/** Summe der Abzüge (brutto) je Rechnung. */
export async function deductionSums(sql: Sql | Tx, ids: string[]) {
  if (!ids.length) return new Map<string, bigint>();
  const rows = await sql<{ id: string; sum: bigint }[]>`
    select incoming_invoice_id as id, sum(gross_cents)::bigint as sum from app.incoming_deductions
     where incoming_invoice_id = any(${ids}::uuid[]) group by 1`;
  return new Map(rows.map((r) => [r.id, r.sum]));
}

export interface DeductionInput {
  kind: DeductionKind;
  reason: string;
  from: string | null;
  to: string | null;
  /** Betrag in Cent */
  amount: bigint;
  /** true = Betrag ist brutto, sonst netto */
  isGross: boolean;
}

const firstOfMonth = (d: string) => `${d.slice(0, 7)}-01`;

export async function addDeduction(
  sql: Sql,
  id: string,
  invoiceId: string,
  p: DeductionInput,
  actor: string,
) {
  if (!(p.kind in DEDUCTION_KIND)) throw new BusinessError('Bitte Grund wählen');
  if (!p.reason.trim()) throw new BusinessError('Bitte Begründung angeben (z. B. „16.10. nicht gereinigt“)');
  if (p.amount <= 0n) throw new BusinessError('Betrag muss größer als 0 sein');
  for (const d of [p.from, p.to])
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new BusinessError('Datum ungültig');
  if (p.from && p.to && p.to < p.from) throw new BusinessError('„bis“ liegt vor „von“');
  return sql.begin(async (tx) => {
    const [dup] = await tx`select 1 from app.incoming_deductions where id = ${id}`;
    if (dup) return false;
    const [i] = await tx<
      {
        status: string;
        net_cents: bigint;
        vat_cents: bigint;
        gross_cents: bigint;
        reverse_charge: boolean;
        site_id: string | null;
        service_month: string | null;
        invoice_date: string;
        invoice_no: string;
      }[]
    >`select status::text as status, net_cents, vat_cents, gross_cents, reverse_charge, site_id,
             service_month::text, invoice_date::text, invoice_no
        from app.incoming_invoices where id = ${invoiceId} for update`;
    if (!i) throw new BusinessError('Rechnung nicht gefunden');
    if (!['erfasst', 'freigegeben'].includes(i.status))
      throw new BusinessError('Abzüge nur bei offenen (nicht bezahlten, nicht abgelehnten) Rechnungen');
    if (i.net_cents <= 0n) throw new BusinessError('Abzug nur bei Rechnungen mit positivem Betrag');
    // USt anteilig wie in der Rechnung
    let net: bigint, vat: bigint;
    if (p.isGross) {
      net = i.gross_cents > 0n ? divRoundHalfUp(p.amount * i.net_cents, i.gross_cents) : p.amount;
      vat = p.amount - net;
    } else {
      net = p.amount;
      vat = i.reverse_charge || i.vat_cents <= 0n ? 0n : divRoundHalfUp(p.amount * i.vat_cents, i.net_cents);
    }
    if (net <= 0n) throw new BusinessError('Betrag zu klein');
    const done = (await deductionSums(tx, [invoiceId])).get(invoiceId) ?? 0n;
    const adv = (await invoiceOffsets(tx, [invoiceId])).get(invoiceId) ?? 0n;
    if (done + adv + net + vat > i.gross_cents)
      throw new BusinessError('Abzüge und Vorschüsse übersteigen den Rechnungsbetrag');
    // Kostenstelle: Objekt der Rechnung, sonst größter Anteil der Aufteilung
    const [big] = await tx<{ site_id: string | null; cost_center_id: string | null; month: string }[]>`
      select site_id, cost_center_id, month::text from app.cost_allocations
       where incoming_invoice_id = ${invoiceId} order by net_cents desc limit 1`;
    const siteId = i.site_id ?? big?.site_id ?? null;
    const ccId = i.site_id ? null : (big?.cost_center_id ?? null);
    const month = firstOfMonth(p.from ?? i.service_month ?? big?.month ?? i.invoice_date);
    await tx`insert into app.incoming_deductions
               (id, incoming_invoice_id, reason_kind, reason, service_from, service_to, site_id, cost_center_id, month,
                net_cents, vat_cents, gross_cents, created_by)
             values (${id}, ${invoiceId}, ${p.kind}, ${p.reason.trim()}, ${p.from}, ${p.to ?? p.from}, ${siteId}, ${ccId},
                     ${month}, ${net}, ${vat}, ${net + vat}, ${actor})`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'deduction', 'incoming_invoice', ${invoiceId},
                     ${tx.json({ id, kind: p.kind, reason: p.reason.trim(), net: String(net), vat: String(vat) })})`;
    return true;
  });
}

export async function deleteDeduction(sql: Sql, id: string, actor: string) {
  const [d] = await sql<Deduction[]>`delete from app.incoming_deductions where id = ${id} returning *`;
  if (!d) throw new BusinessError('Abzug nicht gefunden');
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'deduction_delete', 'incoming_invoice', ${d.incoming_invoice_id},
                    ${sql.json({ ...d, net_cents: String(d.net_cents), vat_cents: String(d.vat_cents), gross_cents: String(d.gross_cents) })})`;
  return d.incoming_invoice_id;
}
