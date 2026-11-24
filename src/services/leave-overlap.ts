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

export interface SiteOverlap {
  siteId: string;
  siteName: string;
  siteNo: string;
  customerName: string;
  /** zusammenhängende Tage mit gleicher Besetzung der Abwesenden */
  ranges: {
    from: string;
    to: string;
    days: number;
    planned: number;
    absent: { employeeId: string; name: string; kind: AbsenceKind; status: string }[];
  }[];
  /** größte Zahl gleichzeitig Abwesender */
  peak: number;
}

const overlapCache = new Map<string, { at: number; v: SiteOverlap[] }>();

/**
 * Übersicht (Ahmed 24.11.): Objekte, an denen mindestens `min` eingeplante Personen gleichzeitig abwesend sind.
 * Schließzeiten des Objekts (z. B. Schulferien) und Feiertage zählen nicht – an diesen Tagen ist niemand eingeplant.
 */
export async function siteOverlaps(
  sql: Sql,
  p: { from: string; to: string; siteIds?: readonly string[] | null; min?: number },
): Promise<SiteOverlap[]> {
  const min = p.min ?? 2;
  const key = `${p.from}|${p.to}|${min}|${p.siteIds ? [...p.siteIds].sort().join(',') : '*'}`;
  const hit = overlapCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const abs = await sql<
    { employee_id: string; name: string; kind: AbsenceKind; status: string; s: string; e: string }[]
  >`
    select a.employee_id, e.first_name || ' ' || e.last_name as name, a.kind, a.status,
           a.start_date::text as s, a.end_date::text as e
      from app.absences a join app.employees e on e.id = a.employee_id
     where a.status in ('beantragt', 'genehmigt') and a.start_date <= ${p.to} and a.end_date >= ${p.from}
     order by a.start_date`;
  const out: SiteOverlap[] = [];
  if (abs.length >= min) {
    const absentIds = [...new Set(abs.map((a) => a.employee_id))];
    // nur Objekte, an denen mindestens `min` der Abwesenden einen Einsatz haben
    const cand = await sql<{ site_id: string; site_name: string; site_no: string; customer_name: string }[]>`
      select p.site_id, s.name as site_name, s.site_no, c.name as customer_name
        from app.shift_plans p join app.sites s on s.id = p.site_id join app.customers c on c.id = s.customer_id
       where p.employee_id = any(${absentIds}::uuid[]) and s.active
         and p.valid_from <= ${p.to} and (p.valid_until is null or p.valid_until >= ${p.from})
         ${p.siteIds ? sql`and p.site_id = any(${[...p.siteIds]}::uuid[])` : sql``}
       group by p.site_id, s.name, s.site_no, c.name
      having count(distinct p.employee_id) >= ${min}`;
    for (const site of cand) {
      const shifts = await plannedShifts(sql, {
        from: p.from,
        to: p.to,
        siteId: site.site_id,
        originalAssignee: true,
      });
      const byDay = new Map<string, Set<string>>();
      for (const s of shifts) {
        if (s.holiday || !s.plan.employee_id) continue;
        if (!byDay.has(s.date)) byDay.set(s.date, new Set());
        byDay.get(s.date)!.add(s.plan.employee_id);
      }
      const ranges: SiteOverlap['ranges'] = [];
      let peak = 0;
      for (const [date, emps] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const seen = new Set<string>();
        const absent = abs
          .filter((a) => emps.has(a.employee_id) && a.s <= date && a.e >= date)
          .filter((a) => (seen.has(a.employee_id) ? false : (seen.add(a.employee_id), true)))
          .map((a) => ({ employeeId: a.employee_id, name: a.name, kind: a.kind, status: a.status }));
        if (absent.length < min) continue;
        peak = Math.max(peak, absent.length);
        const sig = absent
          .map((a) => `${a.employeeId}:${a.kind}:${a.status}`)
          .sort()
          .join('|');
        const last = ranges[ranges.length - 1];
        const lastSig = last?.absent
          .map((a) => `${a.employeeId}:${a.kind}:${a.status}`)
          .sort()
          .join('|');
        // gleiche Abwesende ohne Lücke an Einsatztagen dazwischen → ein Zeitraum (Wochenenden ohne Einsatz überbrückt)
        const gapFree = last && [...byDay.keys()].filter((d) => d > last.to && d < date).length === 0;
        if (last && lastSig === sig && gapFree) {
          last.to = date;
          last.days += 1;
          last.planned = Math.max(last.planned, emps.size);
        } else ranges.push({ from: date, to: date, days: 1, planned: emps.size, absent });
      }
      if (ranges.length)
        out.push({
          siteId: site.site_id,
          siteName: site.site_name,
          siteNo: site.site_no,
          customerName: site.customer_name,
          ranges,
          peak,
        });
    }
  }
  out.sort(
    (a, b) => a.ranges[0]!.from.localeCompare(b.ranges[0]!.from) || a.siteName.localeCompare(b.siteName),
  );
  overlapCache.set(key, { at: Date.now(), v: out });
  if (overlapCache.size > 50) overlapCache.delete(overlapCache.keys().next().value!);
  return out;
}
