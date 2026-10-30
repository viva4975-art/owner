/**
 * NU-Bestellung „je Tag“ (Ahmed 22.10.): Preis × Anzahl Arbeitstage im Monat. Arbeitstage = gewählte Wochentage
 * (Standard Mo–Fr) im Gültigkeitszeitraum der Bestellung, ohne Feiertage (Bayern) und ohne eingetragene Schließzeiten.
 */
import type { Sql } from '../db/client.js';
import { addDays, holidayName, isoWeekday } from '../domain/time/holidays.js';
import { createHash } from 'node:crypto';
import { schoolFreePeriods } from '../domain/time/school-holidays.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from './errors.js';

export const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'] as const;
export const DEFAULT_WORK_DAYS = [1, 2, 3, 4, 5];

export interface Closure {
  id: string;
  date_from: string;
  date_to: string;
  note: string | null;
  created_by: string;
  /** Schließzeit des Objekts (Objekt → Schließzeiten), nicht der Bestellung */
  at_site?: boolean;
}

/**
 * Schließzeiten je Bestellung: eigene + die des Objekts der Bestellung (Ahmed 30.10.: Schließzeiten am Objekt gelten
 * automatisch auch für Nachunternehmer „je Tag“).
 */
export async function orderClosures(sql: Sql, ids: string[]) {
  if (!ids.length) return [] as { subcontract_id: string; date_from: string; date_to: string }[];
  return sql<{ subcontract_id: string; date_from: string; date_to: string }[]>`
    select subcontract_id, date_from::text, date_to::text from app.subcontract_closures
     where subcontract_id in ${sql(ids)}
    union all
    select s.id, c.date_from::text, c.date_to::text
      from app.subcontracts s join app.site_closures c on c.site_id = s.site_id
     where s.id in ${sql(ids)}`;
}

/** „Mo–Fr“, „Mo, Mi, Fr“ */
export function workDaysLabel(days: number[] | null | undefined): string {
  const d = [...(days?.length ? days : DEFAULT_WORK_DAYS)].sort((a, b) => a - b);
  const contiguous = d.length > 2 && d.every((x, i) => i === 0 || x === d[i - 1]! + 1);
  return contiguous
    ? `${WEEKDAYS[d[0]! - 1]}–${WEEKDAYS[d[d.length - 1]! - 1]}`
    : d.map((x) => WEEKDAYS[x - 1]).join(', ');
}

/** Arbeitstage im Monat (JJJJ-MM) innerhalb von Beginn/Ende, ohne Feiertage und Schließzeiten. */
export function countDays(
  month: string,
  o: {
    workDays: number[] | null | undefined;
    validFrom: string;
    validTo: string | null;
    closures: { date_from: string; date_to: string }[];
  },
) {
  const days = new Set(o.workDays?.length ? o.workDays : DEFAULT_WORK_DAYS);
  const first = `${month}-01`;
  const last = addDays(`${nextMonth(month)}-01`, -1);
  let n = 0;
  let holidays = 0;
  let closed = 0;
  for (let d = first < o.validFrom ? o.validFrom : first; d <= last; d = addDays(d, 1)) {
    if (o.validTo && d > o.validTo) break;
    if (!days.has(isoWeekday(d))) continue;
    if (holidayName(d)) holidays++;
    else if (o.closures.some((c) => c.date_from <= d && d <= c.date_to)) closed++;
    else n++;
  }
  return { days: n, holidays, closed };
}

function nextMonth(m: string) {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

export async function listClosures(sql: Sql, subcontractId: string) {
  return sql<Closure[]>`
    select id, date_from::text, date_to::text, note, created_by, false as at_site from app.subcontract_closures
     where subcontract_id = ${subcontractId}
    union all
    select c.id, c.date_from::text, c.date_to::text, c.note, c.created_by, true
      from app.subcontracts s join app.site_closures c on c.site_id = s.site_id
     where s.id = ${subcontractId}
     order by 2`;
}

/** Arbeitstage und Betrag (Preis je Tag × Tage) für mehrere „je Tag“-Bestellungen in einem Monat. */
export async function dayAmounts(
  sql: Sql,
  rows: {
    id: string;
    billing: string;
    work_days?: number[] | null;
    valid_from: string;
    valid_to: string | null;
    current_price_cents: bigint;
  }[],
  month: string,
) {
  const tag = rows.filter((r) => r.billing === 'tag');
  const out = new Map<string, { days: number; amount: bigint }>();
  if (!tag.length) return out;
  const cl = await orderClosures(
    sql,
    tag.map((r) => r.id),
  );
  for (const r of tag) {
    const { days } = countDays(month, {
      workDays: r.work_days,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      closures: cl.filter((c) => c.subcontract_id === r.id),
    });
    out.set(r.id, { days, amount: r.current_price_cents * BigInt(days) });
  }
  return out;
}

export async function addClosure(
  sql: Sql,
  p: { id: string; subcontractId: string; from: string; to: string; note: string | null },
  actor: string,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.from)) throw new BusinessError('Bitte „von“ angeben');
  const to = p.to && /^\d{4}-\d{2}-\d{2}$/.test(p.to) ? p.to : p.from;
  if (to < p.from) throw new BusinessError('„bis“ liegt vor „von“');
  await sql`
    insert into app.subcontract_closures (id, subcontract_id, date_from, date_to, note, created_by)
    values (${p.id}, ${p.subcontractId}, ${p.from}, ${to}, ${p.note?.trim() || null}, ${actor})
    on conflict (id) do nothing`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'closure_add', 'subcontract', ${p.subcontractId},
                    ${sql.json({ von: p.from, bis: to, notiz: p.note ?? null })})`;
}

export async function deleteClosure(sql: Sql, subcontractId: string, id: string, actor: string) {
  const [c] = await sql<{ date_from: string; date_to: string; note: string | null }[]>`
    delete from app.subcontract_closures where id = ${id} and subcontract_id = ${subcontractId}
    returning date_from::text, date_to::text, note`;
  if (!c) return;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'closure_delete', 'subcontract', ${subcontractId},
                    ${sql.json({ von: c.date_from, bis: c.date_to, notiz: c.note })})`;
}

/**
 * Schulferien Bayern (+ Buß- und Bettag) als Schließzeiten eintragen (Ahmed 23.10.: Schul-Objekte). Nur Zeiträume,
 * die heute oder später enden; schon eingetragene bzw. überlappende Schließzeiten werden übersprungen. Feste ID je
 * Bestellung + Ferienzeitraum → erneut klicken legt nichts doppelt an.
 */
export async function addSchoolClosures(sql: Sql, subcontractId: string, actor: string) {
  const today = todayBerlin();
  const existing = await listClosures(sql, subcontractId);
  let added = 0;
  for (const p of schoolFreePeriods()) {
    if (p.to < today) continue;
    if (existing.some((x) => x.date_from <= p.to && x.date_to >= p.from)) continue;
    const h = createHash('md5').update(`school:${subcontractId}:${p.from}`).digest('hex');
    const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    await addClosure(sql, { id, subcontractId, from: p.from, to: p.to, note: p.name }, actor);
    added++;
  }
  return added;
}
