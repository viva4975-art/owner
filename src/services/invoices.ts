import { randomUUID } from 'node:crypto';
import type { Sql, Tx } from '../db/client.js';
import {
  type DraftLineInput,
  calculateDraft,
  cancellationLines,
  monthBounds,
  monthLabelDe,
  monthlyRunLines,
  skontoTerms,
  todayBerlin,
} from '../domain/invoice/calc.js';
import type {
  InvoiceDocument,
  InvoiceFormat,
  InvoiceKind,
  BuyerSnapshot,
  SellerSnapshot,
  PrepaymentReference,
} from '../domain/invoice/types.js';
import type { Cents, Quantity } from '../domain/money/money.js';
import { buildBuyerSnapshot, getCustomer, getSeller } from './masterdata.js';

export class BusinessError extends Error {}

export interface InvoiceRow {
  id: string;
  kind: InvoiceKind;
  status: 'draft' | 'issued';
  number: string | null;
  customer_id: string;
  site_id: string | null;
  original_invoice_id: string | null;
  issue_date: string | null;
  due_date: string | null;
  period_start: string | null;
  period_end: string | null;
  invoice_format: InvoiceFormat;
  buyer_reference: string | null;
  order_reference: string | null;
  intro_text: string | null;
  closing_text: string | null;
  net_cents: bigint;
  vat_cents: bigint;
  gross_cents: bigint;
  prepaid_cents: bigint;
  payable_cents: bigint;
  seller_snapshot: SellerSnapshot | null;
  buyer_snapshot: BuyerSnapshot | null;
  monthly_run_key: string | null;
  skonto_percent_bp: number | null;
  skonto_days: number | null;
  skonto_date: string | null;
  created_at: Date;
  issued_at: Date | null;
}

export interface LineRow {
  id: string;
  position: number;
  description: string;
  detail: string | null;
  quantity_milli: bigint;
  unit_code: string;
  unit_price_cents: bigint;
  net_cents: bigint;
  vat_rate_bp: number;
  source_service_id: string | null;
}

export const toDraftInput = (l: LineRow): DraftLineInput => ({
  description: l.description,
  detail: l.detail,
  quantity: l.quantity_milli as Quantity,
  unitCode: l.unit_code,
  unitPrice: l.unit_price_cents as Cents,
  vatRate: l.vat_rate_bp,
  sourceServiceId: l.source_service_id,
});

async function audit(
  tx: Tx | Sql,
  actor: string,
  action: string,
  entityId: string,
  details: Record<string, unknown> = {},
) {
  await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
           values (${actor}, ${action}, 'invoice', ${entityId}, ${tx.json(details as never)})`;
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

export async function listInvoices(sql: Sql, filter: { status?: 'draft' | 'issued' } = {}) {
  return sql<
    (InvoiceRow & {
      customer_name: string;
      site_name: string | null;
      original_number: string | null;
      delivery_status: string | null;
    })[]
  >`
    select i.*, c.name as customer_name, s.name as site_name, o.number as original_number,
           (select d.status::text from app.invoice_deliveries d where d.invoice_id = i.id order by d.created_at desc limit 1) as delivery_status
      from app.invoices i
      join app.customers c on c.id = i.customer_id
      left join app.sites s on s.id = i.site_id
      left join app.invoices o on o.id = i.original_invoice_id
     where ${filter.status ? sql`i.status = ${filter.status}` : sql`true`}
     order by i.status, i.number_year desc nulls first, i.number_seq desc nulls first, i.created_at desc`;
}

export async function getInvoice(sql: Sql | Tx, id: string) {
  const [inv] = await sql<InvoiceRow[]>`select * from app.invoices where id = ${id}`;
  if (!inv) return undefined;
  const lines = await sql<
    LineRow[]
  >`select * from app.invoice_lines where invoice_id = ${id} order by position`;
  const prepayments = await sql<(InvoiceRow & { partial_invoice_id: string })[]>`
    select p.partial_invoice_id, i.* from app.invoice_prepayments p
      join app.invoices i on i.id = p.partial_invoice_id
     where p.final_invoice_id = ${id} order by i.number`;
  const [original] = inv.original_invoice_id
    ? await sql<InvoiceRow[]>`select * from app.invoices where id = ${inv.original_invoice_id}`
    : [];
  const derived = await sql<
    InvoiceRow[]
  >`select * from app.invoices where original_invoice_id = ${id} order by created_at`;
  return { invoice: inv, lines, prepayments, original, derived };
}

// ---------------------------------------------------------------------------
// Entwürfe
// ---------------------------------------------------------------------------

export interface DraftInput {
  customerId: string;
  siteId: string | null;
  kind: 'invoice' | 'partial' | 'final';
  periodStart: string | null;
  periodEnd: string | null;
  orderReference: string | null;
  introText: string | null;
  closingText: string | null;
  lines: DraftLineInput[];
  prepaymentIds?: string[];
}

async function writeLines(tx: Tx, invoiceId: string, inputs: DraftLineInput[], prepaid: Cents) {
  const d = calculateDraft(inputs, prepaid);
  await tx`delete from app.invoice_lines where invoice_id = ${invoiceId}`;
  if (d.lines.length) {
    await tx`insert into app.invoice_lines ${tx(
      d.lines.map((l) => ({
        invoice_id: invoiceId,
        position: l.position,
        description: l.description,
        detail: l.detail ?? null,
        quantity_milli: l.quantity,
        unit_code: l.unitCode,
        unit_price_cents: l.unitPrice,
        net_cents: l.netAmount,
        vat_rate_bp: l.vatRate,
        source_service_id: l.sourceServiceId ?? null,
      })),
    )}`;
  }
  await tx`update app.invoices set net_cents = ${d.net}, vat_cents = ${d.vat}, gross_cents = ${d.gross},
             prepaid_cents = ${d.prepaid}, payable_cents = ${d.payable} where id = ${invoiceId}`;
}

async function prepaidFor(tx: Tx, customerId: string, ids: string[]): Promise<Cents> {
  if (!ids.length) return 0n as Cents;
  const rows = await tx<
    { id: string; gross_cents: bigint; customer_id: string; kind: string; status: string }[]
  >`
    select id, gross_cents, customer_id, kind, status from app.invoices where id in ${tx(ids)}`;
  if (rows.length !== ids.length) throw new BusinessError('Abschlagsrechnung nicht gefunden');
  for (const r of rows) {
    if (r.kind !== 'partial' || r.status !== 'issued' || r.customer_id !== customerId) {
      throw new BusinessError(
        'Nur ausgestellte Abschlagsrechnungen desselben Kunden können verrechnet werden',
      );
    }
  }
  const cancelled =
    await tx`select 1 from app.invoices where kind = 'cancellation' and original_invoice_id in ${tx(ids)}`;
  if (cancelled.length)
    throw new BusinessError('Stornierte Abschlagsrechnungen können nicht verrechnet werden');
  return rows.reduce((a, r) => a + r.gross_cents, 0n) as Cents;
}

/** Legt einen Entwurf an. `id` vom Aufrufer → wiederholtes Absenden erzeugt keinen zweiten Entwurf. */
export async function saveDraft(sql: Sql, id: string, input: DraftInput, actor: string): Promise<string> {
  const customer = await getCustomer(sql, input.customerId);
  if (!customer) throw new BusinessError('Kunde nicht gefunden');
  if (input.kind === 'final' && !input.prepaymentIds?.length) {
    throw new BusinessError('Schlussrechnung: bitte mindestens eine Abschlagsrechnung auswählen');
  }
  await sql.begin(async (tx) => {
    const [existing] = await tx<
      { status: string; kind: string }[]
    >`select status, kind from app.invoices where id = ${id} for update`;
    if (existing && existing.status !== 'draft')
      throw new BusinessError('Ausgestellte Rechnungen sind unveränderbar');
    if (existing && !['invoice', 'partial', 'final'].includes(existing.kind)) {
      throw new BusinessError('Storno-/Korrekturentwürfe werden über die Originalrechnung bearbeitet');
    }
    const row = {
      kind: input.kind,
      customer_id: input.customerId,
      site_id: input.siteId,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      order_reference: input.orderReference,
      intro_text: input.introText,
      closing_text: input.closingText,
      invoice_format: customer.invoice_format,
      buyer_reference: customer.leitweg_id,
    };
    if (existing) {
      await tx`update app.invoices set ${tx(row as Record<string, unknown>)} where id = ${id}`;
    } else {
      await tx`insert into app.invoices ${tx({ id, ...row } as Record<string, unknown>)}`;
    }
    await tx`delete from app.invoice_prepayments where final_invoice_id = ${id}`;
    const ids = input.kind === 'final' ? (input.prepaymentIds ?? []) : [];
    for (const pid of ids) {
      await tx`insert into app.invoice_prepayments (final_invoice_id, partial_invoice_id) values (${id}, ${pid})`;
    }
    await writeLines(tx, id, input.lines, await prepaidFor(tx, input.customerId, ids));
    await audit(tx, actor, existing ? 'update_draft' : 'create_draft', id, { kind: input.kind });
  });
  return id;
}

export async function deleteDraft(sql: Sql, id: string, actor: string) {
  await sql.begin(async (tx) => {
    const [inv] = await tx<{ status: string }[]>`select status from app.invoices where id = ${id} for update`;
    if (!inv) return;
    if (inv.status !== 'draft')
      throw new BusinessError('Ausgestellte Rechnungen können nicht gelöscht werden');
    await tx`delete from app.invoices where id = ${id}`;
    await audit(tx, actor, 'delete_draft', id);
  });
}

// ---------------------------------------------------------------------------
// Monatslauf
// ---------------------------------------------------------------------------

export interface MonthlyRunResult {
  created: { invoiceId: string; siteName: string }[];
  skipped: { siteName: string; reason: string }[];
}

/**
 * Erzeugt je aktivem Objekt mit Monatspauschalen genau einen Entwurf für den Monat.
 * Idempotent über monthly_run_key (Objekt + Monat): ein zweiter Lauf legt nichts doppelt an.
 */
export async function runMonthly(sql: Sql, month: string, actor: string): Promise<MonthlyRunResult> {
  const { start, end } = monthBounds(month);
  const sites = await sql<
    {
      id: string;
      name: string;
      site_no: string;
      street: string | null;
      postal_code: string | null;
      city: string | null;
      customer_id: string;
      order_reference: string | null;
      customer_active: boolean;
    }[]
  >`
    select s.id, s.name, s.site_no, s.street, s.postal_code, s.city, s.customer_id, s.order_reference,
           c.active as customer_active
      from app.sites s join app.customers c on c.id = s.customer_id
     where s.active order by s.site_no`;
  const result: MonthlyRunResult = { created: [], skipped: [] };
  for (const site of sites) {
    if (!site.customer_active) {
      result.skipped.push({ siteName: site.name, reason: 'Kunde inaktiv' });
      continue;
    }
    const services = await sql<
      {
        id: string;
        kind: 'monthly_flat';
        description: string;
        unit_code: string;
        quantity_milli: bigint;
        unit_price_cents: bigint;
        vat_rate_bp: number;
        valid_from: string;
        valid_to: string | null;
        active: boolean;
        note: string | null;
      }[]
    >`select * from app.site_services where site_id = ${site.id} order by sort_order, description`;
    const lines = monthlyRunLines(
      services.map((s) => ({
        id: s.id,
        kind: s.kind,
        description: s.description,
        unitCode: s.unit_code,
        quantity: s.quantity_milli as Quantity,
        unitPrice: s.unit_price_cents as Cents,
        vatRate: s.vat_rate_bp,
        validFrom: s.valid_from,
        validTo: s.valid_to,
        active: s.active,
        note: s.note,
      })),
      month,
      {
        siteNo: site.site_no,
        name: site.name,
        street: site.street,
        postalCode: site.postal_code,
        city: site.city,
      },
    );
    if (!lines.length) {
      result.skipped.push({ siteName: site.name, reason: 'keine gültige Monatspauschale' });
      continue;
    }
    const key = `${site.id}:${month}`;
    const id = randomUUID();
    const created = await sql.begin(async (tx) => {
      const customer = await getCustomer(tx as unknown as Sql, site.customer_id);
      const [row] = await tx`
        insert into app.invoices (id, kind, customer_id, site_id, period_start, period_end, invoice_format,
                                  buyer_reference, order_reference, monthly_run_key)
        values (${id}, 'invoice', ${site.customer_id}, ${site.id}, ${start}, ${end}, ${customer!.invoice_format},
                ${customer!.leitweg_id}, ${site.order_reference}, ${key})
        on conflict (monthly_run_key) do nothing
        returning id`;
      if (!row) return false;
      await writeLines(tx, id, lines, 0n as Cents);
      await audit(tx, actor, 'monthly_run', id, { month, site_id: site.id });
      return true;
    });
    if (created) result.created.push({ invoiceId: id, siteName: site.name });
    else
      result.skipped.push({
        siteName: site.name,
        reason: `Entwurf/Rechnung für ${monthLabelDe(month)} existiert bereits`,
      });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Storno & Korrektur
// ---------------------------------------------------------------------------

async function loadIssuedOriginal(tx: Tx, originalId: string) {
  const [orig] = await tx<InvoiceRow[]>`select * from app.invoices where id = ${originalId} for update`;
  if (!orig) throw new BusinessError('Originalrechnung nicht gefunden');
  if (orig.status !== 'issued')
    throw new BusinessError('Nur ausgestellte Rechnungen können storniert/korrigiert werden');
  if (orig.kind === 'cancellation')
    throw new BusinessError('Eine Stornorechnung kann nicht storniert werden');
  const [cancel] =
    await tx`select id from app.invoices where original_invoice_id = ${originalId} and kind = 'cancellation'`;
  if (cancel) throw new BusinessError('Diese Rechnung wurde bereits storniert');
  if (orig.kind === 'partial') {
    const [used] = await tx`select 1 from app.invoice_prepayments where partial_invoice_id = ${originalId}`;
    if (used) throw new BusinessError('Abschlagsrechnung ist bereits in einer Schlussrechnung verrechnet');
  }
  return orig;
}

/** Stornorechnung: eigene Nummer, Verweis aufs Original, alle Positionen mit negativer Menge. */
export async function createCancellation(sql: Sql, originalId: string, actor: string): Promise<string> {
  return sql.begin(async (tx) => {
    const orig = await loadIssuedOriginal(tx, originalId);
    const origLines = await tx<
      LineRow[]
    >`select * from app.invoice_lines where invoice_id = ${originalId} order by position`;
    const id = randomUUID();
    await tx`insert into app.invoices ${tx({
      id,
      kind: 'cancellation',
      customer_id: orig.customer_id,
      site_id: orig.site_id,
      original_invoice_id: orig.id,
      period_start: orig.period_start,
      period_end: orig.period_end,
      invoice_format: orig.invoice_format,
      buyer_reference: orig.buyer_reference,
      order_reference: orig.order_reference,
      intro_text: `Hiermit stornieren wir die Rechnung ${orig.number} vom ${orig.issue_date!.split('-').reverse().join('.')} vollständig.`,
    } as Record<string, unknown>)}`;
    // Bei Schlussrechnungen werden auch die verrechneten Abschläge zurückgenommen.
    const prepaid = -orig.prepaid_cents as Cents;
    await writeLines(tx, id, cancellationLines(origLines.map(toDraftInput)), prepaid);
    await audit(tx, actor, 'create_cancellation', id, { original: orig.number });
    return id;
  });
}

/** Rechnungskorrektur über Teilbeträge (z. B. Minderung). Positionen frei, i. d. R. negativ. */
export async function createCorrection(
  sql: Sql,
  originalId: string,
  lines: DraftLineInput[],
  introText: string | null,
  actor: string,
) {
  if (!lines.length) throw new BusinessError('Korrektur ohne Positionen');
  return sql.begin(async (tx) => {
    const orig = await loadIssuedOriginal(tx, originalId);
    const id = randomUUID();
    await tx`insert into app.invoices ${tx({
      id,
      kind: 'correction',
      customer_id: orig.customer_id,
      site_id: orig.site_id,
      original_invoice_id: orig.id,
      period_start: orig.period_start,
      period_end: orig.period_end,
      invoice_format: orig.invoice_format,
      buyer_reference: orig.buyer_reference,
      order_reference: orig.order_reference,
      intro_text: introText ?? `Korrektur zur Rechnung ${orig.number}:`,
    } as Record<string, unknown>)}`;
    await writeLines(tx, id, lines, 0n as Cents);
    await audit(tx, actor, 'create_correction', id, { original: orig.number });
    return id;
  });
}

// ---------------------------------------------------------------------------
// Ausstellen
// ---------------------------------------------------------------------------

export function rowToDocument(
  inv: InvoiceRow,
  lines: LineRow[],
  seller: SellerSnapshot,
  buyer: BuyerSnapshot,
  original: { number: string; issueDate: string } | null,
  prepayments: PrepaymentReference[],
  overrides: { number?: string; issueDate?: string; dueDate?: string } = {},
  draftSkonto: { percentBp: number; days: number } | null = null,
): InvoiceDocument {
  const d = calculateDraft(lines.map(toDraftInput), inv.prepaid_cents as Cents);
  const issueDate = overrides.issueDate ?? inv.issue_date ?? '';
  const cfg =
    inv.status === 'issued'
      ? inv.skonto_percent_bp && inv.skonto_days
        ? { percentBp: inv.skonto_percent_bp, days: inv.skonto_days }
        : null
      : draftSkonto && ['invoice', 'partial', 'final'].includes(inv.kind) && inv.payable_cents > 0n
        ? draftSkonto
        : null;
  return {
    kind: inv.kind,
    number: overrides.number ?? inv.number ?? '',
    issueDate,
    dueDate: overrides.dueDate ?? inv.due_date ?? '',
    periodStart: inv.period_start,
    periodEnd: inv.period_end,
    buyerReference: inv.buyer_reference,
    orderReference: inv.order_reference,
    introText: inv.intro_text,
    closingText: inv.closing_text,
    lines: d.lines,
    netTotal: inv.net_cents as Cents,
    vatTotal: inv.vat_cents as Cents,
    grossTotal: inv.gross_cents as Cents,
    prepaidTotal: inv.prepaid_cents as Cents,
    payableTotal: inv.payable_cents as Cents,
    vatBreakdown: d.vatBreakdown,
    seller,
    buyer,
    original,
    prepayments,
    skonto:
      cfg && issueDate ? skontoTerms(inv.payable_cents as Cents, cfg.percentBp, cfg.days, issueDate) : null,
  };
}

export async function loadDocument(
  sql: Sql,
  id: string,
  overrides: { number?: string; issueDate?: string; dueDate?: string } = {},
) {
  const data = await getInvoice(sql, id);
  if (!data) throw new BusinessError('Rechnung nicht gefunden');
  const { invoice: inv, lines, prepayments, original } = data;
  const seller = inv.seller_snapshot ?? (await getSeller(sql));
  const buyer = inv.buyer_snapshot ?? (await buildBuyerSnapshot(sql, inv.customer_id, inv.site_id));
  const customer = inv.status === 'draft' ? await getCustomer(sql, inv.customer_id) : undefined;
  const draftSkonto =
    customer?.skonto_percent_bp && customer.skonto_days
      ? { percentBp: customer.skonto_percent_bp, days: customer.skonto_days }
      : null;
  return rowToDocument(
    inv,
    lines,
    seller,
    buyer,
    original ? { number: original.number!, issueDate: original.issue_date! } : null,
    prepayments.map((p) => ({
      number: p.number!,
      issueDate: p.issue_date!,
      grossAmount: p.gross_cents as Cents,
      netAmount: p.net_cents as Cents,
      vatAmount: p.vat_cents as Cents,
    })),
    overrides,
    draftSkonto,
  );
}

/**
 * Stellt die Rechnung aus: lückenlose Nummer (DB-Funktion), Stammdaten einfrieren.
 * Vorher muss die Vorabprüfung (E-Rechnung gegen KoSIT) bestanden sein – siehe workflow.ts.
 */
export async function issue(sql: Sql, id: string, actor: string, issueDate = todayBerlin()): Promise<string> {
  const data = await getInvoice(sql, id);
  if (!data) throw new BusinessError('Rechnung nicht gefunden');
  if (data.invoice.status === 'issued') return data.invoice.number!;
  const seller = await getSeller(sql);
  const buyer = await buildBuyerSnapshot(sql, data.invoice.customer_id, data.invoice.site_id);
  const [row] = await sql<{ number: string }[]>`
    select app.issue_invoice(${id}, ${issueDate}, ${sql.json(seller as never)}, ${sql.json(buyer as never)}, null) as number`;
  await audit(sql, actor, 'issued_by', id, { number: row!.number });
  return row!.number;
}
