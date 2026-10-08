import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { type BillingCycle, formatDateDe, serviceDetail } from '../domain/invoice/calc.js';
import type { Cents, Quantity, VatRate } from '../domain/money/money.js';
import { BusinessError } from './errors.js';
import { writeLines } from './invoices.js';
import { effectiveBilling } from './masterdata.js';

/**
 * Leistungen „je Ausführung“ und „einmalig“ verrichten (wie Fortytools): Leistungen am Objekt ankreuzen, Datum von
 * (bis) setzen → vorgemerkte Ausführung. Unter Rechnungen → Entwürfe werden daraus Rechnungsentwürfe – je Kunde,
 * Objekt oder alle auf einmal. Ziel der Rechnung wie im Monatslauf: eigene Rechnung → Sammelrechnung der Gruppe →
 * Rechnung je Objekt.
 */

/** Feste ID (UUID-v4-Format) aus einem Schlüssel → doppeltes Absenden legt nichts doppelt an. */
const uuidOf = (s: string) => {
  const h = createHash('md5').update(s).digest('hex').split('');
  h[12] = '4';
  h[16] = '89ab'[parseInt(h[16]!, 16) & 3]!;
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

export const isPerExecution = (cycle: BillingCycle, kind: string) =>
  cycle === 'einmalig' || cycle === 'je_ausfuehrung' || kind !== 'monthly_flat';

export interface ExecutableService {
  id: string;
  description: string;
  note: string | null;
  billing_cycle: BillingCycle;
  unit_code: string;
  quantity_milli: bigint;
  unit_price_cents: bigint;
  valid_from: string;
  valid_to: string | null;
  /** einmalige Leistung schon verrichtet */
  done_at: string | null;
  open_count: number;
}

/** Leistungen eines Objekts, die je Ausführung abgerechnet werden. */
export async function executableServices(sql: Sql, siteId: string) {
  return sql<ExecutableService[]>`
    select v.id, v.description, v.note, v.billing_cycle::text as billing_cycle, v.unit_code, v.quantity_milli,
           v.unit_price_cents, v.valid_from::text as valid_from, v.valid_to::text as valid_to,
           (select max(e.date_from)::text from app.service_executions e where e.service_id = v.id) as done_at,
           (select count(*)::int from app.service_executions e where e.service_id = v.id and e.invoice_id is null)
             as open_count
      from app.site_services v
     where v.site_id = ${siteId} and v.active
       and (v.billing_cycle in ('einmalig', 'je_ausfuehrung') or v.kind <> 'monthly_flat')
     order by v.sort_order, v.description`;
}

export interface ExecuteInput {
  siteId: string;
  /** Formular-Kennung (einmal je angezeigtem Formular) – macht das Absenden idempotent */
  token: string;
  dateFrom: string;
  dateTo: string | null;
  items: { serviceId: string; quantity: bigint | null }[];
}

export async function executeServices(sql: Sql, p: ExecuteInput, actor: string): Promise<number> {
  if (!p.items.length) throw new BusinessError('Bitte mindestens eine Leistung ankreuzen');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.dateFrom)) throw new BusinessError('Bitte Datum „von“ angeben');
  const to = p.dateTo || p.dateFrom;
  if (to < p.dateFrom) throw new BusinessError('Datum „bis“ liegt vor „von“');
  let n = 0;
  await sql.begin(async (tx) => {
    for (const it of p.items) {
      const [sv] = await tx<
        {
          site_id: string;
          description: string;
          active: boolean;
          billing_cycle: string;
          quantity_milli: bigint;
          unit_price_cents: bigint;
          valid_from: string;
          valid_to: string | null;
        }[]
      >`select site_id, description, active, billing_cycle::text as billing_cycle, quantity_milli, unit_price_cents,
               valid_from::text as valid_from, valid_to::text as valid_to
          from app.site_services where id = ${it.serviceId} for update`;
      if (!sv || sv.site_id !== p.siteId) throw new BusinessError('Leistung gehört nicht zu diesem Objekt');
      if (!sv.active) throw new BusinessError(`„${sv.description}“ ist nicht aktiv`);
      if (p.dateFrom < sv.valid_from || (sv.valid_to && to > sv.valid_to))
        throw new BusinessError(
          `„${sv.description}“ gilt vom ${formatDateDe(sv.valid_from)}${sv.valid_to ? ` bis ${formatDateDe(sv.valid_to)}` : ''} – Datum außerhalb`,
        );
      const id = uuidOf(`exec:${p.token}:${it.serviceId}`);
      if (sv.billing_cycle === 'einmalig') {
        const [prev] = await tx<{ id: string }[]>`
          select id from app.service_executions where service_id = ${it.serviceId} and id <> ${id}`;
        if (prev) throw new BusinessError(`„${sv.description}“ ist einmalig und wurde schon verrichtet`);
      }
      const qty = it.quantity ?? sv.quantity_milli;
      if (qty <= 0n) throw new BusinessError(`„${sv.description}“: Menge muss größer 0 sein`);
      const res = await tx`
        insert into app.service_executions (id, service_id, site_id, date_from, date_to, quantity_milli,
                                            unit_price_cents, created_by)
        values (${id}, ${it.serviceId}, ${p.siteId}, ${p.dateFrom}, ${to}, ${qty}, ${sv.unit_price_cents}, ${actor})
        on conflict (id) do nothing`;
      n += res.count;
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'execute_services', 'site', ${p.siteId},
                     ${tx.json({ from: p.dateFrom, to, services: p.items.map((i) => i.serviceId) })})`;
  });
  return n;
}

export interface OpenExecution {
  id: string;
  service_id: string;
  site_id: string;
  date_from: string;
  date_to: string;
  quantity_milli: bigint;
  unit_price_cents: bigint;
  description: string;
  unit_code: string;
  note: string | null;
  site_no: string;
  site_name: string;
  customer_id: string;
  customer_no: string;
  customer_name: string;
  created_by: string;
}

export async function listOpenExecutions(sql: Sql, f: { siteId?: string } = {}) {
  return sql<OpenExecution[]>`
    select e.id, e.service_id, e.site_id, e.date_from::text as date_from, e.date_to::text as date_to,
           e.quantity_milli, e.unit_price_cents, v.description, v.unit_code, v.note, s.site_no, s.name as site_name,
           c.id as customer_id, c.customer_no, c.name as customer_name, e.created_by
      from app.service_executions e
      join app.site_services v on v.id = e.service_id
      join app.sites s on s.id = e.site_id
      join app.customers c on c.id = s.customer_id
     where e.invoice_id is null and ${f.siteId ? sql`e.site_id = ${f.siteId}` : sql`true`}
     order by c.name, s.site_no, e.date_from`;
}

/** Vorgemerkte (noch nicht abgerechnete) Ausführung zurücknehmen. */
export async function deleteExecution(sql: Sql, id: string, actor: string) {
  const res = await sql`delete from app.service_executions where id = ${id} and invoice_id is null`;
  if (!res.count) throw new BusinessError('Ausführung steht schon auf einer Rechnung – dort Entwurf löschen');
  await sql`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, 'delete', 'service_execution', ${id})`;
}

/**
 * Rechnungsentwürfe aus vorgemerkten Ausführungen. Gruppierung wie Monatslauf. Jede Ausführung landet höchstens
 * auf einem Entwurf (Zeilensperre + invoice_id). Gibt die erzeugten Entwürfe zurück.
 */
export async function draftsFromExecutions(
  sql: Sql,
  ids: string[],
  invoiceDate: string | null,
  actor: string,
): Promise<string[]> {
  if (!ids.length) throw new BusinessError('Bitte mindestens eine Ausführung auswählen');
  if (invoiceDate && !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate))
    throw new BusinessError('Rechnungsdatum ungültig');
  const created: string[] = [];
  await sql.begin(async (tx) => {
    const rows = await tx<
      (OpenExecution & {
        street: string | null;
        postal_code: string | null;
        city: string | null;
        site_group: string | null;
        sv_group: string | null;
        separate_invoice: boolean;
        group_active: boolean | null;
        group_combine: boolean | null;
        group_name: string | null;
        order_reference: string | null;
        sv_order_reference: string | null;
        intro_text: string | null;
        closing_text: string | null;
        reverse_charge: boolean;
      })[]
    >`
      select e.id, e.service_id, e.site_id, e.date_from::text as date_from, e.date_to::text as date_to,
             e.quantity_milli, e.unit_price_cents, v.description, v.unit_code, v.note, s.site_no,
             s.name as site_name, s.street, s.postal_code, s.city, c.id as customer_id, c.customer_no,
             c.name as customer_name, e.created_by, s.invoice_group_id as site_group, v.invoice_group_id as sv_group,
             v.separate_invoice, g.active as group_active, g.combine as group_combine, g.name as group_name,
             coalesce(g.order_reference, s.order_reference) as order_reference, v.order_reference as sv_order_reference,
             g.intro_text, g.closing_text,
             c.reverse_charge
        from app.service_executions e
        join app.site_services v on v.id = e.service_id
        join app.sites s on s.id = e.site_id
        join app.customers c on c.id = s.customer_id
        left join app.invoice_groups g on g.id = coalesce(v.invoice_group_id, s.invoice_group_id)
       where e.id in ${tx(ids)} and e.invoice_id is null
       order by s.site_no, e.date_from
         for update of e`;
    type Row = (typeof rows)[number];
    const units = new Map<string, Row[]>();
    for (const r of rows) {
      const gid = r.sv_group ?? r.site_group;
      const useGroup = r.group_active ? gid : null;
      const combined = !r.separate_invoice && !!useGroup && !!r.group_combine;
      const key = r.separate_invoice
        ? `service:${r.service_id}:${r.id}`
        : combined
          ? `group:${useGroup}`
          : useGroup && useGroup !== r.site_group
            ? `${r.site_id}|${useGroup}`
            : r.site_id;
      units.set(key, [...(units.get(key) ?? []), r]);
    }
    for (const [key, items] of units) {
      const first = items[0]!;
      const combined = key.startsWith('group:');
      const groupId = (first.group_active ? (first.sv_group ?? first.site_group) : null) ?? null;
      const billing = await effectiveBilling(
        tx as unknown as Sql,
        first.customer_id,
        combined ? null : first.site_id,
        groupId,
      );
      const id = randomUUID();
      const start = items.map((i) => i.date_from).reduce((a, b) => (b < a ? b : a));
      const end = items.map((i) => i.date_to).reduce((a, b) => (b > a ? b : a));
      // Bestellnummer der Leistung: einheitlich → Rechnungskopf, verschieden → je Position
      const refs = [...new Set(items.map((i) => i.sv_order_reference?.trim() || ''))];
      const svcRef = refs.length === 1 && refs[0] ? refs[0] : null;
      await tx`
        insert into app.invoices (id, kind, customer_id, site_id, invoice_group_id, period_start, period_end,
                                  invoice_format, buyer_reference, order_reference, intro_text, closing_text,
                                  planned_issue_date, reverse_charge)
        values (${id}, 'invoice', ${first.customer_id}, ${combined ? null : first.site_id}, ${groupId}, ${start}, ${end},
                ${billing.format}, ${billing.leitwegId}, ${svcRef ?? first.order_reference}, ${first.intro_text},
                ${first.closing_text}, ${invoiceDate}, ${first.reverse_charge})`;
      await writeLines(
        tx,
        id,
        items.map((i) => ({
          description: i.description,
          detail: [
            serviceDetail(
              i.note,
              {
                siteNo: i.site_no,
                name: i.site_name,
                street: i.street,
                postalCode: i.postal_code,
                city: i.city,
              },
              i.date_from,
              i.date_to,
            ),
            !svcRef && i.sv_order_reference ? `Bestellnummer: ${i.sv_order_reference}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          quantity: i.quantity_milli as Quantity,
          unitCode: i.unit_code,
          unitPrice: i.unit_price_cents as Cents,
          vatRate: 1900 as VatRate,
          sourceServiceId: i.service_id,
        })),
        0n as Cents,
        first.reverse_charge,
      );
      await tx`update app.service_executions set invoice_id = ${id} where id in ${tx(items.map((i) => i.id))}`;
      await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
               values (${actor}, 'draft_from_executions', 'invoice', ${id}, ${tx.json({ executions: items.map((i) => i.id) })})`;
      created.push(id);
    }
  });
  return created;
}
