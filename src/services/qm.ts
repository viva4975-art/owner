import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from './errors.js';
import { nextYearNumber } from './purchasing.js';

/*
 * QM-App (Audit) wie Fortytools: Einsatzorte nach Kunde, Objekt-Details mit Raumbuch, Tickets und vergangenen Audits.
 * Audits = Qualitätskontrollen (`quality_checks`); Tickets = Meldungen je Objekt (Mangel, Wunsch, Schaden).
 * `siteIds` = Sichtbereich (Objektleitung: nur eigene Objekte; null = alle).
 */

export interface QmSite {
  id: string;
  site_no: string;
  name: string;
  street: string | null;
  postal_code: string | null;
  city: string | null;
  customer_id: string;
  customer_no: string;
  customer_name: string;
  rooms: number;
  open_tickets: number;
}

const scope = (sql: Sql, siteIds: string[] | null, col = 's.id') =>
  siteIds ? (siteIds.length ? sql`${sql.unsafe(col)} in ${sql(siteIds)}` : sql`false`) : sql`true`;

export async function qmSites(sql: Sql, siteIds: string[] | null, q = '') {
  const like = `%${q.trim()}%`;
  return sql<QmSite[]>`
    select s.id, s.site_no, s.name, s.street, s.postal_code, s.city, c.id as customer_id, c.customer_no,
           c.name as customer_name,
           (select count(*)::int from app.rooms r where r.site_id = s.id and r.active) as rooms,
           (select count(*)::int from app.site_tickets t where t.site_id = s.id and t.status <> 'erledigt') as open_tickets
      from app.sites s join app.customers c on c.id = s.customer_id
     where s.active and ${scope(sql, siteIds)}
       and ${q.trim() ? sql`(s.name || ' ' || s.site_no || ' ' || c.name || ' ' || c.customer_no || ' ' || coalesce(s.street, '') || ' ' || coalesce(s.city, '')) ilike ${like}` : sql`true`}
     order by c.customer_no, s.site_no`;
}

export interface QmAudit {
  id: string;
  number: string;
  check_date: string;
  status: string;
  score_percent: number | null;
  items: number;
  rated: number;
  site_id: string;
  site_name: string;
  inspector: string;
}

export async function qmAudits(sql: Sql, f: { siteId?: string; siteIds: string[] | null; date?: string }) {
  return sql<QmAudit[]>`
    select q.id, q.number, q.check_date::text, q.status::text, q.score_percent, q.site_id, s.name as site_name, q.inspector,
           (select count(*)::int from app.quality_check_items i where i.check_id = q.id) as items,
           (select count(*)::int from app.quality_check_items i where i.check_id = q.id and i.rating <> 'nicht_geprueft') as rated
      from app.quality_checks q join app.sites s on s.id = q.site_id
     where ${scope(sql, f.siteIds)}
       and ${f.siteId ? sql`q.site_id = ${f.siteId}` : sql`true`}
       and ${f.date ? sql`q.check_date = ${f.date}` : sql`true`}
     order by q.check_date desc, q.number desc`;
}

export const TICKET_STATUS: Record<string, string> = {
  offen: 'offen',
  in_arbeit: 'in Arbeit',
  erledigt: 'erledigt',
};
export const TICKET_PRIO: Record<string, string> = { niedrig: 'niedrig', normal: 'normal', hoch: 'hoch' };

export interface Ticket {
  id: string;
  number: string;
  site_id: string;
  site_name: string;
  site_no: string;
  room_id: string | null;
  room_label: string | null;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  created_by: string;
  created_at: Date;
  done_at: Date | null;
  version: number;
}

export async function listTickets(
  sql: Sql,
  f: { siteIds: string[] | null; siteId?: string; status?: 'offen' | 'alle' },
) {
  return sql<Ticket[]>`
    select t.*, s.name as site_name, s.site_no,
           concat_ws(' · ', nullif(r.floor, ''), concat_ws(' ', r.room_no, r.name)) as room_label
      from app.site_tickets t join app.sites s on s.id = t.site_id left join app.rooms r on r.id = t.room_id
     where ${scope(sql, f.siteIds)}
       and ${f.siteId ? sql`t.site_id = ${f.siteId}` : sql`true`}
       and ${f.status === 'alle' ? sql`true` : sql`t.status <> 'erledigt'`}
     order by (t.priority = 'hoch') desc, t.created_at desc`;
}

export async function createTicket(
  sql: Sql,
  id: string,
  p: { siteId: string; roomId: string | null; title: string; description: string | null; priority: string },
  actor: string,
) {
  if (!p.title.trim()) throw new BusinessError('Bitte kurz beschreiben, worum es geht');
  if (!(p.priority in TICKET_PRIO)) throw new BusinessError('Priorität ungültig');
  await sql.begin(async (tx) => {
    const [exists] = await tx`select 1 from app.site_tickets where id = ${id}`;
    if (exists) return; // doppelt gesendet
    if (p.roomId) {
      const [r] = await tx`select 1 from app.rooms where id = ${p.roomId} and site_id = ${p.siteId}`;
      if (!r) throw new BusinessError('Raum gehört nicht zu diesem Objekt');
    }
    const number = await nextYearNumber(tx, 'site_ticket', 'T-', todayBerlin().slice(0, 4), 4);
    await tx`insert into app.site_tickets (id, number, site_id, room_id, title, description, priority, created_by)
             values (${id}, ${number}, ${p.siteId}, ${p.roomId}, ${p.title.trim()}, ${p.description?.trim() || null},
                     ${p.priority}, ${actor})`;
  });
}

export async function setTicketStatus(sql: Sql, id: string, status: string, actor: string) {
  if (!(status in TICKET_STATUS)) throw new BusinessError('Status ungültig');
  await sql`update app.site_tickets set status = ${status},
              done_by = ${status === 'erledigt' ? actor : null}, done_at = ${status === 'erledigt' ? sql`now()` : null}
             where id = ${id}`;
}

// ---------------------------------------------------------------- Einstellungen: Kontrollgegenstände je Nutzungsart

export interface QmItem {
  id: string;
  name: string;
  kind: 'note' | 'janein';
  active: boolean;
  sort_order: number;
  version: number;
}

export const QM_KIND: Record<QmItem['kind'], string> = {
  note: 'Skala (Note 1–6)',
  janein: 'Ja / Nein',
};

export async function listQmItems(sql: Sql, all = true) {
  return sql<
    QmItem[]
  >`select * from app.qm_items where ${all ? sql`true` : sql`active`} order by sort_order, name`;
}

export async function saveQmItem(
  sql: Sql,
  id: string,
  p: { name: string; kind: string; active: boolean; sortOrder: number | null },
) {
  const name = p.name.trim();
  if (!name) throw new BusinessError('Bitte einen Namen für den Kontrollgegenstand angeben');
  if (!(p.kind in QM_KIND)) throw new BusinessError('Bewertungsart ungültig');
  const [dup] = await sql`select 1 from app.qm_items where lower(name) = lower(${name}) and id <> ${id}`;
  if (dup) throw new BusinessError(`„${name}“ gibt es schon`);
  await sql`
    insert into app.qm_items (id, name, kind, active, sort_order)
    values (${id}, ${name}, ${p.kind}, ${p.active},
            ${p.sortOrder ?? sql`(select coalesce(max(sort_order), 0) + 10 from app.qm_items)`})
    on conflict (id) do update set name = excluded.name, kind = excluded.kind, active = excluded.active,
      sort_order = excluded.sort_order`;
}

export async function roomTypeItems(sql: Sql) {
  const types = await sql<{ id: string; name: string; active: boolean; rooms: number }[]>`
    select t.id, t.name, t.active, (select count(*)::int from app.rooms r where r.room_type_id = t.id and r.active) as rooms
      from app.room_types t order by t.active desc, t.sort_order, t.name`;
  const links = await sql<{ room_type_id: string; item_id: string }[]>`select * from app.room_type_qm_items`;
  return { types, links: new Set(links.map((l) => `${l.room_type_id}:${l.item_id}`)) };
}

/** Zuordnung komplett ersetzen (Matrix aus dem Formular: „Nutzungsart:Gegenstand“). */
export async function saveRoomTypeItems(sql: Sql, pairs: string[]) {
  const rows = pairs
    .map((p) => p.split(':'))
    .filter((p) => p.length === 2 && p.every((x) => /^[0-9a-f-]{36}$/.test(x)))
    .map(([room_type_id, item_id]) => ({ room_type_id: room_type_id!, item_id: item_id! }));
  await sql.begin(async (tx) => {
    await tx`delete from app.room_type_qm_items`;
    if (rows.length) await tx`insert into app.room_type_qm_items ${tx(rows)} on conflict do nothing`;
  });
}

// ---------------------------------------------------------------- Audit Raum für Raum

/** Prozent je Bewertung: Note 1 = 100 % … 6 = 0 %; Ja/Nein: Ja (1) = 100 %, Nein (6) = 0 %. */
export const ratingPercent = (v: number) => Math.round(((6 - v) * 100) / 5);

export interface AuditRoom {
  id: string;
  name: string;
  floor: string | null;
  room_no: string | null;
  floor_covering: string | null;
  area_centi: bigint;
  room_type_id: string;
  room_type: string;
  items: number;
  rated: number;
  score: number | null;
}

export const roomMeta = (r: Pick<AuditRoom, 'floor' | 'room_no' | 'floor_covering' | 'area_centi'>) =>
  [
    r.floor,
    r.room_no,
    r.floor_covering,
    `${(Number(r.area_centi) / 100).toLocaleString('de-DE', { maximumFractionDigits: 2 })} m²`,
  ]
    .filter(Boolean)
    .join(' | ');

/** Kontrollgegenstände eines Raums (über die Nutzungsart; ohne Zuordnung: alle aktiven). */
export async function itemsForRoomType(sql: Sql, roomTypeId: string) {
  const linked = await sql<QmItem[]>`
    select i.* from app.qm_items i join app.room_type_qm_items l on l.item_id = i.id
     where l.room_type_id = ${roomTypeId} and i.active order by i.sort_order, i.name`;
  return linked.length ? linked : listQmItems(sql, false);
}

export async function auditRooms(sql: Sql, checkId: string, siteId: string, q = '') {
  const like = `%${q.trim()}%`;
  const rooms = await sql<Omit<AuditRoom, 'items' | 'rated' | 'score'>[]>`
    select r.id, r.name, r.floor, r.room_no, r.floor_covering, r.area_centi, r.room_type_id, t.name as room_type
      from app.rooms r join app.room_types t on t.id = r.room_type_id
     where r.site_id = ${siteId} and r.active
       and ${q.trim() ? sql`(r.name || ' ' || coalesce(r.floor, '') || ' ' || coalesce(r.room_no, '') || ' ' || t.name) ilike ${like}` : sql`true`}
     order by r.floor nulls first, r.sort_order, r.room_no nulls last, r.name`;
  const counts = await sql<{ room_type_id: string; n: number }[]>`
    select room_type_id, count(*)::int as n from app.room_type_qm_items l join app.qm_items i on i.id = l.item_id and i.active
     group by room_type_id`;
  const [{ all }] = (await sql`select count(*)::int as all from app.qm_items where active`) as unknown as [
    { all: number },
  ];
  const ratings = await sql<{ room_id: string; value: number | null; skipped: boolean }[]>`
    select room_id, value, skipped from app.quality_check_ratings where check_id = ${checkId}`;
  const cnt = new Map(counts.map((c) => [c.room_type_id, c.n]));
  return rooms.map((r) => {
    const rs = ratings.filter((x) => x.room_id === r.id);
    const vals = rs.filter((x) => !x.skipped && x.value != null).map((x) => ratingPercent(x.value!));
    return {
      ...r,
      items: cnt.get(r.room_type_id) ?? all,
      rated: rs.length,
      score: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null,
    };
  });
}

export async function roomRatings(sql: Sql, checkId: string, roomId: string) {
  return sql<
    { item_id: string; value: number | null; skipped: boolean; note: string | null; photo_ids: string[] }[]
  >`
    select item_id, value, skipped, note, photo_ids from app.quality_check_ratings
     where check_id = ${checkId} and room_id = ${roomId}`;
}

/**
 * Bewertungen eines Raums speichern (je Gegenstand Wert oder „übersprungen“, Begründung, Fotos) und die
 * Kontrollzeile des Raums für Bericht/Abschluss nachführen: ≥ 75 % = in Ordnung, sonst Mangel.
 */
export async function saveRoomRatings(
  sql: Sql,
  p: {
    checkId: string;
    roomId: string;
    ratings: {
      itemId: string;
      value: number | null;
      skipped: boolean;
      note: string | null;
      photoIds: string[];
    }[];
    actor: string;
  },
) {
  const [qc] = await sql<{ status: string; site_id: string }[]>`
    select status::text, site_id from app.quality_checks where id = ${p.checkId}`;
  if (!qc) throw new BusinessError('Audit nicht gefunden');
  if (qc.status !== 'entwurf') throw new BusinessError('Das Audit ist abgeschlossen');
  const [room] = await sql<{ name: string }[]>`
    select name from app.rooms where id = ${p.roomId} and site_id = ${qc.site_id}`;
  if (!room) throw new BusinessError('Raum gehört nicht zu diesem Objekt');
  for (const r of p.ratings)
    if (!r.skipped && (r.value == null || r.value < 1 || r.value > 6))
      throw new BusinessError('Bewertung ungültig');
  const items = new Map((await listQmItems(sql)).map((i) => [i.id, i]));
  await sql.begin(async (tx) => {
    for (const r of p.ratings) {
      if (!items.has(r.itemId)) continue;
      await tx`
        insert into app.quality_check_ratings (id, check_id, room_id, item_id, value, skipped, note, photo_ids, rated_by)
        values (md5(${`qcr:${p.checkId}:${p.roomId}:${r.itemId}`})::uuid, ${p.checkId}, ${p.roomId}, ${r.itemId},
                ${r.skipped ? null : r.value}, ${r.skipped}, ${r.note}, ${r.photoIds}, ${p.actor})
        on conflict (check_id, room_id, item_id) do update set value = excluded.value, skipped = excluded.skipped,
          note = excluded.note,
          photo_ids = (select array(select distinct unnest(app.quality_check_ratings.photo_ids || excluded.photo_ids))),
          rated_by = excluded.rated_by, rated_at = now()`;
    }
    const rated = p.ratings.filter((r) => !r.skipped && r.value != null);
    if (!rated.length) return;
    const pct = rated.map((r) => ratingPercent(r.value!));
    const score = Math.round(pct.reduce((a, b) => a + b, 0) / pct.length);
    const weak = rated
      .filter((r) => ratingPercent(r.value!) < 50)
      .map((r) => items.get(r.itemId)?.name ?? '');
    const notes = p.ratings.filter((r) => r.note).map((r) => `${items.get(r.itemId)?.name}: ${r.note}`);
    await tx`
      update app.quality_check_items set rating = ${score >= 75 ? 'ok' : 'mangel'},
        defects = ${score >= 75 ? [] : weak.length ? weak : ['Sonstiges']},
        note = ${[`Note ${score} %`, ...notes].join(' · ').slice(0, 1000)}
       where check_id = ${p.checkId} and room_id = ${p.roomId}`;
  });
}

/** Live-Ergebnis eines Audits (Durchschnitt der Räume). */
export async function auditScore(sql: Sql, checkId: string) {
  const [r] = await sql<{ score: number | null }[]>`
    select round(avg(room_score))::int as score from (
      select avg((6 - value) * 20.0) as room_score from app.quality_check_ratings
       where check_id = ${checkId} and not skipped and value is not null group by room_id) x`;
  return r?.score ?? null;
}
