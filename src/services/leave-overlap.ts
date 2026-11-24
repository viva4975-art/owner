/**
 * Gleichzeitige Abwesenheiten je Objekt (Ahmed 24.11.: „zwei Leute am Objekt gleichzeitig im Urlaub sofort sehen,
 * dem dritten den Urlaub nicht gewähren“).
 *
 * Grundlage ist die Einsatzplanung: Eine Person zählt an einem Tag für ein Objekt, wenn sie dort an dem Tag eingeplant
 * ist (wiederkehrender Einsatz, auch wenn schon eine Vertretung eingetragen ist). Abwesend = beantragte oder genehmigte
 * Abwesenheit jeder Art (auch Krankheit – sie fehlt genauso, lässt sich aber nicht ablehnen).
 */
import type { Sql } from '../db/client.js';
import { addDays } from '../domain/time/holidays.js';
import { ABSENCE_LABEL, type AbsenceKind } from './absences.js';
import { BusinessError } from './errors.js';
import { plannedShifts } from './time.js';

/** Abwesenheitsarten, bei denen vor dem Eintragen/Genehmigen gewarnt wird (planbar – Krankheit nicht). */
export const PLANNABLE_KINDS: AbsenceKind[] = ['urlaub', 'unbezahlt', 'sonstiges'];
/** Standard: höchstens 2 gleichzeitig abwesend je Objekt. */
export const DEFAULT_MAX_ABSENT = 2;

export async function maxAbsentPerSite(sql: Sql): Promise<number | null> {
  const [r] = await sql<{ n: number | null }[]>`select leave_max_absent as n from app.time_settings limit 1`;
  return r ? r.n : DEFAULT_MAX_ABSENT;
}

export async function saveMaxAbsentPerSite(sql: Sql, n: number | null, actor: string) {
  if (n !== null && (!Number.isInteger(n) || n < 1 || n > 50))
    throw new BusinessError('Anzahl 1–50 oder leer');
  await sql`update app.time_settings set leave_max_absent = ${n}`;
  await sql`insert into app.audit_log (actor, action, entity, details)
            values (${actor}, 'save', 'time_settings', ${sql.json({ leave_max_absent: n === null ? 'aus' : String(n) })})`;
}

export interface SiteAbsentDay {
  date: string;
  /** Abwesende, die an dem Tag am Objekt eingeplant sind */
  absent: { employeeId: string; name: string; kind: AbsenceKind; status: string }[];
  /** an dem Tag am Objekt eingeplante Personen */
  planned: number;
  plannedIds: string[];
}

/** Je Objekt und Tag: wer ist eingeplant und abwesend? */
export async function siteAbsenceDays(
  sql: Sql,
  siteId: string,
  from: string,
  to: string,
  excludeAbsenceId?: string,
): Promise<SiteAbsentDay[]> {
  const shifts = await plannedShifts(sql, { from, to, siteId, originalAssignee: true });
  const byDay = new Map<string, Set<string>>();
  for (const s of shifts) {
    if (s.holiday || !s.plan.employee_id) continue;
    if (!byDay.has(s.date)) byDay.set(s.date, new Set());
    byDay.get(s.date)!.add(s.plan.employee_id);
  }
  const ids = [...new Set([...byDay.values()].flatMap((x) => [...x]))];
  if (!ids.length) return [];
  const abs = await sql<
    {
      id: string;
      employee_id: string;
      name: string;
      kind: AbsenceKind;
      status: string;
      s: string;
      e: string;
    }[]
  >`
    select a.id, a.employee_id, e.first_name || ' ' || e.last_name as name, a.kind, a.status,
           a.start_date::text as s, a.end_date::text as e
      from app.absences a join app.employees e on e.id = a.employee_id
     where a.employee_id = any(${ids}::uuid[]) and a.status in ('beantragt', 'genehmigt')
       and a.start_date <= ${to} and a.end_date >= ${from}
       and a.id is distinct from ${excludeAbsenceId ?? null}::uuid`;
  const out: SiteAbsentDay[] = [];
  for (const [date, emps] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const absent = abs
      .filter((a) => emps.has(a.employee_id) && a.s <= date && a.e >= date)
      .map((a) => ({ employeeId: a.employee_id, name: a.name, kind: a.kind, status: a.status }));
    const seen = new Set<string>();
    out.push({
      date,
      planned: emps.size,
      plannedIds: [...emps],
      absent: absent.filter((a) => (seen.has(a.employeeId) ? false : (seen.add(a.employeeId), true))),
    });
  }
  return out;
}

export interface LeaveConflict {
  siteId: string;
  siteName: string;
  siteNo: string;
  /** Tage, an denen mit dieser Abwesenheit mehr als erlaubt fehlen */
  days: { date: string; others: string[]; planned: number }[];
}

/**
 * Würden mit dieser Abwesenheit an einem Objekt der Person mehr als `max` Personen gleichzeitig fehlen?
 * Nur Objekte/Tage, an denen die Person selbst eingeplant ist.
 */
export async function leaveConflicts(
  sql: Sql,
  p: { employeeId: string; start: string; end: string; excludeAbsenceId?: string; max?: number | null },
): Promise<LeaveConflict[]> {
  const max = p.max === undefined ? await maxAbsentPerSite(sql) : p.max;
  if (max === null) return [];
  // höchstens 120 Tage prüfen (Rest ist Langzeit-Abwesenheit, da hilft die Warnung nicht)
  const end = p.end > addDays(p.start, 120) ? addDays(p.start, 120) : p.end;
  const own = await plannedShifts(sql, {
    from: p.start,
    to: end,
    employeeId: p.employeeId,
    originalAssignee: true,
  });
  const sites = new Map<string, { name: string; no: string; days: Set<string> }>();
  for (const s of own) {
    if (s.holiday || s.plan.employee_id !== p.employeeId) continue;
    const x = sites.get(s.plan.site_id) ?? {
      name: s.plan.site_name ?? '',
      no: s.plan.site_no ?? '',
      days: new Set(),
    };
    x.days.add(s.date);
    sites.set(s.plan.site_id, x);
  }
  const out: LeaveConflict[] = [];
  for (const [siteId, info] of sites) {
    const days = await siteAbsenceDays(sql, siteId, p.start, end, p.excludeAbsenceId);
    const hit = days
      .filter((d) => info.days.has(d.date))
      .map((d) => ({ d, others: d.absent.filter((a) => a.employeeId !== p.employeeId) }))
      .filter(({ others }) => others.length + 1 > max)
      .map(({ d, others }) => ({
        date: d.date,
        others: others.map(
          (o) => `${o.name} (${ABSENCE_LABEL[o.kind]}${o.status === 'beantragt' ? ', beantragt' : ''})`,
        ),
        planned: d.planned,
      }));
    if (hit.length) out.push({ siteId, siteName: info.name, siteNo: info.no, days: hit });
  }
  return out;
}

const dateDe = (d: string) => `${d.slice(8)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

/** Wirft `leave_overlap` (Rückfrage „trotzdem?“), wenn zu viele am selben Objekt fehlen würden. */
export async function assertLeaveOverlap(
  sql: Sql,
  p: { employeeId: string; kind: AbsenceKind; start: string; end: string; excludeAbsenceId?: string },
) {
  if (!PLANNABLE_KINDS.includes(p.kind)) return;
  const max = await maxAbsentPerSite(sql);
  const c = await leaveConflicts(sql, { ...p, max });
  if (!c.length) return;
  const parts = c.map((x) => {
    const first = x.days[0]!;
    const range =
      x.days.length === 1
        ? dateDe(first.date)
        : `${dateDe(first.date)}–${dateDe(x.days[x.days.length - 1]!.date)} (${x.days.length} Tage)`;
    const names = [...new Set(x.days.flatMap((d) => d.others))].join(', ');
    return `${x.siteName}${x.siteNo ? ` (${x.siteNo})` : ''}: ${range} schon abwesend: ${names}`;
  });
  throw new BusinessError(
    `Am Objekt fehlen dann mehr als ${max} Personen gleichzeitig – ${parts.join(' · ')}`,
    'leave_overlap',
  );
}
