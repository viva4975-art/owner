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
