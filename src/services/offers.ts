import { randomUUID } from 'node:crypto';
import type { Sql, Tx } from '../db/client.js';
import { type DraftLineInput, calculateDraft, formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import type { InvoiceDocument } from '../domain/invoice/types.js';
import { type Cents, type Quantity, lineNet } from '../domain/money/money.js';
import { renderInvoicePdf } from '../pdf/render.js';
import { assertVersion } from './crm.js';
import { BusinessError } from './errors.js';
import { saveDraft } from './invoices.js';
import { buildBuyerSnapshot, getSeller } from './masterdata.js';

export type OfferStatus = 'entwurf' | 'versendet' | 'angenommen' | 'abgelehnt' | 'zurueckgezogen';

export const OFFER_STATUS: Record<OfferStatus, string> = {
  entwurf: 'Entwurf',
  versendet: 'Versendet',
  angenommen: 'Angenommen',
  abgelehnt: 'Abgelehnt',
  zurueckgezogen: 'Zurückgezogen',
};

export interface OfferRow {
  id: string;
  number: string;
  customer_id: string;
  site_id: string | null;
  title: string;
  tender_reference: string | null;
  tender_platform: string | null;
  submission_deadline: Date | null;
  offer_date: string;
  valid_until: string | null;
  status: OfferStatus;
  intro_text: string | null;
  closing_text: string | null;
  net_cents: bigint;
  vat_cents: bigint;
  gross_cents: bigint;
  monthly_net_cents: bigint;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  decided_at: Date | null;
  version: number;
}

export interface OfferLineRow {
  id: string;
  position: number;
  description: string;
  detail: string | null;
  quantity_milli: bigint;
  unit_code: string;
  unit_price_cents: bigint;
  net_cents: bigint;
  vat_rate_bp: number;
  recurring: boolean;
}

export interface OfferInput {
  customerId: string;
  siteId: string | null;
  title: string;
  tenderReference: string | null;
  tenderPlatform: string | null;
  submissionDeadline: string | null; // 'YYYY-MM-DDTHH:mm' (deutsche Zeit)
  offerDate: string;
  validUntil: string | null;
  introText: string | null;
  closingText: string | null;
  lines: (DraftLineInput & { recurring: boolean })[];
  expectedVersion?: number | null;
}

export async function listOffers(sql: Sql, filter: { status?: OfferStatus[]; customerId?: string } = {}) {
  return sql<
    (OfferRow & {
      customer_name: string;
      customer_no: string;
      file_count: number;
      days_left: number | null;
    })[]
  >`
    select o.*, c.name as customer_name, c.customer_no,
           (select count(*)::int from app.file_links l join app.files f on f.id = l.file_id
             where l.entity_type = 'offer' and l.entity_id = o.id and f.status = 'complete') as file_count,
           case when o.submission_deadline is null then null
                else (o.submission_deadline at time zone 'Europe/Berlin')::date - (now() at time zone 'Europe/Berlin')::date end::int as days_left
      from app.offers o join app.customers c on c.id = o.customer_id
     where ${filter.status?.length ? sql`o.status in ${sql(filter.status)}` : sql`true`}
       and ${filter.customerId ? sql`o.customer_id = ${filter.customerId}` : sql`true`}
     order by (o.status = 'entwurf') desc, o.submission_deadline nulls last, o.number desc`;
}

export async function getOffer(sql: Sql | Tx, id: string) {
  const [o] = await sql<OfferRow[]>`select * from app.offers where id = ${id}`;
  if (!o) return undefined;
  const lines = await sql<
    OfferLineRow[]
  >`select * from app.offer_lines where offer_id = ${id} order by position`;
  return { offer: o, lines };
}

/** Anlegen/Ändern. Neue Angebote bekommen sofort eine Nummer (wie Fortytools, z. B. 3843). */
export async function saveOffer(sql: Sql, id: string, input: OfferInput, actor: string): Promise<string> {
  if (!input.title.trim())
    throw new BusinessError('Bitte einen Titel angeben (z. B. „Unterhaltsreinigung Grundschule …“)');
  if (!input.lines.length) throw new BusinessError('Bitte mindestens eine Position erfassen');
  const d = calculateDraft(input.lines);
  const monthly = input.lines
    .filter((l) => l.recurring)
    .reduce((s, l) => s + lineNet(l.quantity, l.unitPrice), 0n);
  // Abgabefrist kommt als deutsche Ortszeit 'YYYY-MM-DDTHH:mm' → in der DB nach Europe/Berlin umrechnen
  const deadline = input.submissionDeadline;
  if (deadline !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(deadline))
    throw new BusinessError('Abgabefrist ungültig');
  await sql.begin(async (tx) => {
    const [cur] = await tx<
      { version: number; status: OfferStatus }[]
    >`select version, status from app.offers where id = ${id} for update`;
    assertVersion(cur?.version, input.expectedVersion, 'Das Angebot');
    if (cur && cur.status !== 'entwurf') {
      throw new BusinessError(
        'Nur Angebote im Entwurf können geändert werden. Für Änderungen bitte „Als neues Angebot kopieren“.',
      );
    }
    const row = {
      customer_id: input.customerId,
      site_id: input.siteId,
      title: input.title.trim(),
      tender_reference: input.tenderReference,
      tender_platform: input.tenderPlatform,
      offer_date: input.offerDate,
      valid_until: input.validUntil,
      intro_text: input.introText,
      closing_text: input.closingText,
      net_cents: d.net,
      vat_cents: d.vat,
      gross_cents: d.gross,
      monthly_net_cents: monthly,
    };
    if (cur) {
      await tx`update app.offers set ${tx({ ...row, updated_at: new Date() } as Record<string, unknown>)},
                 submission_deadline = (${deadline}::text)::timestamp at time zone 'Europe/Berlin' where id = ${id}`;
    } else {
      const [n] = await tx<{ v: bigint; prefix: string }[]>`
        update app.number_ranges set next_value = next_value + 1 where key = 'offer' returning next_value - 1 as v, prefix`;
      await tx`insert into app.offers ${tx({ id, number: `${n!.prefix}${n!.v}`, created_by: actor, ...row } as Record<string, unknown>)}`;
      await tx`update app.offers set submission_deadline = (${deadline}::text)::timestamp at time zone 'Europe/Berlin' where id = ${id}`;
    }
    await tx`delete from app.offer_lines where offer_id = ${id}`;
    await tx`insert into app.offer_lines ${tx(
      d.lines.map((l, i) => ({
        offer_id: id,
        position: l.position,
        description: l.description,
        detail: l.detail ?? null,
        quantity_milli: l.quantity,
        unit_code: l.unitCode,
        unit_price_cents: l.unitPrice,
        net_cents: l.netAmount,
        vat_rate_bp: l.vatRate,
        recurring: input.lines[i]!.recurring,
      })),
    )}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, ${cur ? 'update' : 'create'}, 'offer', ${id})`;
  });
  return id;
}

export async function setOfferStatus(sql: Sql, id: string, status: OfferStatus, actor: string) {
  await sql.begin(async (tx) => {
    const [o] = await tx<
      { status: OfferStatus }[]
    >`select status from app.offers where id = ${id} for update`;
    if (!o) throw new BusinessError('Angebot nicht gefunden');
    const allowed: Record<OfferStatus, OfferStatus[]> = {
      entwurf: ['versendet', 'zurueckgezogen'],
      versendet: ['angenommen', 'abgelehnt', 'zurueckgezogen'],
      angenommen: [],
      abgelehnt: [],
      zurueckgezogen: [],
    };
    if (o.status === status) return;
    if (!allowed[o.status].includes(status)) {
      throw new BusinessError(
        `Status „${OFFER_STATUS[o.status]}“ kann nicht zu „${OFFER_STATUS[status]}“ wechseln`,
      );
    }
    await tx`update app.offers set status = ${status},
               decided_at = ${['angenommen', 'abgelehnt'].includes(status) ? tx`now()` : null} where id = ${id}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'status', 'offer', ${id}, ${tx.json({ status })})`;
  });
}

/** Kopie als neuer Entwurf (z. B. überarbeitetes Angebot nach Rückfrage). */
export async function copyOffer(sql: Sql, id: string, actor: string): Promise<string> {
  const data = await getOffer(sql, id);
  if (!data) throw new BusinessError('Angebot nicht gefunden');
  const o = data.offer;
  const newId = randomUUID();
  await saveOffer(
    sql,
    newId,
    {
      customerId: o.customer_id,
      siteId: o.site_id,
      title: o.title,
      tenderReference: o.tender_reference,
      tenderPlatform: o.tender_platform,
      submissionDeadline: null,
      offerDate: todayBerlin(),
      validUntil: null,
      introText: o.intro_text,
      closingText: o.closing_text,
      lines: data.lines.map((l) => ({
        description: l.description,
        detail: l.detail,
        quantity: l.quantity_milli as Quantity,
        unitCode: l.unit_code,
        unitPrice: l.unit_price_cents as Cents,
        vatRate: l.vat_rate_bp,
        recurring: l.recurring,
      })),
    },
    actor,
  );
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'copy', 'offer', ${id}, ${sql.json({ new_offer_id: newId })})`;
  return newId;
}

/**
 * Angenommenes Angebot ins Objekt übernehmen: wiederkehrende Positionen werden Monatspauschalen,
 * einmalige werden Sonderleistungen (Vorlagen). Idempotent je Angebot (feste IDs).
 */
export async function acceptIntoSite(
  sql: Sql,
  offerId: string,
  siteId: string,
  validFrom: string,
  actor: string,
) {
  const data = await getOffer(sql, offerId);
  if (!data) throw new BusinessError('Angebot nicht gefunden');
  if (data.offer.status !== 'angenommen')
    throw new BusinessError('Nur angenommene Angebote können übernommen werden');
  const [site] = await sql<{ customer_id: string }[]>`select customer_id from app.sites where id = ${siteId}`;
  if (!site || site.customer_id !== data.offer.customer_id)
    throw new BusinessError('Objekt gehört nicht zum Kunden des Angebots');
  let n = 0;
  await sql.begin(async (tx) => {
    for (const l of data.lines) {
      // deterministische ID: Angebot + Position → zweimal übernehmen legt nichts doppelt an
      const [{ id }] = (await tx`select md5(${offerId} || ':' || ${l.position})::uuid as id`) as unknown as [
        { id: string },
      ];
      const res = await tx`
        insert into app.site_services (id, site_id, kind, description, unit_code, quantity_milli, unit_price_cents,
                                       vat_rate_bp, valid_from, note, sort_order)
        values (${id}, ${siteId}, ${l.recurring ? 'monthly_flat' : 'special'}, ${l.description}, ${l.unit_code},
                ${l.quantity_milli}, ${l.unit_price_cents}, ${l.vat_rate_bp}, ${validFrom},
                ${`aus Angebot ${data.offer.number}`}, ${l.position})
        on conflict (id) do nothing`;
      n += res.count;
    }
    await tx`update app.offers set site_id = ${siteId} where id = ${offerId}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'accept_into_site', 'offer', ${offerId}, ${tx.json({ site_id: siteId, services: n })})`;
  });
  return n;
}

/** Rechnungsentwurf aus dem Angebot (z. B. einmalige Sonderreinigung). */
export async function offerToInvoiceDraft(sql: Sql, offerId: string, actor: string): Promise<string> {
  const data = await getOffer(sql, offerId);
  if (!data) throw new BusinessError('Angebot nicht gefunden');
  if (data.offer.status !== 'angenommen')
    throw new BusinessError('Nur angenommene Angebote können abgerechnet werden');
  const id = randomUUID();
  await saveDraft(
    sql,
    id,
    {
      customerId: data.offer.customer_id,
      siteId: data.offer.site_id,
      kind: 'invoice',
      periodStart: null,
      periodEnd: null,
      orderReference: data.offer.tender_reference,
      introText: `Gemäß unserem Angebot ${data.offer.number} vom ${formatDateDe(data.offer.offer_date)} berechnen wir:`,
      closingText: null,
      lines: data.lines.map((l) => ({
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
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'to_invoice', 'offer', ${offerId}, ${sql.json({ invoice_id: id })})`;
  return id;
}

/** Aus dem Angebot erzeugte Rechnungen (über das Protokoll verknüpft). */
export async function offerInvoices(sql: Sql, offerId: string) {
  return sql<{ id: string; number: string | null; status: string; gross_cents: bigint }[]>`
    select i.id, i.number, i.status, i.gross_cents
      from app.audit_log a join app.invoices i on i.id = (a.details->>'invoice_id')::uuid
     where a.entity = 'offer' and a.entity_id = ${offerId} and a.action = 'to_invoice'
     order by a.at`;
}

/** Angebots-PDF auf dem Briefpapier (gleicher Aufbau wie die Rechnung, ohne Zahlungsteil/GiroCode). */
export async function renderOfferPdf(sql: Sql, id: string): Promise<{ pdf: Uint8Array; filename: string }> {
  const data = await getOffer(sql, id);
  if (!data) throw new BusinessError('Angebot nicht gefunden');
  const { offer: o, lines } = data;
  const seller = await getSeller(sql);
  const buyer = await buildBuyerSnapshot(sql, o.customer_id, o.site_id);
  const d = calculateDraft(
    lines.map((l) => ({
      description: l.description,
      detail: [l.detail, l.recurring ? 'monatlich wiederkehrend' : null].filter(Boolean).join('\n') || null,
      quantity: l.quantity_milli as Quantity,
      unitCode: l.unit_code,
      unitPrice: l.unit_price_cents as Cents,
      vatRate: l.vat_rate_bp,
    })),
  );
  const doc: InvoiceDocument = {
    kind: 'invoice',
    number: o.number,
    issueDate: o.offer_date,
    dueDate: o.offer_date,
    periodStart: null,
    periodEnd: null,
    buyerReference: null,
    orderReference: null,
    introText: o.intro_text ?? `wir danken für Ihre Anfrage und bieten Ihnen für „${o.title}“ an:`,
    closingText: o.closing_text,
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
  };
  const info: [string, string][] = [
    ['Angebotsdatum', formatDateDe(o.offer_date)],
    ['Kundennummer', buyer.customerNo],
  ];
  if (o.valid_until) info.push(['Gültig bis', formatDateDe(o.valid_until)]);
  if (o.tender_reference) info.push(['Vergabe-Nr.', o.tender_reference]);
  const monthly =
    o.monthly_net_cents > 0n
      ? ` Davon monatlich wiederkehrend: ${(Number(o.monthly_net_cents) / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })} netto.`
      : '';
  const pdf = await renderInvoicePdf(doc, {
    title: `Angebot ${o.number}`,
    info,
    terms:
      (o.valid_until
        ? `Dieses Angebot ist gültig bis zum ${formatDateDe(o.valid_until)}.`
        : 'Dieses Angebot ist 30 Tage gültig.') +
      monthly +
      ' Es gelten unsere Allgemeinen Geschäftsbedingungen.',
    closing:
      'Für Rückfragen stehen wir Ihnen jederzeit gerne zur Verfügung. Wir freuen uns auf Ihren Auftrag.',
    qr: false,
    ...(o.status === 'entwurf' ? { watermark: 'ENTWURF' } : {}),
  });
  return { pdf, filename: `Angebot_${o.number}.pdf` };
}
