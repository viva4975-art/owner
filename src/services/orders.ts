import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { type DraftLineInput, calculateDraft, formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { type Cents, type Quantity } from '../domain/money/money.js';
import { FormDoc } from '../pdf/form-doc.js';
import { renderInvoicePdf } from '../pdf/render.js';
import { assertVersion } from './crm.js';
import { BusinessError } from './errors.js';
import { saveDraft } from './invoices.js';
import { buildBuyerSnapshot, getSeller } from './masterdata.js';
import { nextYearNumber } from './purchasing.js';
import { type Deps, addAttachment } from './workflow.js';

/*
 * Aufträge (AU-JJJJ-NNNN) und Arbeitsscheine (AS-JJJJ-NNNN).
 *
 * Arbeitsschein: vor Ort ausgefüllt, vom Kunden auf Handy/Tablet unterschrieben → danach unveränderbar (DB-Trigger),
 * PDF mit Unterschrift write-once im Archiv, wird beim Abrechnen automatisch an die Rechnung gehängt.
 */

export type OrderStatus = 'offen' | 'in_arbeit' | 'erledigt' | 'abgerechnet' | 'storniert';
export const ORDER_STATUS: Record<OrderStatus, string> = {
  offen: 'offen',
  in_arbeit: 'in Arbeit',
  erledigt: 'erledigt',
  abgerechnet: 'abgerechnet',
  storniert: 'storniert',
};
export type WorkReportStatus = 'entwurf' | 'unterschrieben' | 'ohne_unterschrift';
export const WR_STATUS: Record<WorkReportStatus, string> = {
  entwurf: 'offen',
  unterschrieben: 'unterschrieben',
  ohne_unterschrift: 'ohne Unterschrift',
};

export interface Order {
  id: string;
  number: string;
  customer_id: string;
  site_id: string | null;
  offer_id: string | null;
  title: string;
  description: string | null;
  order_reference: string | null;
  planned_date: string | null;
  status: OrderStatus;
  net_cents: bigint;
  invoice_id: string | null;
  created_by: string;
  created_at: Date;
  version: number;
}
export interface OrderLine {
  position: number;
  description: string;
  detail: string | null;
  quantity_milli: bigint;
  unit_code: string;
  unit_price_cents: bigint;
  net_cents: bigint;
  vat_rate_bp: number;
}
export type OrderRow = Order & {
  customer_name: string;
  site_name: string | null;
  reports: number;
  signed: number;
};

export async function listOrders(
  sql: Sql,
  f: { status?: OrderStatus[]; customerId?: string; siteId?: string } = {},
) {
  return sql<OrderRow[]>`
    select o.*, c.name as customer_name, s.name as site_name,
           (select count(*)::int from app.work_reports w where w.order_id = o.id) as reports,
           (select count(*)::int from app.work_reports w where w.order_id = o.id and w.status <> 'entwurf') as signed
      from app.orders o join app.customers c on c.id = o.customer_id left join app.sites s on s.id = o.site_id
     where ${f.status?.length ? sql`o.status in ${sql(f.status)}` : sql`true`}
       and ${f.customerId ? sql`o.customer_id = ${f.customerId}` : sql`true`}
       and ${f.siteId ? sql`o.site_id = ${f.siteId}` : sql`true`}
     order by (o.status in ('offen', 'in_arbeit')) desc, o.planned_date nulls last, o.number desc`;
}

export async function getOrder(sql: Sql, id: string) {
  const [o] = await sql<Order[]>`select * from app.orders where id = ${id}`;
  if (!o) return undefined;
  const lines = await sql<
    OrderLine[]
  >`select * from app.order_lines where order_id = ${id} order by position`;
  return { order: o, lines };
}

export interface OrderInput {
  customerId: string;
  siteId: string | null;
  offerId: string | null;
  title: string;
  description: string | null;
  orderReference: string | null;
  plannedDate: string | null;
  lines: DraftLineInput[];
  expectedVersion: number | null;
}

export async function saveOrder(sql: Sql, id: string, input: OrderInput, actor: string) {
  if (!input.title.trim())
    throw new BusinessError('Bitte einen Titel angeben (z. B. „Grundreinigung Turnhalle“)');
  const d = calculateDraft(input.lines);
  await sql.begin(async (tx) => {
    const [cur] = await tx<
      { version: number; status: OrderStatus }[]
    >`select version, status from app.orders where id = ${id} for update`;
    assertVersion(cur?.version, input.expectedVersion, 'Der Auftrag');
    if (cur && (cur.status === 'abgerechnet' || cur.status === 'storniert'))
      throw new BusinessError('Abgerechnete/stornierte Aufträge sind abgeschlossen');
    const row = {
      customer_id: input.customerId,
      site_id: input.siteId,
      offer_id: input.offerId,
      title: input.title.trim(),
      description: input.description,
      order_reference: input.orderReference,
      planned_date: input.plannedDate,
      net_cents: d.net,
    };
    if (cur) await tx`update app.orders set ${tx(row as Record<string, unknown>)} where id = ${id}`;
    else {
      const number = await nextYearNumber(tx, 'order', 'AU-', todayBerlin().slice(0, 4), 4);
      await tx`insert into app.orders ${tx({ id, number, created_by: actor, ...row } as Record<string, unknown>)}`;
    }
    await tx`delete from app.order_lines where order_id = ${id}`;
    if (d.lines.length) {
      await tx`insert into app.order_lines ${tx(
        d.lines.map((l) => ({
          order_id: id,
          position: l.position,
          description: l.description,
          detail: l.detail ?? null,
          quantity_milli: l.quantity,
          unit_code: l.unitCode,
          unit_price_cents: l.unitPrice,
          net_cents: l.netAmount,
          vat_rate_bp: l.vatRate,
        })),
      )}`;
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, ${cur ? 'update' : 'create'}, 'order', ${id})`;
  });
}

export async function setOrderStatus(
  sql: Sql,
  id: string,
  status: Exclude<OrderStatus, 'abgerechnet'>,
  actor: string,
) {
  const [o] = await sql<{ status: OrderStatus }[]>`select status from app.orders where id = ${id}`;
  if (!o) throw new BusinessError('Auftrag nicht gefunden');
  if (o.status === 'abgerechnet' || o.status === 'storniert')
    throw new BusinessError('Auftrag ist abgeschlossen');
  await sql`update app.orders set status = ${status} where id = ${id}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details) values (${actor}, 'status', 'order', ${id}, ${sql.json({ status })})`;
}

/** Auftrag aus angenommenem Angebot (einmalige Positionen). Feste ID → nur ein Auftrag je Angebot. */
export async function orderFromOffer(sql: Sql, offerId: string, actor: string): Promise<string> {
  const [{ id }] = (await sql`select md5(${'order:' + offerId})::uuid as id`) as unknown as [{ id: string }];
  const [exists] = await sql`select 1 from app.orders where id = ${id}`;
  if (exists) return id;
  const [o] = await sql<
    {
      status: string;
      customer_id: string;
      site_id: string | null;
      title: string;
      tender_reference: string | null;
      number: string;
    }[]
  >`
    select status::text, customer_id, site_id, title, tender_reference, number from app.offers where id = ${offerId}`;
  if (!o) throw new BusinessError('Angebot nicht gefunden');
  if (o.status !== 'angenommen') throw new BusinessError('Nur aus angenommenen Angeboten');
  const lines = await sql<
    {
      description: string;
      detail: string | null;
      quantity_milli: bigint;
      unit_code: string;
      unit_price_cents: bigint;
      vat_rate_bp: number;
      recurring: boolean;
      alternative: boolean;
    }[]
  >`
    select * from app.offer_lines where offer_id = ${offerId} order by position`;
  await saveOrder(
    sql,
    id,
    {
      customerId: o.customer_id,
      siteId: o.site_id,
      offerId,
      title: o.title,
      description: `Auftrag gemäß Angebot ${o.number}`,
      orderReference: o.tender_reference,
      plannedDate: null,
      lines: lines
        .filter((l) => !l.recurring && !l.alternative)
        .map((l) => ({
          description: l.description,
          detail: l.detail,
          quantity: l.quantity_milli as Quantity,
          unitCode: l.unit_code,
          unitPrice: l.unit_price_cents as Cents,
          vatRate: l.vat_rate_bp,
        })),
      expectedVersion: null,
    },
    actor,
  );
  return id;
}

/** Auftragsbestätigung als PDF (Rechnungs-Layout ohne Zahlungsteil). */
export async function renderOrderConfirmation(sql: Sql, id: string) {
  const data = await getOrder(sql, id);
  if (!data) throw new BusinessError('Auftrag nicht gefunden');
  const { order: o, lines } = data;
  const d = calculateDraft(
    lines.map((l) => ({
      description: l.description,
      detail: l.detail,
      quantity: l.quantity_milli as Quantity,
      unitCode: l.unit_code,
      unitPrice: l.unit_price_cents as Cents,
      vatRate: l.vat_rate_bp,
    })),
  );
  const seller = await getSeller(sql);
  const buyer = await buildBuyerSnapshot(sql, o.customer_id, o.site_id);
  const date = o.created_at.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const pdf = await renderInvoicePdf(
    {
      kind: 'invoice',
      number: o.number,
      issueDate: date,
      dueDate: date,
      periodStart: null,
      periodEnd: null,
      buyerReference: null,
      orderReference: o.order_reference,
      introText: `vielen Dank für Ihren Auftrag „${o.title}“. Wir bestätigen folgende Leistungen:`,
      closingText: o.description,
      lines: d.lines,
      netTotal: d.net,
      vatTotal: d.vat,
      grossTotal: d.gross,
      prepaidTotal: 0n as Cents,
      payableTotal: d.gross,
      vatBreakdown: d.vatBreakdown,
      seller,
      buyer,
      original: null,
      prepayments: [],
      skonto: null,
    },
    {
      title: `Auftragsbestätigung ${o.number}`,
      info: [
        ['Datum', formatDateDe(date)],
        ['Kundennummer', buyer.customerNo],
        ...(o.order_reference ? ([['Ihre Bestellung', o.order_reference]] as [string, string][]) : []),
        ...(o.planned_date ? ([['Ausführung', formatDateDe(o.planned_date)]] as [string, string][]) : []),
      ],
      terms: 'Die Abrechnung erfolgt nach Ausführung gemäß unterschriebenem Arbeitsschein.',
      closing: 'Für Rückfragen stehen wir Ihnen jederzeit gerne zur Verfügung.',
      qr: false,
    },
  );
  return { pdf, filename: `Auftragsbestaetigung_${o.number}.pdf` };
}

// ---------------------------------------------------------------------------
// Arbeitsscheine
// ---------------------------------------------------------------------------

export interface WorkReport {
  id: string;
  number: string;
  order_id: string | null;
  customer_id: string;
  site_id: string;
  work_date: string;
  /** letzter Tag bei mehrtägigen Arbeiten */
  work_date_to: string | null;
  start_time: string | null;
  end_time: string | null;
  employee_ids: string[];
  description: string | null;
  materials: string | null;
  remarks: string | null;
  status: WorkReportStatus;
  signed_by_name: string | null;
  signed_at: Date | null;
  signature_path: string | null;
  signature_sha256: string | null;
  no_signature_reason: string | null;
  pdf_path: string | null;
  pdf_sha256: string | null;
  invoice_id: string | null;
  cancelled_at: Date | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  created_by: string;
  created_at: Date;
  version: number;
}
export interface WorkReportLine {
  position: number;
  description: string;
  quantity_milli: bigint;
  unit_code: string;
  /** Leistung aus dem Katalog des Objekts (Preis eingefroren) */
  service_id: string | null;
  /** Regiestunden: Name der Person */
  person: string | null;
  unit_price_cents: bigint | null;
  /** Datum der Stunden (mehrtägige Arbeitsscheine), sonst null = Datum des Scheins */
  line_date: string | null;
}
export type WorkReportRow = WorkReport & {
  customer_name: string;
  site_name: string;
  site_no: string;
  order_number: string | null;
};

const wrSelect = (sql: Sql) => sql`
  select w.*, w.work_date_to::text as work_date_to, to_char(w.start_time, 'HH24:MI') as start_time, to_char(w.end_time, 'HH24:MI') as end_time,
         c.name as customer_name, s.name as site_name, s.site_no, o.number as order_number
    from app.work_reports w join app.customers c on c.id = w.customer_id join app.sites s on s.id = w.site_id
    left join app.orders o on o.id = w.order_id`;

export async function listWorkReports(
  sql: Sql,
  f: { siteId?: string; orderId?: string; status?: WorkReportStatus[]; unbilled?: boolean } = {},
) {
  return sql<WorkReportRow[]>`
    ${wrSelect(sql)}
     where ${f.siteId ? sql`w.site_id = ${f.siteId}` : sql`true`}
       and ${f.orderId ? sql`w.order_id = ${f.orderId}` : sql`true`}
       and ${f.status?.length ? sql`w.status in ${sql(f.status)}` : sql`true`}
       and ${f.unbilled ? sql`w.invoice_id is null and w.cancelled_at is null` : sql`true`}
     order by w.work_date desc, w.number desc`;
}

export async function getWorkReport(sql: Sql, id: string) {
  const [w] = await sql<WorkReportRow[]>`${wrSelect(sql)} where w.id = ${id}`;
  if (!w) return undefined;
  const lines = await sql<
    WorkReportLine[]
  >`select *, line_date::text as line_date from app.work_report_lines where work_report_id = ${id} order by position`;
  const employees = w.employee_ids.length
    ? await sql<{ id: string; name: string }[]>`
        select id, first_name || ' ' || last_name as name from app.employees where id in ${sql(w.employee_ids)} order by last_name`
    : [];
  return { report: w, lines, employees };
}

export interface WorkReportInput {
  orderId: string | null;
  siteId: string;
  workDate: string;
  workDateTo?: string | null;
  startTime: string | null;
  endTime: string | null;
  employeeIds: string[];
  description: string | null;
  materials: string | null;
  remarks: string | null;
  lines: {
    description: string;
    quantity: Quantity;
    unitCode: string;
    serviceId?: string | null;
    person?: string | null;
    lineDate?: string | null;
  }[];
  expectedVersion: number | null;
}

export async function saveWorkReport(sql: Sql, id: string, input: WorkReportInput, actor: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.workDate)) throw new BusinessError('Datum ungültig');
  const to = input.workDateTo && input.workDateTo !== input.workDate ? input.workDateTo : null;
  if (to && (!/^\d{4}-\d{2}-\d{2}$/.test(to) || to < input.workDate))
    throw new BusinessError('„bis“ muss am oder nach dem Datum „von“ liegen');
  for (const l of input.lines) {
    if (!l.lineDate) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(l.lineDate)) throw new BusinessError('Datum einer Stundenzeile ungültig');
    if (l.lineDate < input.workDate || l.lineDate > (to ?? input.workDate))
      throw new BusinessError(
        `Datum ${l.lineDate.split('-').reverse().join('.')} liegt außerhalb des Arbeitsscheins (von–bis)`,
      );
  }
  if (input.startTime && input.endTime && input.endTime <= input.startTime)
    throw new BusinessError('Ende muss nach dem Beginn liegen');
  if (!input.description?.trim() && !input.lines.length)
    throw new BusinessError('Bitte ausgeführte Arbeiten beschreiben');
  await sql.begin(async (tx) => {
    const [cur] = await tx<
      { version: number; status: WorkReportStatus }[]
    >`select version, status from app.work_reports where id = ${id} for update`;
    assertVersion(cur?.version, input.expectedVersion, 'Der Arbeitsschein');
    if (cur && cur.status !== 'entwurf')
      throw new BusinessError('Unterschriebene Arbeitsscheine sind unveränderbar');
    const [site] = await tx<
      { customer_id: string }[]
    >`select customer_id from app.sites where id = ${input.siteId}`;
    if (!site) throw new BusinessError('Bitte Objekt wählen');
    if (input.orderId) {
      const [o] = await tx<
        { customer_id: string; status: OrderStatus }[]
      >`select customer_id, status from app.orders where id = ${input.orderId}`;
      if (!o || o.customer_id !== site.customer_id)
        throw new BusinessError('Auftrag gehört zu einem anderen Kunden');
      if (o.status === 'offen')
        await tx`update app.orders set status = 'in_arbeit' where id = ${input.orderId}`;
    }
    const row = {
      order_id: input.orderId,
      customer_id: site.customer_id,
      site_id: input.siteId,
      work_date: input.workDate,
      work_date_to: to,
      start_time: input.startTime,
      end_time: input.endTime,
      employee_ids: input.employeeIds,
      description: input.description,
      materials: input.materials,
      remarks: input.remarks,
    };
    if (cur) await tx`update app.work_reports set ${tx(row as Record<string, unknown>)} where id = ${id}`;
    else {
      const number = await nextYearNumber(tx, 'work_report', 'AS-', input.workDate.slice(0, 4), 4);
      await tx`insert into app.work_reports ${tx({ id, number, created_by: actor, ...row } as Record<string, unknown>)}`;
    }
    await tx`delete from app.work_report_lines where work_report_id = ${id}`;
    if (input.lines.length) {
      // Leistung aus dem Katalog: nur Leistungen dieses Objekts, Preis/Einheit wird eingefroren
      const svcIds = [...new Set(input.lines.map((l) => l.serviceId).filter((x): x is string => !!x))];
      const svcs = svcIds.length
        ? await tx<{ id: string; description: string; unit_code: string; unit_price_cents: bigint }[]>`
            select id, description, unit_code, unit_price_cents from app.site_services
             where site_id = ${input.siteId} and id in ${tx(svcIds)}`
        : [];
      const byId = new Map(svcs.map((x) => [x.id, x]));
      await tx`insert into app.work_report_lines ${tx(
        input.lines.map((l, i) => {
          const sv = l.serviceId ? byId.get(l.serviceId) : undefined;
          if (l.serviceId && !sv)
            throw new BusinessError(`Position ${i + 1}: Leistung gehört nicht zu diesem Objekt`);
          return {
            work_report_id: id,
            position: i + 1,
            description: l.description || sv?.description || '',
            quantity_milli: l.quantity,
            unit_code: sv && !l.person ? sv.unit_code : l.unitCode,
            service_id: sv?.id ?? null,
            person: l.person?.trim() || null,
            unit_price_cents: sv ? sv.unit_price_cents : null,
            line_date:
              l.lineDate && l.lineDate !== input.workDate ? l.lineDate : l.lineDate && to ? l.lineDate : null,
          };
        }),
      )}`;
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, ${cur ? 'update' : 'create'}, 'work_report', ${id})`;
  });
}

/** Entwurf löschen (Positionen, Verknüpfungen zu Tiefgaragen-Terminen/Sonderdiensten lösen; Fotos bleiben im Archiv). */
export async function deleteWorkReport(sql: Sql, id: string, actor: string) {
  await sql.begin(async (tx) => {
    const [w] = await tx<{ number: string; status: WorkReportStatus }[]>`
      select number, status from app.work_reports where id = ${id} for update`;
    if (!w) throw new BusinessError('Arbeitsschein nicht gefunden');
    if (w.status !== 'entwurf')
      throw new BusinessError('Abgeschlossene Arbeitsscheine können nur storniert werden');
    for (const t of ['tg_appointments', 'special_service_runs'])
      if ((await tx`select to_regclass(${'app.' + t}) as r`)[0]!.r)
        await tx.unsafe(`update app.${t} set work_report_id = null where work_report_id = $1`, [id]);
    await tx`delete from app.work_reports where id = ${id}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'delete', 'work_report', ${id}, ${tx.json({ number: w.number })})`;
  });
}

/** Abgeschlossenen Arbeitsschein stornieren (mit Grund). Bereits abgerechnete: erst die Rechnung stornieren. */
export async function cancelWorkReport(sql: Sql, id: string, reason: string, actor: string) {
  if (!reason.trim()) throw new BusinessError('Bitte Grund angeben');
  const [w] = await sql<
    {
      status: WorkReportStatus;
      invoice_id: string | null;
      cancelled_at: Date | null;
      inv_status: string | null;
      inv_number: string | null;
    }[]
  >`select w.status, w.invoice_id, w.cancelled_at, i.status::text as inv_status, i.number as inv_number
      from app.work_reports w left join app.invoices i on i.id = w.invoice_id where w.id = ${id}`;
  if (!w) throw new BusinessError('Arbeitsschein nicht gefunden');
  if (w.cancelled_at) return;
  if (w.status === 'entwurf') throw new BusinessError('Entwürfe bitte löschen');
  if (w.invoice_id)
    throw new BusinessError(
      w.inv_number
        ? `Schon abgerechnet (Rechnung ${w.inv_number}) – bitte zuerst die Rechnung stornieren bzw. korrigieren`
        : 'Schon in einem Rechnungsentwurf – bitte zuerst den Entwurf löschen',
    );
  await sql`update app.work_reports set cancelled_at = now(), cancelled_by = ${actor}, cancel_reason = ${reason.trim()}
             where id = ${id} and cancelled_at is null`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'cancel', 'work_report', ${id}, ${sql.json({ reason: reason.trim() })})`;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Unterschrift aus dem Canvas: echtes PNG, nicht leer, nicht übergroß. */
export function assertSignaturePng(png: Uint8Array) {
  if (png.byteLength < 200 || png.byteLength > 600_000 || !PNG_MAGIC.every((b, i) => png[i] === b)) {
    throw new BusinessError('Unterschrift fehlt oder ist ungültig – bitte erneut unterschreiben');
  }
}

/**
 * Unterschrift des Kunden speichern. Danach ist der Schein eingefroren; PDF wird erzeugt und archiviert.
 * Doppelt gesendet → keine zweite Unterschrift (nur aus Status „entwurf“).
 */
export async function signWorkReport(
  deps: Deps,
  id: string,
  p: { name: string; png: Uint8Array },
  actor: string,
) {
  const { sql } = deps;
  if (!p.name.trim()) throw new BusinessError('Bitte Namen des Unterzeichners angeben');
  assertSignaturePng(p.png);
  const [w] = await sql<{ status: WorkReportStatus; number: string; work_date: string }[]>`
    select status, number, work_date from app.work_reports where id = ${id}`;
  if (!w) throw new BusinessError('Arbeitsschein nicht gefunden');
  if (w.status !== 'entwurf') return;
  const path = `arbeitsscheine/${w.work_date.slice(0, 4)}/${w.number}/unterschrift-${randomUUID()}.png`;
  const { sha256 } = await deps.archive.put(path, p.png);
  const res = await sql`
    update app.work_reports set status = 'unterschrieben', signed_by_name = ${p.name.trim()}, signed_at = now(),
           signature_path = ${path}, signature_sha256 = ${sha256}
     where id = ${id} and status = 'entwurf' returning id`;
  if (!res.length) return;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'sign', 'work_report', ${id}, ${sql.json({ signed_by: p.name.trim(), sha256 })})`;
  await archiveWorkReportPdf(deps, id);
}

export async function closeWithoutSignature(deps: Deps, id: string, reason: string, actor: string) {
  if (!reason.trim()) reason = 'PDF erstellt (ohne Kundenunterschrift)';
  const res = await deps.sql`
    update app.work_reports set status = 'ohne_unterschrift', no_signature_reason = ${reason.trim()}
     where id = ${id} and status = 'entwurf' returning id`;
  if (!res.length) return;
  await deps.sql`insert into app.audit_log (actor, action, entity, entity_id, details)
                 values (${actor}, 'close_unsigned', 'work_report', ${id}, ${deps.sql.json({ reason: reason.trim() })})`;
  await archiveWorkReportPdf(deps, id);
}

const UNIT: Record<string, string> = { HUR: 'Std.', C62: 'Stk.', LS: 'psch.', MTK: 'm²', DAY: 'Tag' };
const qty = (m: bigint) => (Number(m) / 1000).toLocaleString('de-DE', { maximumFractionDigits: 3 });

/** Ausführungshinweise der am Tag gültigen Leistungen des Objekts (für Arbeitsschein und Mitarbeitende). */
export async function executionNotes(sql: Sql, siteId: string, date: string) {
  return sql<{ description: string; execution_notes: string }[]>`
    select description, execution_notes from app.site_services
     where site_id = ${siteId} and active and execution_notes is not null and execution_notes <> ''
       and valid_from <= ${date} and (valid_to is null or valid_to >= ${date})
     order by sort_order, description`;
}

export async function renderWorkReportPdf(deps: Deps, id: string): Promise<Uint8Array> {
  const data = await getWorkReport(deps.sql, id);
  if (!data) throw new BusinessError('Arbeitsschein nicht gefunden');
  const { report: w, lines, employees } = data;
  const seller = await getSeller(deps.sql);
  const buyer = await buildBuyerSnapshot(deps.sql, w.customer_id, w.site_id);
  const [site] = await deps.sql<{ street: string | null; postal_code: string | null; city: string | null }[]>`
    select street, postal_code, city from app.sites where id = ${w.site_id}`;
  const png = w.signature_path ? await deps.archive.get(w.signature_path) : null;
  const dShort = (d: string) => formatDateDe(d).slice(0, 6) + formatDateDe(d).slice(8);
  const dateText = w.work_date_to
    ? `${formatDateDe(w.work_date).slice(0, 6)} – ${formatDateDe(w.work_date_to)}`
    : formatDateDe(w.work_date);
  const time =
    w.start_time && w.end_time ? `${w.start_time.slice(0, 5)} – ${w.end_time.slice(0, 5)} Uhr` : '-';
  const regie = lines.filter((l) => l.person);
  const items = lines.filter((l) => !l.person);
  // Layout wie die alte App (Ahmed 08.10.: Arbeitsscheine AS-2026-1024/1028)
  const d = await FormDoc.create({
    title: `Arbeitsschein ${w.number}`,
    sideRef: `VD-AS Arbeitsschein ${w.number}`,
    date: w.work_date,
    author: seller.legalName,
    ...(w.cancelled_at ? { watermark: 'STORNIERT' } : w.status === 'entwurf' ? { watermark: 'ENTWURF' } : {}),
  });
  d.title('Arbeitsschein', `Nr. ${w.number}`);
  d.infoGrid([
    [w.work_date_to ? 'Zeitraum' : 'Datum', dateText],
    ['Zeit', time],
    ['Kostenstelle', w.site_no],
    [
      'Abrechnung',
      regie.length ? (items.length ? 'Leistungen + Regiearbeiten' : 'Regiearbeiten') : 'Leistungen',
    ],
    ['Auftrag', w.order_number ?? '-'],
    ['Eingesetzt', employees.length ? `${employees.length} Mitarbeiter` : '-'],
  ]);
  d.twoCols(
    {
      label: 'Kundenanschrift',
      lines: [buyer.name, buyer.name2 ?? '', buyer.street, `${buyer.postalCode} ${buyer.city}`].filter(
        Boolean,
      ),
    },
    {
      label: 'Objektanschrift',
      lines: [
        w.site_name,
        site?.street ?? '',
        `${site?.postal_code ?? ''} ${site?.city ?? ''}`.trim(),
      ].filter(Boolean),
    },
  );
  if (w.description) {
    d.section('Ausgeführte Arbeiten');
    d.para(w.description);
  }
  if (items.length) {
    d.section('Positionen');
    d.table(
      [
        { label: 'Pos.', width: 32 },
        { label: 'Leistung / Beschreibung', width: 356 },
        { label: 'Menge', width: 110, align: 'right' },
      ],
      items.map((l, i) => [
        `${i + 1}.`,
        l.description,
        `${qty(l.quantity_milli)} ${UNIT[l.unit_code] ?? l.unit_code}`,
      ]),
    );
  }
  if (regie.length || employees.length) {
    d.section('Regie-/Stundennachweis');
    const rows: string[][] = regie.length
      ? [...regie]
          .sort((a, b) => (a.line_date ?? w.work_date).localeCompare(b.line_date ?? w.work_date))
          .map((l) => [
            dShort(l.line_date ?? w.work_date),
            l.person ?? '',
            w.start_time && w.end_time ? `${w.start_time.slice(0, 5)}–${w.end_time.slice(0, 5)}` : '',
            qty(l.quantity_milli),
            l.description === 'Regiestunden' ? (w.description ?? '').split('\n')[0]! : l.description,
          ])
      : employees.map((e) => [
          dShort(w.work_date),
          e.name,
          w.start_time && w.end_time ? `${w.start_time.slice(0, 5)}–${w.end_time.slice(0, 5)}` : '',
          '',
          '',
        ]);
    const total = regie.reduce((a, l) => a + l.quantity_milli, 0n);
    d.table(
      [
        { label: 'Datum', width: 62 },
        { label: 'Mitarbeiter', width: 150 },
        { label: 'Zeit', width: 72 },
        { label: 'Std.', width: 44, align: 'right' },
        { label: 'Tätigkeit', width: 170 },
      ],
      [
        ...rows,
        ...(regie.length ? [{ sum: ['Gesamt', '', '', `${qty(total)} Std.`, ''], strong: true }] : []),
      ],
    );
  }
  for (const n of await executionNotes(deps.sql, w.site_id, w.work_date))
    d.muted(`Ausführungshinweis (${n.description}): ${n.execution_notes}`);
  if (w.materials) d.para(`Material: ${w.materials}`);
  if (w.remarks) d.para(`Bemerkungen des Kunden: ${w.remarks}`);
  if (w.status === 'ohne_unterschrift' && !w.no_signature_reason?.startsWith('PDF erstellt'))
    d.muted(`Ohne Unterschrift abgeschlossen: ${w.no_signature_reason}`);
  d.y += 6;
  d.ensure(80); // Abnahmesatz und Unterschrift zusammen halten
  d.muted('Die vorstehenden Arbeiten wurden ordnungsgemäß ausgeführt und abgenommen.');
  const signed = w.status === 'unterschrieben';
  d.signatures('Ort, Datum', 'Unterschrift / Stempel Auftraggeber (Kunde)', {
    ...(signed
      ? {
          leftText: `München, ${w.signed_at!.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}`,
          png: png ? await d.embedPng(png) : null,
          rightText: w.signed_by_name ?? '',
        }
      : {}),
  });
  return d.save();
}

async function archiveWorkReportPdf(deps: Deps, id: string) {
  const [w] = await deps.sql<{ number: string; work_date: string; pdf_path: string | null }[]>`
    select number, work_date, pdf_path from app.work_reports where id = ${id}`;
  if (!w || w.pdf_path) return;
  const pdf = await renderWorkReportPdf(deps, id);
  const path = `arbeitsscheine/${w.work_date.slice(0, 4)}/${w.number}/Arbeitsschein_${w.number}.pdf`;
  const { sha256 } = await deps.archive.put(path, pdf);
  await deps.sql`update app.work_reports set pdf_path = ${path}, pdf_sha256 = ${sha256} where id = ${id} and pdf_path is null`;
}

export async function workReportPdf(deps: Deps, id: string): Promise<Uint8Array> {
  const [w] = await deps.sql<
    { pdf_path: string | null }[]
  >`select pdf_path from app.work_reports where id = ${id}`;
  if (!w) throw new BusinessError('Arbeitsschein nicht gefunden');
  const [c] = await deps.sql<
    { cancelled: boolean }[]
  >`select cancelled_at is not null as cancelled from app.work_reports where id = ${id}`;
  return w.pdf_path && !c?.cancelled ? deps.archive.get(w.pdf_path) : renderWorkReportPdf(deps, id);
}

// ---------------------------------------------------------------------------
// Abrechnung
// ---------------------------------------------------------------------------

/** Abgeschlossene Arbeitsscheine an einen Rechnungsentwurf hängen (PDF als Anlage, Schein als abgerechnet markieren). */
async function attachReports(deps: Deps, invoiceId: string, reportIds: string[], actor: string) {
  for (const rid of reportIds) {
    const [w] = await deps.sql<
      { number: string; status: WorkReportStatus; invoice_id: string | null; cancelled_at: Date | null }[]
    >`select number, status, invoice_id, cancelled_at from app.work_reports where id = ${rid}`;
    if (!w || w.status === 'entwurf' || w.invoice_id || w.cancelled_at) continue;
    const pdf = await workReportPdf(deps, rid);
    await addAttachment(deps, invoiceId, `Arbeitsschein_${w.number}.pdf`, 'application/pdf', pdf, actor);
    await deps.sql`update app.work_reports set invoice_id = ${invoiceId} where id = ${rid} and invoice_id is null`;
  }
}

/** Rechnungsentwurf aus Auftrag; abgeschlossene Arbeitsscheine werden angehängt. Nur einmal je Auftrag. */
export async function orderToInvoice(deps: Deps, orderId: string, actor: string): Promise<string> {
  const { sql } = deps;
  const data = await getOrder(sql, orderId);
  if (!data) throw new BusinessError('Auftrag nicht gefunden');
  const { order: o, lines } = data;
  if (o.invoice_id) return o.invoice_id;
  if (o.status === 'storniert') throw new BusinessError('Auftrag ist storniert');
  if (!lines.length) throw new BusinessError('Auftrag hat keine Positionen mit Preisen');
  const open = await listWorkReports(sql, { orderId, status: ['entwurf'] });
  if (open.length)
    throw new BusinessError(`Arbeitsschein ${open[0]!.number} ist noch nicht unterschrieben/abgeschlossen`);
  const [{ id }] = (await sql`select md5(${'order-invoice:' + orderId})::uuid as id`) as unknown as [
    { id: string },
  ];
  await saveDraft(
    sql,
    id,
    {
      customerId: o.customer_id,
      siteId: o.site_id,
      kind: 'invoice',
      periodStart: null,
      periodEnd: null,
      orderReference: o.order_reference,
      introText: `Gemäß Auftrag ${o.number} („${o.title}“) berechnen wir:`,
      closingText: null,
      lines: lines.map((l) => ({
        description: l.description,
        detail: l.detail,
        quantity: l.quantity_milli as Quantity,
        unitCode: l.unit_code,
        unitPrice: l.unit_price_cents as Cents,
        vatRate: l.vat_rate_bp,
      })),
    },
    actor,
  );
  const reports = await listWorkReports(sql, {
    orderId,
    status: ['unterschrieben', 'ohne_unterschrift'],
    unbilled: true,
  });
  await attachReports(
    deps,
    id,
    reports.map((r) => r.id),
    actor,
  );
  await sql`update app.orders set status = 'abgerechnet', invoice_id = ${id} where id = ${orderId} and invoice_id is null`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details) values (${actor}, 'to_invoice', 'order', ${orderId}, ${sql.json({ invoice_id: id })})`;
  return id;
}

/**
 * Regiearbeiten ohne Auftrag abrechnen: ausgewählte Arbeitsscheine eines Objekts → ein Rechnungsentwurf.
 * Stunden erhalten den Regiestundensatz des Objekts, andere Positionen werden zum Ausfüllen mit 0,00 € übernommen.
 */
export async function reportsToInvoice(
  deps: Deps,
  siteId: string,
  reportIds: string[],
  actor: string,
): Promise<string> {
  const { sql } = deps;
  if (!reportIds.length) throw new BusinessError('Bitte Arbeitsscheine auswählen');
  const reports = (
    await listWorkReports(sql, { siteId, status: ['unterschrieben', 'ohne_unterschrift'], unbilled: true })
  ).filter((r) => reportIds.includes(r.id));
  if (reports.length !== new Set(reportIds).size)
    throw new BusinessError('Mindestens ein Schein ist nicht abgeschlossen oder schon abgerechnet');
  const [rate] = await sql<{ unit_price_cents: bigint; vat_rate_bp: number }[]>`
    select unit_price_cents, vat_rate_bp from app.site_services where site_id = ${siteId} and kind = 'hourly' and active
     order by sort_order limit 1`;
  const lines: DraftLineInput[] = [];
  for (const r of reports.sort((a, b) => a.work_date.localeCompare(b.work_date))) {
    const rl = await sql<
      WorkReportLine[]
    >`select *, line_date::text as line_date from app.work_report_lines where work_report_id = ${r.id} order by position`;
    for (const l of rl) {
      const ld = l.line_date ?? (l.person ? r.work_date : null);
      lines.push({
        description: l.person ? `${l.description} – ${l.person}` : l.description,
        detail: `Arbeitsschein ${r.number} vom ${formatDateDe(ld ?? r.work_date)}${!ld && r.work_date_to ? ` bis ${formatDateDe(r.work_date_to)}` : ''}`,
        quantity: l.quantity_milli as Quantity,
        unitCode: l.unit_code,
        // Leistung aus dem Katalog: eingefrorener Preis; Stunden: Regiestundensatz des Objekts
        unitPrice: (l.unit_price_cents ??
          (l.unit_code === 'HUR' && rate ? rate.unit_price_cents : 0n)) as Cents,
        vatRate: rate?.vat_rate_bp ?? 1900,
        sourceServiceId: null,
        periodStart: ld ?? r.work_date,
        periodEnd: ld ?? r.work_date_to ?? r.work_date,
      });
    }
  }
  if (!lines.length) throw new BusinessError('Die Arbeitsscheine enthalten keine Positionen');
  const [site] = await sql<
    { customer_id: string; order_reference: string | null }[]
  >`select customer_id, order_reference from app.sites where id = ${siteId}`;
  const id = randomUUID();
  await saveDraft(
    sql,
    id,
    {
      customerId: site!.customer_id,
      siteId,
      kind: 'invoice',
      periodStart: reports[0]!.work_date,
      periodEnd: reports.reduce(
        (m, r) => ((r.work_date_to ?? r.work_date) > m ? (r.work_date_to ?? r.work_date) : m),
        reports[0]!.work_date,
      ),
      orderReference: site!.order_reference,
      introText: 'Für die folgenden Regiearbeiten (Leistungsnachweise anbei) berechnen wir:',
      closingText: null,
      lines,
    },
    actor,
  );
  await attachReports(
    deps,
    id,
    reports.map((r) => r.id),
    actor,
  );
  return id;
}
