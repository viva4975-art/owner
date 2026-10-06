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
  predecessor_id: string | null;
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
  /** Alternativposition: wird angeboten, zählt aber nicht zur Summe und wird nicht übernommen */
  alternative: boolean;
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
  lines: (DraftLineInput & { recurring: boolean; alternative?: boolean })[];
  expectedVersion?: number | null;
  predecessorId?: string | null;
}

export async function listOffers(
  sql: Sql,
  filter: { status?: OfferStatus[]; customerId?: string; siteId?: string } = {},
) {
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
       and ${filter.siteId ? sql`o.site_id = ${filter.siteId}` : sql`true`}
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
  const main = input.lines.filter((l) => !l.alternative);
  if (!main.length) throw new BusinessError('Mindestens eine Position darf keine Alternative sein');
  // Positionen (Nummern, Zeilenbeträge) über alle Zeilen, Summen nur ohne Alternativen
  const all = calculateDraft(input.lines);
  const d = { ...calculateDraft(main), lines: all.lines };
  const monthly = main.filter((l) => l.recurring).reduce((s, l) => s + lineNet(l.quantity, l.unitPrice), 0n);
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
      await tx`insert into app.offers ${tx({ id, number: `${n!.prefix}${n!.v}`, created_by: actor, predecessor_id: input.predecessorId ?? null, ...row } as Record<string, unknown>)}`;
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
        alternative: input.lines[i]!.alternative ?? false,
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
    // Folgeangebot versendet → voriges Angebot ist überholt
    if (status === 'versendet') {
      const prev = await tx<{ id: string }[]>`
        update app.offers p set status = 'zurueckgezogen'
          from app.offers n where n.id = ${id} and p.id = n.predecessor_id and p.status in ('entwurf', 'versendet')
        returning p.id`;
      for (const r of prev) {
        await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
                 values (${actor}, 'status', 'offer', ${r.id}, ${tx.json({ status: 'zurueckgezogen', replaced_by: id })})`;
      }
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'status', 'offer', ${id}, ${tx.json({ status })})`;
  });
}

/**
 * Kopie als neuer Entwurf. `followUp`: Folgeangebot (überarbeitete Fassung nach Rückfrage) – verweist auf das
 * vorige Angebot, das als „zurückgezogen“ gilt, sobald das Folgeangebot versendet wird. Je Angebot ein Folgeangebot.
 */
export async function copyOffer(
  sql: Sql,
  id: string,
  actor: string,
  opts: { followUp?: boolean; newId?: string } = {},
): Promise<string> {
  const data = await getOffer(sql, id);
  if (!data) throw new BusinessError('Angebot nicht gefunden');
  const o = data.offer;
  if (opts.followUp) {
    const [succ] = await sql<{ id: string }[]>`select id from app.offers where predecessor_id = ${id}`;
    if (succ) return succ.id; // schon angelegt (z. B. doppelt geklickt)
    if (!['entwurf', 'versendet'].includes(o.status))
      throw new BusinessError('Folgeangebot nur zu offenen Angeboten (Entwurf oder versendet)');
  }
  const newId = opts.newId ?? randomUUID();
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
        alternative: l.alternative,
      })),
      ...(opts.followUp ? { predecessorId: id, submissionDeadline: null } : {}),
    },
    actor,
  ).catch(async (e: unknown) => {
    // gleichzeitiger zweiter Klick: Eindeutigkeit des Folgeangebots greift
    if (opts.followUp && (e as { code?: string }).code === '23505') return;
    throw e;
  });
  if (opts.followUp) {
    const [succ] = await sql<{ id: string }[]>`select id from app.offers where predecessor_id = ${id}`;
    if (succ && succ.id !== newId) return succ.id;
  }
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, ${opts.followUp ? 'follow_up' : 'copy'}, 'offer', ${id}, ${sql.json({ new_offer_id: newId })})`;
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
    for (const l of data.lines.filter((x) => !x.alternative)) {
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
      lines: data.lines
        .filter((l) => !l.alternative)
        .map((l) => ({
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
/** Standardtexte wie in Fortytools (gelten, wenn im Angebot nichts Eigenes steht). */
export const OFFER_INTRO_DEFAULT =
  'vielen Dank für Ihre Anfrage und das damit verbundene Interesse an einer Zusammenarbeit. Gerne unterbreiten wir Ihnen folgendes Angebot:';
export const OFFER_CLOSING_DEFAULT =
  'Wir hoffen, dass das Angebot Ihren Anforderungen entspricht und würden uns über eine zukünftige Zusammenarbeit sehr freuen. Für Rückfragen und weitere Informationen stehen wir Ihnen gerne jederzeit zur Verfügung.';

/** Ansprechpartner = Anzeigename des Benutzers, der das Angebot angelegt hat (sonst Anmeldename). */
export async function offerContact(sql: Sql, login: string): Promise<string> {
  const [p] = await sql<{ name: string | null }[]>`
    select p.display_name as name from app.user_accounts a join app.profiles p on p.user_id = a.id where a.login = ${login}`;
  return p?.name || login;
}

export async function renderOfferPdf(sql: Sql, id: string): Promise<{ pdf: Uint8Array; filename: string }> {
  const data = await getOffer(sql, id);
  if (!data) throw new BusinessError('Angebot nicht gefunden');
  const { offer: o, lines } = data;
  const seller = await getSeller(sql);
  const buyer = await buildBuyerSnapshot(sql, o.customer_id, o.site_id);
  const toLine = (l: OfferLineRow) => ({
    description: l.alternative ? `Alternativ: ${l.description}` : l.description,
    detail:
      [
        l.detail,
        l.recurring ? 'monatlich' : 'einmalig',
        l.alternative ? 'Alternativposition – nicht in der Summe enthalten' : null,
      ]
        .filter(Boolean)
        .join('\n') || null,
    quantity: l.quantity_milli as Quantity,
    unitCode: l.unit_code,
    unitPrice: l.unit_price_cents as Cents,
    vatRate: l.vat_rate_bp,
  });
  const d = {
    ...calculateDraft(lines.filter((l) => !l.alternative).map(toLine)),
    lines: calculateDraft(lines.map(toLine)).lines,
  };
  const doc: InvoiceDocument = {
    kind: 'invoice',
    number: o.number,
    issueDate: o.offer_date,
    dueDate: o.offer_date,
    periodStart: null,
    periodEnd: null,
    buyerReference: null,
    orderReference: null,
    introText: o.intro_text ?? OFFER_INTRO_DEFAULT,
    closingText: null,
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
    ['Ansprechpartner', (await offerContact(sql, o.created_by)).slice(0, 34)],
  ];
  if (o.valid_until) info.push(['Gültig bis', formatDateDe(o.valid_until)]);
  if (o.tender_reference) info.push(['Vergabe-Nr.', o.tender_reference]);
  const monthly =
    o.monthly_net_cents > 0n
      ? ` Davon monatlich wiederkehrend: ${(Number(o.monthly_net_cents) / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })} netto.`
      : '';
  const [site] = o.site_id
    ? await sql<
        {
          name: string;
          site_no: string;
          street: string | null;
          postal_code: string | null;
          city: string | null;
        }[]
      >`
        select name, site_no, street, postal_code, city from app.sites where id = ${o.site_id}`
    : [];
  const pdf = await renderInvoicePdf(doc, {
    title: `Angebot ${o.number}`,
    ...(site
      ? {
          subject: `Objekt: ${site.name} (${site.site_no})${[
            site.street,
            [site.postal_code, site.city].filter(Boolean).join(' '),
          ]
            .filter(Boolean)
            .map((x) => `, ${x}`)
            .join('')}`,
        }
      : {}),
    info,
    terms:
      (o.valid_until
        ? `Dieses Angebot ist gültig bis zum ${formatDateDe(o.valid_until)}.`
        : 'Dieses Angebot ist 30 Tage gültig.') +
      monthly +
      ' Es gelten unsere Allgemeinen Geschäftsbedingungen.',
    closing: o.closing_text ?? OFFER_CLOSING_DEFAULT,
    qr: false,
    // Angebot wie Fortytools: Pauschalen mit Einheit „pauschal“
    units: { LS: 'pauschal', MON: 'Monat' },
    ...(o.status === 'entwurf' ? { watermark: 'ENTWURF' } : {}),
  });
  return { pdf, filename: `Angebot_${o.number}.pdf` };
}

export interface OfferStats {
  open: { count: number; net: bigint; monthly: bigint };
  accepted: { count: number; net: bigint; monthly: bigint };
  rejected: { count: number; net: bigint; monthly: bigint };
  withdrawn: number;
  /** Zuschlagsquote = angenommen ÷ (angenommen + abgelehnt), in Prozent; null ohne Entscheidungen */
  rate: number | null;
}

/** Angebote der letzten 12 Monate (Angebotsdatum) nach Status – wie die Fortytools-Statistik. */
export async function offerStats(sql: Sql): Promise<OfferStats> {
  const rows = await sql<{ g: string; count: number; net: bigint; monthly: bigint }[]>`
    select case when status in ('entwurf', 'versendet') then 'open' when status = 'angenommen' then 'accepted'
                when status = 'abgelehnt' then 'rejected' else 'withdrawn' end as g,
           count(*)::int as count, coalesce(sum(net_cents), 0)::bigint as net,
           coalesce(sum(monthly_net_cents), 0)::bigint as monthly
      from app.offers
     where offer_date > (now() at time zone 'Europe/Berlin')::date - interval '12 months'
     group by 1`;
  const get = (g: string) => {
    const r = rows.find((x) => x.g === g);
    return { count: r?.count ?? 0, net: r?.net ?? 0n, monthly: r?.monthly ?? 0n };
  };
  const accepted = get('accepted');
  const rejected = get('rejected');
  const decided = accepted.count + rejected.count;
  return {
    open: get('open'),
    accepted,
    rejected,
    withdrawn: get('withdrawn').count,
    rate: decided ? Math.round((accepted.count * 100) / decided) : null,
  };
}

/** Zuletzt bearbeitete Kunden des Benutzers (Kunden, Angebote, Rechnungen – laut Protokoll). */
export async function recentCustomers(sql: Sql, actor: string, limit = 8) {
  return sql<{ id: string; name: string; customer_no: string }[]>`
    with t as (
      select coalesce(case when a.entity = 'customer' then a.entity_id end, o.customer_id, i.customer_id) as customer_id,
             max(a.at) as at
        from app.audit_log a
        left join app.offers o on a.entity = 'offer' and o.id = a.entity_id
        left join app.invoices i on a.entity = 'invoice' and i.id = a.entity_id
       where a.actor = ${actor} and a.entity in ('customer', 'offer', 'invoice')
         and a.at > now() - interval '90 days'
       group by 1)
    select c.id, c.name, c.customer_no from t join app.customers c on c.id = t.customer_id
     where c.active order by t.at desc limit ${limit}`;
}
