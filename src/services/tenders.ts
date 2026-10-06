import { createHash } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { assertVersion } from './crm.js';
import { BusinessError } from './errors.js';

/*
 * Ausschreibungen: Termine und Stand einer Vergabe (Abgabefrist, Bieterfragen, Ortsbesichtigung, Bindefrist), bevor es
 * Preise gibt. Das Angebot entsteht später daraus (Verknüpfung offer_id). Zeiten werden als Berliner Ortszeit erfasst.
 */

export type TenderStatus =
  'neu' | 'pruefen' | 'bearbeitung' | 'abgegeben' | 'gewonnen' | 'verloren' | 'verzichtet' | 'aufgehoben';
export const TENDER_STATUS: Record<TenderStatus, string> = {
  neu: 'neu',
  pruefen: 'wird geprüft',
  bearbeitung: 'in Bearbeitung',
  abgegeben: 'abgegeben',
  gewonnen: 'gewonnen',
  verloren: 'verloren',
  verzichtet: 'nicht teilgenommen',
  aufgehoben: 'aufgehoben',
};
export const ACTIVE: TenderStatus[] = ['neu', 'pruefen', 'bearbeitung', 'abgegeben'];
export const PROCEDURES = [
  'offenes Verfahren',
  'nicht offenes Verfahren',
  'Verhandlungsverfahren',
  'öffentliche Ausschreibung (UVgO)',
  'beschränkte Ausschreibung',
  'Verhandlungsvergabe / freihändig',
  'Preisanfrage (privat)',
];
export const PLATFORMS = [
  'DTVP',
  'Vergabe.bayern',
  'eVergabe-online',
  'Subreport',
  'Vergabemarktplatz München',
  'service.bund.de',
  'E-Mail / Post',
];

export interface Tender {
  id: string;
  title: string;
  authority: string;
  customer_id: string | null;
  reference_no: string | null;
  platform: string | null;
  url: string | null;
  procedure: string | null;
  location: string | null;
  services: string | null;
  contract_start: string | null;
  contract_term: string | null;
  estimated_cents: bigint | null;
  deadline_at: Date | null;
  questions_until: Date | null;
  site_visit_at: Date | null;
  site_visit_required: boolean;
  binding_until: string | null;
  status: TenderStatus;
  responsible: string | null;
  decision_note: string | null;
  offer_id: string | null;
  submitted_at: Date | null;
  notes: string | null;
  created_by: string;
  created_at: Date;
  version: number;
}
export type TenderRow = Tender & {
  customer_name: string | null;
  offer_number: string | null;
  days_left: number | null;
};

const SELECT = (sql: Sql) => sql`
  select t.*, c.name as customer_name, o.number as offer_number,
         case when t.deadline_at is null then null
              else (t.deadline_at at time zone 'Europe/Berlin')::date - (now() at time zone 'Europe/Berlin')::date end::int as days_left
    from app.tenders t
    left join app.customers c on c.id = t.customer_id
    left join app.offers o on o.id = t.offer_id`;

export async function listTenders(
  sql: Sql,
  f: { view: 'aktiv' | 'abgeschlossen' | 'alle'; q?: string | null },
) {
  const q = f.q?.trim() ? `%${f.q.trim()}%` : null;
  return sql<TenderRow[]>`
    ${SELECT(sql)}
     where (${f.view === 'alle'} or (${f.view === 'aktiv'} = (t.status = any(${ACTIVE}::text[]))))
       and (${q}::text is null or t.title ilike ${q} or t.authority ilike ${q} or coalesce(t.reference_no, '') ilike ${q})
     order by (t.status = any(${ACTIVE}::text[])) desc, t.deadline_at nulls last, t.created_at desc`;
}

export async function getTender(sql: Sql, id: string) {
  const [t] = await sql<TenderRow[]>`${SELECT(sql)} where t.id = ${id}`;
  return t;
}

export interface TenderInput {
  title: string;
  authority: string;
  customerId: string | null;
  referenceNo: string | null;
  platform: string | null;
  url: string | null;
  procedure: string | null;
  location: string | null;
  services: string | null;
  contractStart: string | null;
  contractTerm: string | null;
  estimatedCents: bigint | null;
  deadline: string | null; // 'YYYY-MM-DDTHH:mm' Berliner Ortszeit
  questionsUntil: string | null;
  siteVisit: string | null;
  siteVisitRequired: boolean;
  bindingUntil: string | null;
  responsible: string | null;
  notes: string | null;
  version?: number | null;
}

const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Feste ID der Aufgabe „Abgabefrist“ einer Ausschreibung. */
export function tenderTaskId(id: string): string {
  const h = createHash('md5').update(`tender-task:${id}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Aufgabe „Abgabefrist“ mitführen: offen, solange die Ausschreibung vorbereitet wird und eine Frist hat (Fälligkeit =
 * Abgabetag); erledigt, sobald abgegeben/entschieden oder ohne Frist.
 */
async function syncTenderTask(tx: Sql, id: string, actor: string) {
  const taskId = tenderTaskId(id);
  const [t] = await tx<
    { title: string; authority: string; status: TenderStatus; due: string | null; at: string | null }[]
  >`
    select title, authority, status, (deadline_at at time zone 'Europe/Berlin')::date::text as due,
           to_char(deadline_at at time zone 'Europe/Berlin', 'DD.MM.YYYY HH24:MI') as at
      from app.tenders where id = ${id}`;
  if (!t) return;
  const open = !!t.due && ['neu', 'pruefen', 'bearbeitung'].includes(t.status);
  if (open) {
    await tx`
      insert into app.tasks (id, title, description, due_date, status, entity_type, entity_id, created_by)
      values (${taskId}, ${`Abgabefrist Ausschreibung: ${t.title}`}, ${`${t.authority} – Abgabe bis ${t.at} Uhr`},
              ${t.due}, 'open', 'tender', ${id}, ${actor})
      on conflict (id) do update set title = excluded.title, description = excluded.description,
                                     due_date = excluded.due_date, status = 'open', done_at = null, done_by = null`;
  } else {
    await tx`update app.tasks set status = 'done', done_at = now(), done_by = ${actor}
              where id = ${taskId} and status = 'open'`;
  }
}

export async function saveTender(sql: Sql, id: string, p: TenderInput, actor: string) {
  if (!p.title.trim()) throw new BusinessError('Bitte Titel angeben');
  if (!p.authority.trim()) throw new BusinessError('Bitte Vergabestelle / Auftraggeber angeben');
  for (const [v, label] of [
    [p.deadline, 'Abgabefrist'],
    [p.questionsUntil, 'Bieterfragen bis'],
    [p.siteVisit, 'Ortsbesichtigung'],
  ] as const)
    if (v && !LOCAL.test(v)) throw new BusinessError(`${label}: bitte Datum und Uhrzeit angeben`);
  for (const [v, label] of [
    [p.contractStart, 'Vertragsbeginn'],
    [p.bindingUntil, 'Bindefrist'],
  ] as const)
    if (v && !DATE.test(v)) throw new BusinessError(`${label} ungültig`);
  if (p.url && !/^https?:\/\/\S+$/.test(p.url)) throw new BusinessError('Link bitte mit https:// angeben');
  if (p.questionsUntil && p.deadline && p.questionsUntil > p.deadline)
    throw new BusinessError('Bieterfragen müssen vor der Abgabefrist liegen');
  await sql.begin(async (tx) => {
    const [cur] = await tx<Tender[]>`select * from app.tenders where id = ${id} for update`;
    assertVersion(cur?.version, p.version, 'Die Ausschreibung');
    const berlin = (v: string | null) => (v ? tx`(${v}::timestamp at time zone 'Europe/Berlin')` : tx`null`);
    const row = {
      title: p.title.trim(),
      authority: p.authority.trim(),
      customer_id: p.customerId,
      reference_no: p.referenceNo?.trim() || null,
      platform: p.platform?.trim() || null,
      url: p.url?.trim() || null,
      procedure: p.procedure?.trim() || null,
      location: p.location?.trim() || null,
      services: p.services?.trim() || null,
      contract_start: p.contractStart,
      contract_term: p.contractTerm?.trim() || null,
      estimated_cents: p.estimatedCents,
      site_visit_required: p.siteVisitRequired,
      binding_until: p.bindingUntil,
      responsible: p.responsible?.trim() || null,
      notes: p.notes?.trim() || null,
    };
    if (cur) await tx`update app.tenders set ${tx(row)} where id = ${id}`;
    else await tx`insert into app.tenders ${tx({ id, created_by: actor, ...row })}`;
    await tx`update app.tenders set deadline_at = ${berlin(p.deadline)}, questions_until = ${berlin(p.questionsUntil)},
                    site_visit_at = ${berlin(p.siteVisit)} where id = ${id}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id)
             values (${actor}, ${cur ? 'update' : 'create'}, 'tender', ${id})`;
    await syncTenderTask(tx as unknown as Sql, id, actor);
  });
}

export async function setTenderStatus(
  sql: Sql,
  id: string,
  status: TenderStatus,
  note: string | null,
  actor: string,
) {
  if (!(status in TENDER_STATUS)) throw new BusinessError('Unbekannter Status');
  const t = await getTender(sql, id);
  if (!t) throw new BusinessError('Ausschreibung nicht gefunden');
  if (['verzichtet', 'verloren'].includes(status) && !note?.trim())
    throw new BusinessError('Bitte kurz den Grund notieren (hilft bei der nächsten Ausschreibung)');
  await sql`
    update app.tenders set status = ${status},
           submitted_at = case when ${status} = 'abgegeben' then coalesce(submitted_at, now()) else submitted_at end,
           decision_note = coalesce(${note?.trim() || null}, decision_note)
     where id = ${id}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'status', 'tender', ${id}, ${sql.json({ status, note: note ?? null })})`;
  await syncTenderTask(sql, id, actor);
}

/** Angebot zur Ausschreibung starten: braucht einen Kunden/Interessenten; vorhandenes Angebot wird wiederverwendet. */
export async function offerTarget(
  sql: Sql,
  id: string,
): Promise<{ customerId: string; offerId: string | null }> {
  const t = await getTender(sql, id);
  if (!t) throw new BusinessError('Ausschreibung nicht gefunden');
  if (!t.customer_id)
    throw new BusinessError(
      'Bitte zuerst den Auftraggeber als Kunde oder Interessent zuordnen (Feld „Kunde“).',
    );
  return { customerId: t.customer_id, offerId: t.offer_id };
}

/** Nach dem Speichern eines Angebots mit Bezug: Verknüpfung setzen (einmalig). */
export async function linkOffer(sql: Sql, tenderId: string, offerId: string) {
  await sql`update app.tenders set offer_id = ${offerId},
                  status = case when status in ('neu', 'pruefen') then 'bearbeitung' else status end
             where id = ${tenderId} and offer_id is null
               and exists (select 1 from app.offers where id = ${offerId})`;
}

export interface TenderEvent {
  tender_id: string;
  title: string;
  authority: string;
  kind: 'Abgabe' | 'Bieterfragen' | 'Ortsbesichtigung';
  at: Date;
  days: number;
  required: boolean;
}

/** Nächste Termine aktiver Ausschreibungen (für Startseite und Liste). */
export async function upcomingEvents(sql: Sql, days = 14) {
  return sql<TenderEvent[]>`
    with ev as (
      select id, title, authority, 'Abgabe' as kind, deadline_at as at, true as required from app.tenders
       where status = any(${['neu', 'pruefen', 'bearbeitung']}::text[]) and deadline_at is not null
      union all
      select id, title, authority, 'Bieterfragen', questions_until, false from app.tenders
       where status = any(${['neu', 'pruefen', 'bearbeitung']}::text[]) and questions_until is not null
      union all
      select id, title, authority, 'Ortsbesichtigung', site_visit_at, site_visit_required from app.tenders
       where status = any(${['neu', 'pruefen', 'bearbeitung']}::text[]) and site_visit_at is not null
    )
    select id as tender_id, title, authority, kind, at,
           ((at at time zone 'Europe/Berlin')::date - (now() at time zone 'Europe/Berlin')::date)::int as days, required
      from ev
     where at >= now() - interval '1 hour' and (at at time zone 'Europe/Berlin')::date <= (now() at time zone 'Europe/Berlin')::date + ${days}::int
     order by at`;
}
