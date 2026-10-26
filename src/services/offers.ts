import { randomUUID } from 'node:crypto';
import type { Sql, Tx } from '../db/client.js';
import {
  type DraftLineInput,
  addDays,
  calculateDraft,
  formatDateDe,
  todayBerlin,
} from '../domain/invoice/calc.js';
import type { InvoiceDocument } from '../domain/invoice/types.js';
import { type Cents, type Quantity, lineNet } from '../domain/money/money.js';
import { renderInvoicePdf } from '../pdf/invoice-pdf.js';
import { assertVersion } from './crm.js';
import { BusinessError } from './errors.js';
import { saveDraft } from './invoices.js';
import { buildBuyerSnapshot, getSeller } from './masterdata.js';

export type OfferStatus =
  'entwurf' | 'versendet' | 'angenommen' | 'abgelehnt' | 'aufgehoben' | 'zurueckgezogen';

export const OFFER_STATUS: Record<OfferStatus, string> = {
  entwurf: 'Entwurf',
  versendet: 'Versendet',
  angenommen: 'Angenommen',
  abgelehnt: 'Abgelehnt',
  aufgehoben: 'Aufgehoben',
  zurueckgezogen: 'Zurückgezogen',
};

export interface OfferRow {
  id: string;
  number: string;
  customer_id: string;
  site_id: string | null;
  /** Objekt als Freitext (nur Info auf dem Angebot), wenn kein Objekt gewählt ist */
  object_text: string | null;
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
  service_type_id: string | null;
  /** jährlich (z. B. Grundreinigung 1×/Jahr) – nicht im Monatspreis, zählt einmal im Jahreswert */
  yearly: boolean;
  /** Los der Ausschreibung (1, 2, …) oder null */
  lot_no: number | null;
}

export type LotStatus = 'offen' | 'angenommen' | 'abgelehnt' | 'aufgehoben';
export const LOT_STATUS: Record<LotStatus, string> = {
  offen: 'offen',
  angenommen: 'Zuschlag',
  abgelehnt: 'Absage',
  aufgehoben: 'aufgehoben',
};
export interface OfferLotRow {
  offer_id: string;
  lot_no: number;
  title: string | null;
  status: LotStatus;
  decided_at: Date | null;
  decided_by: string | null;
}

/** Rhythmus einer Position als Text. */
export const lineCycle = (l: { recurring: boolean; yearly?: boolean }) =>
  l.recurring ? 'monatlich' : l.yearly ? 'jährlich' : 'einmalig';

/**
 * Jahreswert (für Wertung und Statistik, Ahmed 26.10.): monatliche Positionen × 12, jährliche und einmalige einmal.
 * Ohne Alternativpositionen.
 */
export function offerYearValue(
  lines: { recurring: boolean; alternative: boolean; net_cents: bigint }[],
): bigint {
  return lines
    .filter((l) => !l.alternative)
    .reduce((a, l) => a + (l.recurring ? l.net_cents * 12n : l.net_cents), 0n);
}

/** Bezeichnung eines Loses („Los 2 – Unterhaltsreinigung Schule“). */
export const lotLabel = (lot: { lot_no: number; title: string | null }) =>
  `Los ${lot.lot_no}${lot.title ? ` – ${lot.title}` : ''}`;

/**
 * Positionen, die übernommen/abgerechnet werden: ohne Alternativen; bei Losen nur Lose mit Zuschlag
 * (Positionen ohne Los gehören zum ganzen Angebot).
 */
export function awardedLines<L extends { alternative: boolean; lot_no: number | null }>(
  lines: L[],
  lots: { lot_no: number; status: LotStatus }[],
): L[] {
  const won = new Set(lots.filter((x) => x.status === 'angenommen').map((x) => x.lot_no));
  return lines.filter((l) => !l.alternative && (l.lot_no === null || !lots.length || won.has(l.lot_no)));
}

export interface OfferInput {
  customerId: string;
  siteId: string | null;
  objectText?: string | null;
  title: string;
  tenderReference: string | null;
  tenderPlatform: string | null;
  submissionDeadline: string | null; // 'YYYY-MM-DDTHH:mm' (deutsche Zeit)
  offerDate: string;
  validUntil: string | null;
  introText: string | null;
  closingText: string | null;
  lines: (DraftLineInput & {
    recurring: boolean;
    alternative?: boolean;
    yearly?: boolean;
    lot?: number | null;
  })[];
  /** Bezeichnung je Los (Los-Nr. → Titel) */
  lotTitles?: Record<number, string>;
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
  const [lines, lots] = await Promise.all([
    sql<OfferLineRow[]>`select * from app.offer_lines where offer_id = ${id} order by position`,
    sql<OfferLotRow[]>`select * from app.offer_lots where offer_id = ${id} order by lot_no`,
  ]);
  return { offer: o, lines, lots };
}

/** Anlegen/Ändern. Neue Angebote bekommen sofort eine Nummer (wie Fortytools, z. B. 3843). */
export async function saveOffer(sql: Sql, id: string, input: OfferInput, actor: string): Promise<string> {
  if (!input.lines.length) throw new BusinessError('Bitte mindestens eine Position erfassen');
  const main = input.lines.filter((l) => !l.alternative);
  if (!main.length) throw new BusinessError('Mindestens eine Position darf keine Alternative sein');
  for (const l of input.lines) {
    if (l.recurring && l.yearly)
      throw new BusinessError('Eine Position ist entweder monatlich oder jährlich');
    if (l.lot != null && (!Number.isInteger(l.lot) || l.lot < 1 || l.lot > 99))
      throw new BusinessError('Los-Nummer 1 bis 99');
  }
  // kein eigener Titel/Betreff mehr (Ahmed 15.10.): Titel = erste Position (für Listen und Suche)
  if (!input.title.trim()) input = { ...input, title: main[0]!.description.slice(0, 200) };
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
      object_text: input.siteId ? null : input.objectText?.trim().slice(0, 500) || null,
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
        service_type_id: input.lines[i]!.serviceTypeId ?? null,
        yearly: !input.lines[i]!.recurring && (input.lines[i]!.yearly ?? false),
        lot_no: input.lines[i]!.lot ?? null,
      })),
    )}`;
    // Lose: jede verwendete Los-Nummer bekommt einen Eintrag (Titel änderbar, Entscheidung später je Los)
    const used = [...new Set(input.lines.map((l) => l.lot).filter((n): n is number => n != null))];
    await tx`delete from app.offer_lots where offer_id = ${id} and not (lot_no = any(${used}::int[]))`;
    for (const n of used) {
      const title = input.lotTitles?.[n]?.trim().slice(0, 200) || null;
      await tx`insert into app.offer_lots (offer_id, lot_no, title) values (${id}, ${n}, ${title})
               on conflict (offer_id, lot_no) do update set title = excluded.title`;
    }
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
      entwurf: ['versendet', 'aufgehoben', 'zurueckgezogen'],
      versendet: ['angenommen', 'abgelehnt', 'aufgehoben', 'zurueckgezogen'],
      angenommen: [],
      // Korrektur einer falsch erfassten Entscheidung (Zusage geht nicht zurück – Übernahme ins Objekt/Rechnung)
      abgelehnt: ['aufgehoben', 'angenommen', 'versendet'],
      aufgehoben: ['abgelehnt', 'angenommen', 'versendet'],
      zurueckgezogen: [],
    };
    if (o.status === status) return;
    // Angebot mit Losen: Entscheidung für das ganze Angebot gilt für alle noch offenen Lose
    const lots = await tx<{ lot_no: number; status: LotStatus }[]>`
      select lot_no, status from app.offer_lots where offer_id = ${id} order by lot_no`;
    if (lots.length && ['angenommen', 'abgelehnt', 'aufgehoben'].includes(status)) {
      if (o.status === 'entwurf') throw new BusinessError('Angebot zuerst als versendet markieren');
      await tx`update app.offer_lots set status = ${status}, decided_at = now(), decided_by = ${actor}
                where offer_id = ${id} and status = 'offen'`;
      await recomputeLotOffer(tx, id, actor);
      return;
    }
    if (!allowed[o.status].includes(status)) {
      throw new BusinessError(
        `Status „${OFFER_STATUS[o.status]}“ kann nicht zu „${OFFER_STATUS[status]}“ wechseln`,
      );
    }
    await tx`update app.offers set status = ${status},
               decided_at = ${['angenommen', 'abgelehnt', 'aufgehoben'].includes(status) ? tx`now()` : null} where id = ${id}`;
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

/** Status des Angebots aus seinen Losen: alle entschieden → Zuschlag, wenn mindestens ein Los gewonnen, sonst
 *  aufgehoben (alle aufgehoben) bzw. Absage; sonst „versendet“ (Teilentscheidung). */
async function recomputeLotOffer(tx: Tx, id: string, actor: string) {
  const lots = await tx<{ status: LotStatus }[]>`select status from app.offer_lots where offer_id = ${id}`;
  const [o] = await tx<{ status: OfferStatus }[]>`select status from app.offers where id = ${id}`;
  if (!o || !lots.length) return;
  const open = lots.some((l) => l.status === 'offen');
  const next: OfferStatus = open
    ? 'versendet'
    : lots.some((l) => l.status === 'angenommen')
      ? 'angenommen'
      : lots.every((l) => l.status === 'aufgehoben')
        ? 'aufgehoben'
        : 'abgelehnt';
  if (next === o.status) return;
  await tx`update app.offers set status = ${next},
             decided_at = ${next === 'versendet' ? null : tx`now()`} where id = ${id}`;
  await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
           values (${actor}, 'status', 'offer', ${id}, ${tx.json({ status: next, from_lots: true })})`;
}

/** Entscheidung je Los (Zuschlag / Absage / aufgehoben / wieder offen); der Angebotsstatus folgt daraus. */
export async function setLotStatus(
  sql: Sql,
  offerId: string,
  lotNo: number,
  status: LotStatus,
  actor: string,
) {
  if (!(status in LOT_STATUS)) throw new BusinessError('Unbekannter Status');
  await sql.begin(async (tx) => {
    const [o] = await tx<
      { status: OfferStatus }[]
    >`select status from app.offers where id = ${offerId} for update`;
    if (!o) throw new BusinessError('Angebot nicht gefunden');
    if (o.status === 'entwurf') throw new BusinessError('Angebot zuerst als versendet markieren');
    if (o.status === 'zurueckgezogen') throw new BusinessError('Angebot ist zurückgezogen');
    const [lot] = await tx<{ status: LotStatus }[]>`
      select status from app.offer_lots where offer_id = ${offerId} and lot_no = ${lotNo} for update`;
    if (!lot) throw new BusinessError('Los nicht gefunden');
    if (lot.status === status) return;
    if (lot.status === 'angenommen') {
      const [taken] = await tx`select 1 from app.audit_log where entity = 'offer' and entity_id = ${offerId}
                                  and action in ('accept_into_site', 'to_invoice', 'to_order') limit 1`;
      if (taken)
        throw new BusinessError(
          'Zuschlag schon ins Objekt/in eine Rechnung übernommen – nicht mehr änderbar',
        );
    }
    await tx`update app.offer_lots set status = ${status},
               decided_at = ${status === 'offen' ? null : tx`now()`}, decided_by = ${status === 'offen' ? null : actor}
             where offer_id = ${offerId} and lot_no = ${lotNo}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'lot_status', 'offer', ${offerId}, ${tx.json({ lot: lotNo, status, before: lot.status })})`;
    await recomputeLotOffer(tx, offerId, actor);
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
      objectText: o.object_text,
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
        serviceTypeId: l.service_type_id ?? null,
        yearly: l.yearly,
        lot: l.lot_no,
      })),
      lotTitles: Object.fromEntries(data.lots.map((x) => [x.lot_no, x.title ?? ''])),
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
    for (const l of awardedLines(data.lines, data.lots)) {
      // deterministische ID: Angebot + Position → zweimal übernehmen legt nichts doppelt an
      const [{ id }] = (await tx`select md5(${offerId} || ':' || ${l.position})::uuid as id`) as unknown as [
        { id: string },
      ];
      const res = await tx`
        insert into app.site_services (id, site_id, kind, description, unit_code, quantity_milli, unit_price_cents,
                                       vat_rate_bp, valid_from, note, sort_order, service_type_id, billing_cycle)
        values (${id}, ${siteId}, ${l.recurring ? 'monthly_flat' : 'special'}, ${l.description}, ${l.unit_code},
                ${l.quantity_milli}, ${l.unit_price_cents}, ${l.vat_rate_bp}, ${validFrom},
                ${`aus Angebot ${data.offer.number}${l.lot_no ? `, Los ${l.lot_no}` : ''}`}, ${l.position},
                ${l.service_type_id ?? null},
                ${l.recurring ? 'monatlich' : l.yearly ? 'jaehrlich' : 'je_ausfuehrung'}::app.billing_cycle)
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
      lines: awardedLines(data.lines, data.lots).map((l) => ({
        description: l.description,
        detail: l.detail,
        quantity: l.quantity_milli as Quantity,
        unitCode: l.unit_code,
        unitPrice: l.unit_price_cents as Cents,
        vatRate: l.vat_rate_bp,
        serviceTypeId: l.service_type_id ?? null,
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
  return (await offerContactFull(sql, login)).name;
}

/** Ansprechpartner mit Telefon und E-Mail (Profil, sonst Mitarbeiter gleichen Namens – View manager_contacts). */
export async function offerContactFull(
  sql: Sql,
  login: string,
): Promise<{ name: string; phone: string | null; email: string | null }> {
  const [p] = await sql<{ name: string | null; phone: string | null; email: string | null }[]>`
    select p.display_name as name, mc.phone, mc.email
      from app.user_accounts a join app.profiles p on p.user_id = a.id
      left join app.manager_contacts mc on mc.user_id = a.id
     where a.login = ${login}`;
  return { name: p?.name || login, phone: p?.phone || null, email: p?.email || null };
}

/** Summen getrennt nach monatlich, jährlich und einmalig (ohne Alternativpositionen); null bei nur einer Art. */
export function offerSplitTotals(
  lines: { recurring: boolean; alternative: boolean; yearly?: boolean }[],
  toLine: (i: number) => Parameters<typeof calculateDraft>[0][number],
): { label: string; net: bigint; vat: bigint; gross: bigint }[] | null {
  const idx = lines.map((l, i) => ({ l, i })).filter((x) => !x.l.alternative);
  const groups = (
    [
      ['Monatlich', idx.filter((x) => x.l.recurring)],
      ['Jährlich', idx.filter((x) => !x.l.recurring && x.l.yearly)],
      ['Einmalig', idx.filter((x) => !x.l.recurring && !x.l.yearly)],
    ] as const
  ).filter(([, g]) => g.length);
  if (groups.length < 2) return null;
  return groups.map(([label, g]) => {
    const d = calculateDraft(g.map((x) => toLine(x.i)));
    return { label, net: d.net, vat: d.vat, gross: d.gross };
  });
}

export async function renderOfferPdf(sql: Sql, id: string): Promise<{ pdf: Uint8Array; filename: string }> {
  const data = await getOffer(sql, id);
  if (!data) throw new BusinessError('Angebot nicht gefunden');
  const { offer: o, lots } = data;
  // Lose zusammenhängend (Positionen ohne Los zuerst), sonst Reihenfolge wie erfasst
  const lines = [...data.lines].sort((a, b) => (a.lot_no ?? 0) - (b.lot_no ?? 0) || a.position - b.position);
  const seller = await getSeller(sql);
  const buyer = await buildBuyerSnapshot(sql, o.customer_id, o.site_id);
  const toLine = (l: OfferLineRow) => ({
    description: l.alternative ? `Alternativ: ${l.description}` : l.description,
    detail:
      [l.detail, lineCycle(l), l.alternative ? 'Alternativposition – nicht in der Summe enthalten' : null]
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
  const contact = await offerContactFull(sql, o.created_by);
  const split = offerSplitTotals(lines, (i) => toLine(lines[i]!));
  const info: [string, string][] = [
    ['Angebotsdatum', formatDateDe(o.offer_date)],
    ['Kundennummer', buyer.customerNo],
  ];
  if (o.valid_until) info.push(['Gültig bis', formatDateDe(o.valid_until)]);
  if (o.tender_reference) info.push(['Vergabe-Nr.', o.tender_reference]);
  const eurTxt = (c: bigint) =>
    (Number(c) / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
  const monthly =
    o.monthly_net_cents > 0n && !split
      ? ` Davon monatlich wiederkehrend: ${eurTxt(o.monthly_net_cents)} netto.`
      : '';
  // Jahreswert (Wertung): monatlich × 12 + jährlich + einmalig; bei Losen je Los
  const yearly =
    o.monthly_net_cents > 0n || lines.some((l) => l.yearly)
      ? ` Jahreswert (12 × monatlich + jährliche und einmalige Leistungen): ${eurTxt(offerYearValue(lines))} netto.`
      : '';
  const lotValues = lots.length
    ? ' ' +
      lots
        .map(
          (x) =>
            `${lotLabel(x)}: ${eurTxt(offerYearValue(lines.filter((l) => l.lot_no === x.lot_no)))} netto/Jahr`,
        )
        .join('; ') +
      '. Die Lose können einzeln vergeben werden.'
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
      : o.object_text
        ? { subject: `Objekt: ${o.object_text.replace(/\s*\n\s*/g, ', ')}` }
        : {}),
    info,
    terms:
      (o.valid_until
        ? `Dieses Angebot ist gültig bis zum ${formatDateDe(o.valid_until)}.`
        : 'Dieses Angebot ist 30 Tage gültig.') +
      monthly +
      yearly +
      lotValues +
      ' Es gelten unsere Allgemeinen Geschäftsbedingungen.',
    // Ansprechpartner als Karte, darunter Feld „Auftragserteilung“ (Gestaltung „edel“)
    ...(contact.name ? { contact: { name: contact.name, phone: contact.phone, email: contact.email } } : {}),
    acceptance: true,
    ...(o.valid_until ? { validUntil: formatDateDe(o.valid_until) } : {}),
    closing: o.closing_text ?? OFFER_CLOSING_DEFAULT,
    qr: false,
    ...(split ? { totalsSplit: split } : {}),
    ...(lots.length
      ? {
          lineGroups: lines.map((l) => {
            const lot = lots.find((x) => x.lot_no === l.lot_no);
            return lot ? lotLabel(lot) : null;
          }),
        }
      : {}),
    // Angebot wie Fortytools: Pauschalen mit Einheit „psch.“ (ausgeschrieben überlappte es lange Preise)
    units: { LS: 'psch.', MON: 'Monat' },
  });
  return { pdf, filename: `Angebot_${o.number}.pdf` };
}

type StatGroup = { count: number; net: bigint; monthly: bigint; year: bigint };
export interface OfferStats {
  open: StatGroup;
  accepted: StatGroup;
  rejected: StatGroup;
  withdrawn: number;
  /** aufgehobene Vergaben – nicht in der Zuschlagsquote */
  cancelled: StatGroup;
  /** Zuschlagsquote = angenommen ÷ (angenommen + abgelehnt), in Prozent; null ohne Entscheidungen */
  rate: number | null;
  /** Zuschlagsquote nach Jahreswert (monatlich × 12 + jährlich + einmalig): angenommen ÷ entschieden */
  rateValue: number | null;
}

/** Zeiträume der Angebots-Statistik (Ahmed: „Annahmen diesen Monat“). */
export const OFFER_PERIODS = {
  monat: 'Dieser Monat',
  vormonat: 'Letzter Monat',
  quartal: 'Dieses Quartal',
  jahr: 'Dieses Jahr',
  '12m': 'Letzte 12 Monate',
} as const;
export type OfferPeriod = keyof typeof OFFER_PERIODS;

export function offerPeriodRange(p: OfferPeriod, today: string): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const first = (yy: number, mm: number) => {
    const d = new Date(Date.UTC(yy, mm - 1, 1));
    return d.toISOString().slice(0, 10);
  };
  switch (p) {
    case 'monat':
      return { from: first(y, m), to: today };
    case 'vormonat':
      return { from: first(y, m - 1), to: addDays(first(y, m), -1) };
    case 'quartal':
      return { from: first(y, Math.floor((m - 1) / 3) * 3 + 1), to: today };
    case 'jahr':
      return { from: `${y}-01-01`, to: today };
    default:
      return { from: first(y, m - 11), to: today };
  }
}

/**
 * Angebots-Statistik eines Zeitraums – wie Fortytools. Offene nach Angebotsdatum, angenommene/abgelehnte nach dem
 * Tag der Entscheidung („diesen Monat angenommen“), ohne Entscheidungstag nach Angebotsdatum.
 */
export async function offerStats(
  sql: Sql,
  range: { from: string; to: string } = offerPeriodRange('12m', todayBerlin()),
): Promise<OfferStats> {
  // Zähleinheit = Angebot bzw. jedes Los einzeln (Ahmed 26.10.: Lose werden einzeln vergeben)
  const rows = await sql<{ g: string; count: number; net: bigint; monthly: bigint; year: bigint }[]>`
    with u as (
      select o.id, l.lot_no,
             coalesce(case when lo.status = 'offen' then null else lo.status end, o.status::text) as status,
             coalesce(lo.decided_at, o.decided_at) as decided_at, o.offer_date,
             coalesce(sum(l.net_cents), 0)::bigint as net,
             coalesce(sum(l.net_cents) filter (where l.recurring), 0)::bigint as monthly
        from app.offers o
        join app.offer_lines l on l.offer_id = o.id and not l.alternative
        left join app.offer_lots lo on lo.offer_id = o.id and lo.lot_no = l.lot_no
       group by o.id, l.lot_no, lo.status, lo.decided_at, o.status, o.decided_at, o.offer_date)
    select g, count(*)::int as count, coalesce(sum(net), 0)::bigint as net,
           coalesce(sum(monthly), 0)::bigint as monthly,
           coalesce(sum(net + 11 * monthly), 0)::bigint as year
      from (select case when status in ('entwurf', 'versendet') then 'open' when status = 'angenommen' then 'accepted'
                        when status = 'abgelehnt' then 'rejected' when status = 'aufgehoben' then 'cancelled'
                        else 'withdrawn' end as g,
                   case when status in ('angenommen', 'abgelehnt', 'aufgehoben')
                        then coalesce((decided_at at time zone 'Europe/Berlin')::date, offer_date) else offer_date end as d,
                   net, monthly
              from u) x
     where d between ${range.from}::date and ${range.to}::date
     group by 1`;
  const get = (g: string): StatGroup => {
    const r = rows.find((x) => x.g === g);
    return { count: r?.count ?? 0, net: r?.net ?? 0n, monthly: r?.monthly ?? 0n, year: r?.year ?? 0n };
  };
  const accepted = get('accepted');
  const rejected = get('rejected');
  const decided = accepted.count + rejected.count;
  const tot = accepted.year + rejected.year;
  return {
    open: get('open'),
    accepted,
    rejected,
    withdrawn: get('withdrawn').count,
    cancelled: get('cancelled'),
    rate: decided ? Math.round((accepted.count * 100) / decided) : null,
    rateValue: tot > 0n ? Number((accepted.year * 1000n) / tot) / 10 : null,
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
