import { randomUUID } from 'node:crypto';
import type { Sql, Tx } from '../db/client.js';
import {
  type BillingCycle,
  type DraftLineInput,
  calculateDraft,
  cancellationLines,
  monthBounds,
  monthLabelDe,
  billingPeriod,
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

export { BusinessError } from './errors.js';
import { BusinessError } from './errors.js';
import { assertVersion } from './crm.js';

export interface InvoiceRow {
  id: string;
  kind: InvoiceKind;
  status: 'draft' | 'issued';
  number: string | null;
  customer_id: string;
  site_id: string | null;
  invoice_group_id: string | null;
  planned_issue_date: string | null;
  review_required: boolean;
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
  version: number;
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
    select i.*, c.name as customer_name, coalesce(s.name, 'Rechnungsgruppe ' || g.name) as site_name,
           o.number as original_number,
           (select d.status::text from app.invoice_deliveries d where d.invoice_id = i.id order by d.created_at desc limit 1) as delivery_status
      from app.invoices i
      join app.customers c on c.id = i.customer_id
      left join app.sites s on s.id = i.site_id
      left join app.invoice_groups g on g.id = i.invoice_group_id
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
  /** Version, die das Formular geladen hat (Schutz vor Überschreiben aus anderem Tab). */
  expectedVersion?: number | null;
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
      { status: string; kind: string; version: number }[]
    >`select status, kind, version from app.invoices where id = ${id} for update`;
    assertVersion(existing?.version, input.expectedVersion, 'Der Rechnungsentwurf');
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

interface RunSite {
  id: string;
  name: string;
  site_no: string;
  street: string | null;
  postal_code: string | null;
  city: string | null;
  customer_id: string;
  order_reference: string | null;
  customer_active: boolean;
  invoice_group_id: string | null;
}

export interface RunService {
  id: string;
  site_id: string;
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
  billing_cycle: BillingCycle;
  always_unfinished: boolean;
  invoice_group_id: string | null;
  separate_invoice: boolean;
}

interface RunGroup {
  id: string;
  name: string;
  active: boolean;
  buyer_reference: string | null;
  order_reference: string | null;
  intro_text: string | null;
  closing_text: string | null;
}

export interface RunOptions {
  /** nur diese Objekte abrechnen („Leistungen abrechnen“ am Objekt) */
  siteIds?: string[];
  /** Rechnungsdatum, das beim Ausstellen verwendet wird (sonst Ausstellungstag) */
  invoiceDate?: string | null;
}

/**
 * Abrechnungslauf für einen Monat (wie Fortytools „Vorfaktura“): jede fällige Pauschale landet auf genau einer
 * Rechnung. Ziel der Leistung: eigene Rechnung („separat“) → Rechnungsgruppe der Leistung → Rechnungsgruppe des
 * Objekts → Rechnung je Objekt. Zyklen (monatlich … jährlich) über billingPeriod().
 * Idempotent: monthly_run_key je Ziel + Monat und zusätzlich je Leistung + Monat (app.monthly_run_services) –
 * eine Leistung wird je Monat nie zweimal abgerechnet, auch wenn sie das Ziel wechselt.
 */
export async function runMonthly(
  sql: Sql,
  month: string,
  actor: string,
  opts: RunOptions = {},
): Promise<MonthlyRunResult> {
  monthBounds(month); // prüft das Format
  if (opts.invoiceDate && !/^\d{4}-\d{2}-\d{2}$/.test(opts.invoiceDate)) {
    throw new BusinessError('Rechnungsdatum ungültig');
  }
  const sites = await sql<RunSite[]>`
    select s.id, s.name, s.site_no, s.street, s.postal_code, s.city, s.customer_id, s.order_reference,
           c.active as customer_active, s.invoice_group_id
      from app.sites s join app.customers c on c.id = s.customer_id
     where s.active and ${opts.siteIds ? (opts.siteIds.length ? sql`s.id in ${sql(opts.siteIds)}` : sql`false`) : sql`true`}
     order by s.site_no`;
  const groups = new Map(
    (
      await sql<
        RunGroup[]
      >`select id, name, active, buyer_reference, order_reference, intro_text, closing_text
                            from app.invoice_groups`
    ).map((g) => [g.id, g]),
  );
  const result: MonthlyRunResult = { created: [], skipped: [] };

  // Abrechnungseinheiten bilden
  interface Unit {
    key: string;
    label: string;
    customerId: string;
    site: RunSite | null; // Rechnung je Objekt bzw. eigene Rechnung
    group: RunGroup | null;
    items: { site: RunSite; service: RunService; line: DraftLineInput }[];
  }
  const units = new Map<string, Unit>();
  for (const site of sites) {
    if (!site.customer_active) {
      result.skipped.push({ siteName: site.name, reason: 'Kunde inaktiv' });
      continue;
    }
    const services = await sql<RunService[]>`
      select * from app.site_services where site_id = ${site.id} order by sort_order, description`;
    let any = false;
    for (const sv of services) {
      const [line] = monthlyRunLines([toRunService(sv)], month, siteForRun(site));
      if (!line) continue;
      any = true;
      const gid = sv.separate_invoice ? null : (sv.invoice_group_id ?? site.invoice_group_id);
      const group = gid ? groups.get(gid) : undefined;
      const useGroup = group?.active ? group : null;
      const key = sv.separate_invoice ? `service:${sv.id}` : useGroup ? `group:${useGroup.id}` : site.id;
      const label = sv.separate_invoice
        ? `${site.name} – ${sv.description}`
        : useGroup
          ? `${useGroup.name} (Rechnungsgruppe)`
          : site.name;
      const u = units.get(key) ?? {
        key,
        label,
        customerId: site.customer_id,
        site: useGroup ? null : site,
        group: useGroup,
        items: [],
      };
      u.items.push({ site, service: sv, line });
      units.set(key, u);
    }
    if (!any) result.skipped.push({ siteName: site.name, reason: 'keine fällige Pauschale' });
  }

  const { start } = monthBounds(month);
  for (const u of units.values()) {
    // Zeitraum der Rechnung = vom frühesten bis spätesten Leistungszeitraum (z. B. quartalsweise)
    const periodEnd = u.items
      .map((i) => billingPeriod(i.service.billing_cycle, i.service.valid_from, month)!.end)
      .reduce((a, b) => (b > a ? b : a), monthBounds(month).end);
    const id = randomUUID();
    try {
      const outcome = await sql.begin(async (tx) => {
        const billed = await tx<{ service_id: string }[]>`
          select service_id from app.monthly_run_services
           where month = ${month} and service_id in ${tx(u.items.map((i) => i.service.id))}`;
        const done = new Set(billed.map((b) => b.service_id));
        const todo = u.items.filter((i) => !done.has(i.service.id));
        if (!todo.length) return { created: false };
        const customer = await getCustomer(tx as unknown as Sql, u.customerId);
        const [row] = await tx`
          insert into app.invoices (id, kind, customer_id, site_id, invoice_group_id, period_start, period_end,
                                    invoice_format, buyer_reference, order_reference, intro_text, closing_text,
                                    monthly_run_key, planned_issue_date, review_required)
          values (${id}, 'invoice', ${u.customerId}, ${u.site?.id ?? null}, ${u.group?.id ?? null}, ${start},
                  ${periodEnd}, ${customer!.invoice_format},
                  ${u.group?.buyer_reference || customer!.leitweg_id},
                  ${u.group ? u.group.order_reference : (u.site?.order_reference ?? null)},
                  ${u.group?.intro_text ?? null}, ${u.group?.closing_text ?? null},
                  ${`${u.key}:${month}`}, ${opts.invoiceDate ?? null},
                  ${todo.some((i) => i.service.always_unfinished)})
          on conflict (monthly_run_key) do nothing
          returning id`;
        if (!row) return { created: false };
        for (const i of todo) {
          await tx`insert into app.monthly_run_services (service_id, month, invoice_id)
                   values (${i.service.id}, ${month}, ${id})`;
        }
        await writeLines(
          tx,
          id,
          todo.map((i) => i.line),
          0n as Cents,
        );
        await audit(tx, actor, 'monthly_run', id, {
          month,
          ...(u.group ? { invoice_group_id: u.group.id } : {}),
          site_ids: [...new Set(todo.map((i) => i.site.id))],
          service_ids: todo.map((i) => i.service.id),
        });
        return { created: true };
      });
      if (outcome.created) result.created.push({ invoiceId: id, siteName: u.label });
      else
        result.skipped.push({
          siteName: u.label,
          reason: `Entwurf/Rechnung für ${monthLabelDe(month)} existiert bereits`,
        });
    } catch (e) {
      // paralleler Lauf hat dieselbe Leistung gerade abgerechnet
      if ((e as { code?: string }).code === '23505') {
        result.skipped.push({
          siteName: u.label,
          reason: `Entwurf/Rechnung für ${monthLabelDe(month)} existiert bereits`,
        });
      } else throw e;
    }
  }
  return result;
}

export const toRunService = (s: RunService) => ({
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
  cycle: s.billing_cycle,
});

const siteForRun = (s: RunSite) => ({
  siteNo: s.site_no,
  name: s.name,
  street: s.street,
  postalCode: s.postal_code,
  city: s.city,
});

/** Was ist für den Monat noch abzurechnen? (Vorschau für „Leistungen abrechnen“ am Objekt) */
export async function billingPreview(sql: Sql, siteId: string, month: string) {
  const [site] = await sql<RunSite[]>`
    select s.id, s.name, s.site_no, s.street, s.postal_code, s.city, s.customer_id, s.order_reference,
           true as customer_active, s.invoice_group_id from app.sites s where s.id = ${siteId}`;
  if (!site) return [];
  const services = await sql<
    (RunService & { billed_invoice: string | null; billed_number: string | null })[]
  >`
    select ss.*, r.invoice_id as billed_invoice, i.number as billed_number
      from app.site_services ss
      left join app.monthly_run_services r on r.service_id = ss.id and r.month = ${month}
      left join app.invoices i on i.id = r.invoice_id
     where ss.site_id = ${siteId} order by ss.sort_order, ss.description`;
  return services.flatMap((sv) => {
    const [line] = monthlyRunLines([toRunService(sv)], month, siteForRun(site));
    return line
      ? [{ service: sv, line, billedInvoice: sv.billed_invoice, billedNumber: sv.billed_number }]
      : [];
  });
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
      invoice_group_id: orig.invoice_group_id,
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
      invoice_group_id: orig.invoice_group_id,
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
    // Lastschrift: kein Skonto auf der Rechnung (eingezogen wird der volle Betrag zum Fälligkeitstag)
    skonto:
      cfg && issueDate && !buyer.directDebit
        ? skontoTerms(inv.payable_cents as Cents, cfg.percentBp, cfg.days, issueDate)
        : null,
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
export async function issue(sql: Sql, id: string, actor: string, date?: string): Promise<string> {
  const data = await getInvoice(sql, id);
  if (!data) throw new BusinessError('Rechnung nicht gefunden');
  if (data.invoice.status === 'issued') return data.invoice.number!;
  if (data.invoice.review_required) {
    throw new BusinessError(
      'Rechnung ist als „unfertig“ markiert (Leistung mit „immer unfertig“). Bitte Positionen prüfen und „Geprüft“ setzen.',
    );
  }
  const issueDate = date ?? data.invoice.planned_issue_date ?? todayBerlin();
  if (issueDate > todayBerlin()) {
    throw new BusinessError(
      `Rechnungsdatum ${issueDate.split('-').reverse().join('.')} liegt in der Zukunft – Ausstellen ist erst ab diesem Tag möglich (oder Rechnungsdatum ändern).`,
    );
  }
  const seller = await getSeller(sql);
  const buyer = await buildBuyerSnapshot(sql, data.invoice.customer_id, data.invoice.site_id);
  const [row] = await sql<{ number: string }[]>`
    select app.issue_invoice(${id}, ${issueDate}, ${sql.json(seller as never)}, ${sql.json(buyer as never)}, null) as number`;
  await audit(sql, actor, 'issued_by', id, { number: row!.number });
  return row!.number;
}

/** „Unfertig“-Kennzeichen nach Prüfung entfernen bzw. geplantes Rechnungsdatum ändern (nur Entwürfe). */
export async function markReviewed(sql: Sql, id: string, actor: string) {
  const res =
    await sql`update app.invoices set review_required = false where id = ${id} and status = 'draft' returning id`;
  if (res.length) await audit(sql, actor, 'reviewed', id, {});
}

export async function setPlannedIssueDate(sql: Sql, id: string, date: string | null, actor: string) {
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BusinessError('Rechnungsdatum ungültig');
  const res =
    await sql`update app.invoices set planned_issue_date = ${date} where id = ${id} and status = 'draft' returning id`;
  if (res.length) await audit(sql, actor, 'planned_issue_date', id, { date });
}
