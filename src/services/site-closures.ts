/**
 * Schließzeiten am Objekt (Ahmed 30.10.: z. B. Schulferien, Betriebsruhe). An diesen Tagen wird nicht gereinigt:
 * Leistungen „nach Arbeitstagen“ zählen die Tage nicht (Rechnung, Plan-Kalkulation, Leistungen verrichten),
 * NU-Bestellungen „je Tag“ an diesem Objekt ebenso, und eingeplante Einsätze entfallen (kein Soll, nicht in der App).
 */
import { createHash } from 'node:crypto';
import type { Sql, Tx } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { schoolFreePeriods } from '../domain/time/school-holidays.js';
import { BusinessError } from './errors.js';

type Db = Sql | Tx;

export interface DateRange {
  from: string;
  to: string;
}

export interface SiteClosure {
  id: string;
  site_id: string;
  date_from: string;
  date_to: string;
  note: string | null;
  created_by: string;
}

export const isClosed = (ranges: readonly DateRange[] | null | undefined, d: string) =>
  !!ranges?.some((r) => r.from <= d && d <= r.to);

export async function listSiteClosures(sql: Db, siteId: string) {
  return sql<SiteClosure[]>`
    select id, site_id, date_from::text, date_to::text, note, created_by from app.site_closures
     where site_id = ${siteId} order by date_from`;
}

/** Schließzeiten je Objekt (für Zählungen) */
export async function siteClosureMap(sql: Db, siteIds: readonly string[]): Promise<Map<string, DateRange[]>> {
  const out = new Map<string, DateRange[]>();
  const ids = [...new Set(siteIds.filter(Boolean))];
  if (!ids.length) return out;
  for (const r of await sql<{ site_id: string; f: string; t: string }[]>`
    select site_id, date_from::text as f, date_to::text as t from app.site_closures
     where site_id = any(${ids}::uuid[]) order by date_from`) {
    const l = out.get(r.site_id) ?? [];
    l.push({ from: r.f, to: r.t });
    out.set(r.site_id, l);
  }
  return out;
}

const isoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function addSiteClosure(
  sql: Sql,
  p: { id: string; siteId: string; from: string; to: string; note: string | null },
  actor: string,
) {
  if (!isoDate(p.from)) throw new BusinessError('Bitte „von“ angeben');
  const to = p.to && isoDate(p.to) ? p.to : p.from;
  if (to < p.from) throw new BusinessError('„bis“ liegt vor „von“');
  await sql`
    insert into app.site_closures (id, site_id, date_from, date_to, note, created_by)
    values (${p.id}, ${p.siteId}, ${p.from}, ${to}, ${p.note?.trim() || null}, ${actor})
    on conflict (id) do nothing`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'closure_add', 'site', ${p.siteId},
                    ${sql.json({ von: p.from, bis: to, notiz: p.note ?? null })})`;
}

export async function deleteSiteClosure(sql: Sql, siteId: string, id: string, actor: string) {
  const [c] = await sql<{ date_from: string; date_to: string; note: string | null }[]>`
    delete from app.site_closures where id = ${id} and site_id = ${siteId}
    returning date_from::text, date_to::text, note`;
  if (!c) return;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'closure_delete', 'site', ${siteId},
                    ${sql.json({ von: c.date_from, bis: c.date_to, notiz: c.note })})`;
}

/** Schulferien Bayern (+ Buß- und Bettag) ab heute eintragen; überlappende übersprungen, feste ID → nichts doppelt. */
export async function addSiteSchoolClosures(sql: Sql, siteId: string, actor: string) {
  const today = todayBerlin();
  const existing = await listSiteClosures(sql, siteId);
  let added = 0;
  for (const p of schoolFreePeriods()) {
    if (p.to < today) continue;
    if (existing.some((x) => x.date_from <= p.to && x.date_to >= p.from)) continue;
    const h = createHash('md5').update(`site-school:${siteId}:${p.from}`).digest('hex');
    const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    const res = await sql`
      insert into app.site_closures (id, site_id, date_from, date_to, note, created_by)
      values (${id}, ${siteId}, ${p.from}, ${p.to}, ${p.name}, ${actor}) on conflict (id) do nothing`;
    added += res.count;
  }
  if (added)
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${actor}, 'closure_school', 'site', ${siteId}, ${sql.json({ anzahl: added })})`;
  return added;
}
