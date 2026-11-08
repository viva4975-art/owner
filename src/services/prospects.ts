import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import { BusinessError } from './errors.js';
import { uuidOf } from './fortytools-export-import.js';

/*
 * Akquise (wie die alte App): Pipeline mit Status, Wiedervorlage und Aktivitäten.
 * Fällig = Wiedervorlage heute oder früher (Berliner Datum), abgeschlossene Status zählen nicht.
 */

export const PROSPECT_STATUS = {
  erstkontakt: { label: 'Erstkontakt', tone: 'info' },
  interesse_stark: { label: 'Starkes Interesse', tone: 'ok' },
  interesse_leicht: { label: 'Leichtes Interesse', tone: 'warn' },
  kein_interesse: { label: 'Kein Interesse', tone: '' },
  gewonnen: { label: 'Gewonnen', tone: 'ok' },
  verloren: { label: 'Verloren', tone: 'err' },
} as const;
export type ProspectStatus = keyof typeof PROSPECT_STATUS;
export const CLOSED: ProspectStatus[] = ['gewonnen', 'verloren', 'kein_interesse'];

export const ACTIVITY_KIND = {
  call_out: 'Anruf (raus)',
  call_in: 'Anruf (rein)',
  email: 'E-Mail',
  termin: 'Termin',
  angebot: 'Angebot',
  notiz: 'Notiz',
} as const;
export type ActivityKind = keyof typeof ACTIVITY_KIND;

export interface Prospect {
  id: string;
  company: string;
  contact: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  source: string | null;
  object: string | null;
  status: ProspectStatus;
  followup_on: string | null;
  followup_reason: string | null;
  created_at: Date;
  version: number;
  activity_count: number;
  /** Aktivitäten ohne die aus dem Import übernommenen Notizen */
  contact_count: number;
  last_kind: ActivityKind | null;
  last_at: Date | null;
  last_note: string | null;
}

export interface Activity {
  id: string;
  kind: ActivityKind;
  at: Date;
  note: string | null;
  created_by: string;
}

export const isClosed = (s: ProspectStatus) => CLOSED.includes(s);
export const dueState = (p: Pick<Prospect, 'followup_on' | 'status'>, today = todayBerlin()) =>
  !p.followup_on || isClosed(p.status)
    ? null
    : p.followup_on < today
      ? 'overdue'
      : p.followup_on === today
        ? 'today'
        : null;

/** Kennzeichen am Ersteller von Notizen, die der Import anlegt. */
export const IMPORT_ACTOR = ' (Import)';

export async function listProspects(sql: Sql): Promise<Prospect[]> {
  return sql<Prospect[]>`
    select p.*, coalesce(a.n, 0)::int as activity_count, coalesce(a.contacts, 0)::int as contact_count,
           l.kind as last_kind, l.at as last_at, l.note as last_note
      from app.prospects p
      left join (select prospect_id, count(*) as n,
                        -- Notizen aus dem Import zählen nicht als Kontakt („ohne Aktivität“)
                        count(*) filter (where created_by not like ${'%' + IMPORT_ACTOR}) as contacts
                   from app.prospect_activities group by prospect_id) a
             on a.prospect_id = p.id
      left join lateral (select kind, at, note from app.prospect_activities x
                          where x.prospect_id = p.id order by at desc, created_at desc limit 1) l on true
     order by coalesce(p.followup_on, '9999-12-31'), p.created_at desc`;
}

export async function getProspect(sql: Sql, id: string) {
  const [p] = await sql<
    Prospect[]
  >`select *, 0 as activity_count, 0 as contact_count from app.prospects where id = ${id}`;
  if (!p) return undefined;
  const acts = await sql<Activity[]>`
    select id, kind, at, note, created_by from app.prospect_activities
     where prospect_id = ${id} order by at desc, created_at desc`;
  return { p, acts };
}

export interface ProspectInput {
  company: string;
  contact: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  source: string | null;
  object: string | null;
  status: string;
  followupOn: string | null;
  followupReason: string | null;
  expectedVersion: number | null;
}

const clean = (s: string | null) => (s?.trim() ? s.trim() : null);

export async function saveProspect(sql: Sql, id: string, p: ProspectInput, actor: string) {
  if (!p.company.trim()) throw new BusinessError('Firma erforderlich!');
  if (!(p.status in PROSPECT_STATUS)) throw new BusinessError('Status ungültig');
  if (p.followupOn && !/^\d{4}-\d{2}-\d{2}$/.test(p.followupOn))
    throw new BusinessError('Wiedervorlage ungültig');
  const row = {
    company: p.company.trim(),
    contact: clean(p.contact),
    phone: clean(p.phone),
    email: clean(p.email),
    city: clean(p.city),
    source: clean(p.source),
    object: clean(p.object),
    status: p.status,
    followup_on: p.followupOn || null,
    followup_reason: clean(p.followupReason),
  };
  const [cur] = await sql<
    { version: number; status: string }[]
  >`select version, status from app.prospects where id = ${id}`;
  if (cur) {
    if (p.expectedVersion != null && cur.version !== p.expectedVersion)
      throw new BusinessError('Der Eintrag wurde zwischenzeitlich geändert – bitte neu laden');
    await sql`update app.prospects set ${sql({ ...row, updated_at: new Date() })} where id = ${id}`;
  } else {
    await sql`insert into app.prospects ${sql({ id, ...row, created_by: actor })} on conflict (id) do nothing`;
  }
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, ${cur ? 'update' : 'create'}, 'prospect', ${id},
                    ${sql.json({ firma: row.company, status: PROSPECT_STATUS[p.status as ProspectStatus].label })})`;
}

export async function deleteProspect(sql: Sql, id: string, actor: string) {
  const [p] = await sql<{ company: string }[]>`delete from app.prospects where id = ${id} returning company`;
  if (p)
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${actor}, 'delete', 'prospect', ${id}, ${sql.json({ firma: p.company })})`;
}

/** Aktivität erfassen; optional Status und Wiedervorlage gleich mit ändern (wie alte App). Feste ID → nichts doppelt. */
export async function addActivity(
  sql: Sql,
  prospectId: string,
  a: {
    id: string;
    kind: string;
    at: string;
    note: string | null;
    newStatus: string | null;
    followupOn: string | null;
  },
  actor: string,
) {
  if (!(a.kind in ACTIVITY_KIND)) throw new BusinessError('Typ ungültig');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(a.at)) throw new BusinessError('Datum / Zeit ungültig');
  if (a.newStatus && !(a.newStatus in PROSPECT_STATUS)) throw new BusinessError('Status ungültig');
  await sql.begin(async (tx) => {
    const [p] = await tx`select 1 from app.prospects where id = ${prospectId} for update`;
    if (!p) throw new BusinessError('Eintrag nicht gefunden');
    const r = await tx`
      insert into app.prospect_activities (id, prospect_id, kind, at, note, created_by)
      values (${a.id}, ${prospectId}, ${a.kind}, (${a.at}::timestamp at time zone 'Europe/Berlin'), ${clean(a.note)}, ${actor})
      on conflict (id) do nothing`;
    if (!r.count) return;
    if (a.newStatus || a.followupOn)
      await tx`update app.prospects set
                 status = coalesce(${a.newStatus}, status),
                 followup_on = coalesce(${a.followupOn}::date, followup_on),
                 updated_at = now()
               where id = ${prospectId}`;
  });
}

export async function deleteActivity(sql: Sql, prospectId: string, activityId: string) {
  await sql`delete from app.prospect_activities where id = ${activityId} and prospect_id = ${prospectId}`;
}

/** Wiedervorlagen für die Startseite: fällig (≤ heute) und diese Woche. */
export async function followups(sql: Sql, today = todayBerlin()) {
  const rows = await sql<{ id: string; company: string; followup_on: string }[]>`
    select id, company, followup_on::text from app.prospects
     where followup_on is not null and followup_on <= ${addDays(today, 7)}
       and status not in ('gewonnen', 'verloren', 'kein_interesse')
     order by followup_on, company`;
  return { due: rows.filter((r) => r.followup_on <= today), week: rows.filter((r) => r.followup_on > today) };
}

// ------------------------------------------------------------------ Import alte App

const LEGACY_STATUS: Record<string, ProspectStatus> = {
  warm: 'interesse_leicht',
  verhandlung: 'interesse_stark',
  pause: 'kein_interesse',
};

export function legacyStatus(s: unknown): ProspectStatus {
  const v = String(s ?? '');
  if (v in PROSPECT_STATUS) return v as ProspectStatus;
  return LEGACY_STATUS[v] ?? 'erstkontakt'; // wie alte App: leer/unbekannt (z. B. „kalt“) → Erstkontakt
}

export async function importLegacyProspects(sql: Sql, rows: Record<string, unknown>[], actor: string) {
  let n = 0;
  let acts = 0;
  const t = (v: unknown) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, 500));
  for (const r of rows) {
    const legacyId = `akq:${String(r.id)}`;
    const id = uuidOf(legacyId);
    const company = t(r.firma) ?? '(ohne Firma)';
    const fu =
      typeof r.wiedervorlage === 'string' && /^\d{4}-\d{2}-\d{2}/.test(r.wiedervorlage)
        ? r.wiedervorlage.slice(0, 10)
        : null;
    const res = await sql`
      insert into app.prospects ${sql({
        id,
        company,
        contact: t(r.ansprechpartner),
        phone: t(r.telefon),
        email: t(r.email),
        city: t(r.ort),
        source: t(r.quelle),
        object: t(r.objekt),
        status: legacyStatus(r.status),
        followup_on: fu,
        followup_reason: t(r.wiedervorlage_grund),
        legacy_id: legacyId,
        created_by: actor,
        created_at: r.created_at ? new Date(String(r.created_at)) : new Date(),
      } as Record<string, unknown>)} on conflict (legacy_id) do nothing`;
    n += res.count;
    for (const a of (Array.isArray(r.activities) ? r.activities : []) as Record<string, unknown>[]) {
      const kind = String(a.typ ?? 'notiz') in ACTIVITY_KIND ? String(a.typ) : 'notiz';
      const at =
        typeof a.datum === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(a.datum)
          ? a.datum.slice(0, 16)
          : null;
      const aid = `akqa:${String(r.id)}:${String(a.id ?? randomUUID())}`;
      const x = await sql`
        insert into app.prospect_activities (id, prospect_id, kind, at, note, legacy_id, created_by)
        values (${uuidOf(aid)}, ${id}, ${kind},
                ${at ? sql`(${at}::timestamp at time zone 'Europe/Berlin')` : sql`now()`},
                ${t(a.notiz)}, ${aid}, ${actor})
        on conflict (legacy_id) do nothing`;
      acts += x.count;
    }
  }
  return { n, acts };
}

// ---------------------------------------------------------------------------
// Import (Ahmed 08.11.): CSV/Excel – auch die eigene Export-Datei. Spalten über die Kopfzeile, feste IDs aus
// Firma + Ort → erneut importieren legt nichts doppelt an; vorhandene nur mit „aktualisieren“.
// ---------------------------------------------------------------------------

type ImportField =
  | 'company'
  | 'contact'
  | 'phone'
  | 'email'
  | 'city'
  | 'object'
  | 'source'
  | 'status'
  | 'followup'
  | 'reason'
  | 'note';

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');

/** Kopfzeilen-Namen → Feld (genaue Treffer nach Normalisierung). */
const HEADERS: Record<string, ImportField> = {
  firma: 'company',
  firmenname: 'company',
  unternehmen: 'company',
  kunde: 'company',
  name: 'company',
  ansprechpartner: 'contact',
  kontakt: 'contact',
  kontaktperson: 'contact',
  telefon: 'phone',
  tel: 'phone',
  telefonnummer: 'phone',
  handy: 'phone',
  mobil: 'phone',
  email: 'email',
  mail: 'email',
  ort: 'city',
  stadt: 'city',
  plzort: 'city',
  objekt: 'object',
  quelle: 'source',
  status: 'status',
  wiedervorlage: 'followup',
  wiedervorlageam: 'followup',
  grundwiedervorlage: 'reason',
  wiedervorlagegrund: 'reason',
  notiz: 'note',
  bemerkung: 'note',
  letztenotiz: 'note',
  kommentar: 'note',
};

/** Spalten aus unserem eigenen Export, die beim Import bewusst nicht übernommen werden. */
const EXPORT_ONLY = new Set(['aktivitaten', 'letzteaktivitat', 'letzteaktivitatam', 'angelegtam']);

/** Status aus Text („Starkes Interesse“, „interesse_stark“, „kalt“ …). Unbekannt/leer → Erstkontakt. */
export function statusFromText(t: string): ProspectStatus | null {
  const n = norm(t);
  if (!n || n === 'kalt' || n === 'neu') return 'erstkontakt';
  for (const [k, v] of Object.entries(PROSPECT_STATUS))
    if (norm(k) === n || norm(v.label) === n) return k as ProspectStatus;
  return null;
}

/** Datum TT.MM.JJJJ, JJJJ-MM-TT oder Excel-Seriennummer → JJJJ-MM-TT; leer → null; ungültig → undefined. */
export function dateFromText(t: string): string | null | undefined {
  const s = t.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/.exec(s);
  if (m) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return `${y}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return undefined;
}

export interface ProspectImportResult {
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; text: string }[];
  unknownColumns: string[];
}

export async function importProspects(
  sql: Sql,
  rows: string[][],
  opts: { update: boolean },
  actor: string,
): Promise<ProspectImportResult> {
  const hi = rows.findIndex((r) => r.some((c) => HEADERS[norm(c)] === 'company'));
  if (hi < 0) throw new BusinessError('Keine Kopfzeile mit „Firma“ gefunden');
  const head = rows[hi]!;
  const col = new Map<ImportField, number>();
  const unknown: string[] = [];
  head.forEach((h, i) => {
    const f = HEADERS[norm(h)];
    if (f && !col.has(f)) col.set(f, i);
    else if (h.trim() && !f && !EXPORT_ONLY.has(norm(h))) unknown.push(h.trim());
  });
  const get = (r: string[], f: ImportField) => {
    const i = col.get(f);
    return i == null ? '' : (r[i] ?? '').trim();
  };
  const res: ProspectImportResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    unknownColumns: unknown,
  };
  const seen = new Set<string>();
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.every((c) => !c.trim())) continue;
    const line = i + 1;
    const company = get(r, 'company');
    if (!company) {
      res.errors.push({ row: line, text: 'Firma fehlt' });
      continue;
    }
    const statusText = get(r, 'status');
    const status = statusFromText(statusText);
    if (!status) {
      res.errors.push({ row: line, text: `Status „${statusText}“ unbekannt` });
      continue;
    }
    const followupOn = dateFromText(get(r, 'followup'));
    if (followupOn === undefined) {
      res.errors.push({ row: line, text: `Wiedervorlage „${get(r, 'followup')}“ ist kein Datum` });
      continue;
    }
    const city = get(r, 'city');
    const key = `${company.toLowerCase()}|${city.toLowerCase()}`;
    if (seen.has(key)) {
      res.skipped++;
      continue;
    }
    seen.add(key);
    const [ex] = await sql<{ id: string; version: number }[]>`
      select id, version from app.prospects
       where lower(company) = lower(${company}) and lower(coalesce(city, '')) = lower(${city}) limit 1`;
    if (ex && !opts.update) {
      res.skipped++;
      continue;
    }
    const id = ex?.id ?? uuidOf(`akquise-import:${key}`);
    // Aktualisieren: leere Zellen überschreiben nichts (Spalte fehlt oder Feld leer → bisheriger Wert bleibt)
    const [old] = ex
      ? await sql<Record<string, string | null>[]>`
          select contact, phone, email, source, object, status, followup_on::text as followup_on, followup_reason
            from app.prospects where id = ${ex.id}`
      : [];
    const keep = (f: ImportField, o: string | null | undefined) => get(r, f) || o || null;
    const input: ProspectInput = {
      company,
      contact: keep('contact', old?.contact),
      phone: keep('phone', old?.phone),
      email: keep('email', old?.email),
      city: city || null,
      source: keep('source', old?.source) ?? 'Import',
      object: keep('object', old?.object),
      status: statusText || !old ? status : (old.status as string),
      followupOn: followupOn ?? old?.followup_on ?? null,
      followupReason: keep('reason', old?.followup_reason),
      expectedVersion: null,
    };
    try {
      await saveProspect(sql, id, input, actor);
      const note = get(r, 'note');
      if (note && !ex)
        await addActivity(
          sql,
          id,
          {
            id: uuidOf(`akquise-import:${key}:notiz`),
            kind: 'notiz',
            at: new Date()
              .toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' })
              .slice(0, 16)
              .replace(' ', 'T'),
            note: `Import: ${note}`,
            newStatus: null,
            followupOn: null,
          },
          `${actor}${IMPORT_ACTOR}`,
        );
      if (ex) res.updated++;
      else res.created++;
    } catch (e) {
      res.errors.push({ row: line, text: e instanceof Error ? e.message : String(e) });
    }
  }
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'import', 'prospect', null,
                    ${sql.json({ neu: res.created, aktualisiert: res.updated, uebersprungen: res.skipped, fehler: res.errors.length })})`;
  return res;
}
