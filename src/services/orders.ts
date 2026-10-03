import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { type DraftLineInput, calculateDraft, formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { type Cents, type Quantity } from '../domain/money/money.js';
import { renderInvoicePdf, renderLetterPdf } from '../pdf/render.js';
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
        .filter((l) => !l.recurring)
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
  created_by: string;
  created_at: Date;
  version: number;
}
export interface WorkReportLine {
  position: number;
  description: string;
  quantity_milli: bigint;
  unit_code: string;
}
export type WorkReportRow = WorkReport & {
  customer_name: string;
  site_name: string;
  site_no: string;
  order_number: string | null;
};

const wrSelect = (sql: Sql) => sql`
  select w.*, to_char(w.start_time, 'HH24:MI') as start_time, to_char(w.end_time, 'HH24:MI') as end_time,
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
       and ${f.unbilled ? sql`w.invoice_id is null` : sql`true`}
     order by w.work_date desc, w.number desc`;
}

export async function getWorkReport(sql: Sql, id: string) {
  const [w] = await sql<WorkReportRow[]>`${wrSelect(sql)} where w.id = ${id}`;
  if (!w) return undefined;
  const lines = await sql<
    WorkReportLine[]
  >`select * from app.work_report_lines where work_report_id = ${id} order by position`;
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
  startTime: string | null;
  endTime: string | null;
  employeeIds: string[];
  description: string | null;
  materials: string | null;
  remarks: string | null;
  lines: { description: string; quantity: Quantity; unitCode: string }[];
  expectedVersion: number | null;
}

export async function saveWorkReport(sql: Sql, id: string, input: WorkReportInput, actor: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.workDate)) throw new BusinessError('Datum ungültig');
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
      await tx`insert into app.work_report_lines ${tx(
        input.lines.map((l, i) => ({
          work_report_id: id,
          position: i + 1,
          description: l.description,
          quantity_milli: l.quantity,
          unit_code: l.unitCode,
        })),
      )}`;
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, ${cur ? 'update' : 'create'}, 'work_report', ${id})`;
  });
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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
  if (p.png.byteLength < 200 || p.png.byteLength > 600_000 || !PNG_MAGIC.every((b, i) => p.png[i] === b)) {
    throw new BusinessError('Unterschrift fehlt oder ist ungültig – bitte erneut unterschreiben');
  }
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
  if (!reason.trim()) throw new BusinessError('Bitte Grund angeben (z. B. „kein Ansprechpartner vor Ort“)');
  const res = await deps.sql`
    update app.work_reports set status = 'ohne_unterschrift', no_signature_reason = ${reason.trim()}
     where id = ${id} and status = 'entwurf' returning id`;
  if (!res.length) return;
  await deps.sql`insert into app.audit_log (actor, action, entity, entity_id, details)
                 values (${actor}, 'close_unsigned', 'work_report', ${id}, ${deps.sql.json({ reason: reason.trim() })})`;
  await archiveWorkReportPdf(deps, id);
}

const UNIT: Record<string, string> = { HUR: 'Std.', C62: 'Stk.', LS: 'pauschal', MTK: 'm²', DAY: 'Tag' };
const qty = (m: bigint) => (Number(m) / 1000).toLocaleString('de-DE', { maximumFractionDigits: 3 });

export async function renderWorkReportPdf(deps: Deps, id: string): Promise<Uint8Array> {
  const data = await getWorkReport(deps.sql, id);
  if (!data) throw new BusinessError('Arbeitsschein nicht gefunden');
  const { report: w, lines, employees } = data;
  const seller = await getSeller(deps.sql);
  const buyer = await buildBuyerSnapshot(deps.sql, w.customer_id, w.site_id);
  const png = w.signature_path ? await deps.archive.get(w.signature_path) : null;
  const time = w.start_time && w.end_time ? `${w.start_time}–${w.end_time} Uhr` : '–';
  return renderLetterPdf({
    title: `Arbeitsschein ${w.number}`,
    date: w.work_date,
    info: [
      ['Datum', formatDateDe(w.work_date)],
      ['Objekt', `${w.site_name} (${w.site_no})`.slice(0, 34)],
      ['Zeit', time],
      ...(w.order_number ? ([['Auftrag', w.order_number]] as [string, string][]) : []),
    ],
    seller,
    buyer,
    greeting: null,
    intro: [
      w.description ? `Ausgeführte Arbeiten: ${w.description}` : 'Ausgeführte Arbeiten:',
      employees.length ? `Eingesetzt: ${employees.map((e) => e.name).join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    columns: [
      { label: 'Pos', x: 62.3, align: 'left' },
      { label: 'Leistung', x: 90, align: 'left' },
      { label: 'Menge', x: 470 },
      { label: 'Einheit', x: 538.8 },
    ],
    rows: lines.map((l) => [
      String(l.position),
      l.description.slice(0, 60),
      qty(l.quantity_milli),
      UNIT[l.unit_code] ?? l.unit_code,
    ]),
    sums: [],
    total: null,
    paragraphs: [
      ...(w.materials ? [`Material: ${w.materials}`] : []),
      ...(w.remarks ? [`Bemerkungen des Kunden: ${w.remarks}`] : []),
      ...(w.status === 'ohne_unterschrift'
        ? [`Ohne Unterschrift abgeschlossen: ${w.no_signature_reason}`]
        : []),
    ],
    signature:
      w.status === 'unterschrieben'
        ? {
            label: 'Leistung erbracht und abgenommen:',
            png,
            name: w.signed_by_name ?? '',
            at:
              w.signed_at!.toLocaleString('de-DE', {
                timeZone: 'Europe/Berlin',
                dateStyle: 'medium',
                timeStyle: 'short',
              }) + ' Uhr',
          }
        : w.status === 'entwurf'
          ? { label: 'Leistung erbracht und abgenommen:', png: null, name: 'Name, Datum', at: '' }
          : null,
    ...(w.status === 'entwurf' ? { watermark: 'ENTWURF' } : {}),
  });
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
  return w.pdf_path ? deps.archive.get(w.pdf_path) : renderWorkReportPdf(deps, id);
}

// ---------------------------------------------------------------------------
// Abrechnung
// ---------------------------------------------------------------------------

/** Abgeschlossene Arbeitsscheine an einen Rechnungsentwurf hängen (PDF als Anlage, Schein als abgerechnet markieren). */
async function attachReports(deps: Deps, invoiceId: string, reportIds: string[], actor: string) {
  for (const rid of reportIds) {
    const [w] = await deps.sql<{ number: string; status: WorkReportStatus; invoice_id: string | null }[]>`
      select number, status, invoice_id from app.work_reports where id = ${rid}`;
    if (!w || w.status === 'entwurf' || w.invoice_id) continue;
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
    >`select * from app.work_report_lines where work_report_id = ${r.id} order by position`;
    for (const l of rl) {
      lines.push({
        description: l.description,
        detail: `Arbeitsschein ${r.number} vom ${formatDateDe(r.work_date)}`,
        quantity: l.quantity_milli as Quantity,
        unitCode: l.unit_code,
        unitPrice: (l.unit_code === 'HUR' && rate ? rate.unit_price_cents : 0n) as Cents,
        vatRate: rate?.vat_rate_bp ?? 1900,
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
      periodEnd: reports[reports.length - 1]!.work_date,
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
