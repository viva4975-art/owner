/**
 * Stundennachweis für den Kunden je Objekt (Ahmed 03.11.): Die eigenen Leute kommen aus der Einsatzplanung (ohne
 * Abwesenheit, Ausfall, freie Feiertage; Vertretung zählt) – je Mitarbeiter „Person 1, 2 …“, keine Namen. Leute vom
 * Nachunternehmer werden als Dauereintrag gepflegt (app.site_timesheet_extras): Person, Zeit von–bis, Pause,
 * Wochentage, ab Datum, optional bis. Für das PDF werden daraus Tageszeilen (ohne Feiertage und Schließzeiten).
 * Ende vor Beginn = am Folgetag (18:30–00:30 = 6 Std.).
 */
import { addDays, holidayName, isoWeekday } from '../domain/time/holidays.js';
import type { Sql } from '../db/client.js';
import { BusinessError } from './errors.js';
import { uuidOf } from './fortytools-export-import.js';
import { isClosed, siteClosureMap } from './site-closures.js';
import { plannedShifts } from './time.js';

export interface TimesheetLine {
  date: string;
  person: string;
  start: string;
  end: string;
  brk: number;
  minutes: number;
  /** Ende am Folgetag */
  overnight: boolean;
  source: 'plan' | 'nu';
}

export interface TimesheetExtra {
  id: string;
  person: string;
  start_time: string;
  end_time: string;
  break_minutes: number;
  weekdays: number[];
  valid_from: string;
  valid_until: string | null;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** Dauer brutto in Minuten; Ende ≤ Beginn = am Folgetag */
export const spanMinutes = (start: string, end: string) => {
  const d = toMin(end) - toMin(start);
  return d > 0 ? d : d + 1440;
};
export const WEEKDAY_SHORT = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
/** „Mo–Fr“, „Mo, Mi, Fr“ */
export function weekdaysLabel(days: readonly number[]) {
  const d = [...new Set(days)].sort((a, b) => a - b);
  if (d.length >= 3 && d.every((x, i) => i === 0 || x === d[i - 1]! + 1))
    return `${WEEKDAY_SHORT[d[0]!]}–${WEEKDAY_SHORT[d[d.length - 1]!]}`;
  return d.map((x) => WEEKDAY_SHORT[x]).join(', ');
}

/** Zeilen aus der Einsatzplanung, je Mitarbeiter durchgezählt „Person n“ (Reihenfolge des ersten Einsatzes). */
export async function planLines(sql: Sql, siteId: string, from: string, to: string) {
  const shifts = (await plannedShifts(sql, { from, to, siteId }))
    .filter((s) => s.plan.employee_id && !s.absence && s.exception?.kind !== 'ausfall')
    .filter((s) => !s.holiday || s.plan.holiday_work)
    .sort((a, b) => a.date.localeCompare(b.date) || a.plan.start_time.localeCompare(b.plan.start_time));
  const no = new Map<string, number>();
  return shifts.map((s) => {
    const emp = s.plan.employee_id!;
    if (!no.has(emp)) no.set(emp, no.size + 1);
    const start = s.plan.start_time.slice(0, 5);
    const end = s.plan.end_time.slice(0, 5);
    const span = spanMinutes(start, end);
    const brk = Math.min(s.plan.break_minutes ?? 0, span - 1);
    return {
      date: s.date,
      person: `Person ${no.get(emp)}`,
      start,
      end,
      brk,
      minutes: span - brk,
      overnight: toMin(end) <= toMin(start),
      source: 'plan' as const,
    };
  });
}

/** Eingesetzte Personen aus der Planung, zusammengefasst (Zeiten, Tage, Einsätze, Stunden im Zeitraum). */
export async function planPersons(sql: Sql, siteId: string, from: string, to: string) {
  const by = new Map<
    string,
    { person: string; times: Map<string, Set<number>>; shifts: number; minutes: number }
  >();
  for (const l of await planLines(sql, siteId, from, to)) {
    let p = by.get(l.person);
    if (!p) by.set(l.person, (p = { person: l.person, times: new Map(), shifts: 0, minutes: 0 }));
    const key = `${l.start}–${l.end}${l.brk ? ` (Pause ${l.brk} Min.)` : ''}`;
    if (!p.times.has(key)) p.times.set(key, new Set());
    p.times.get(key)!.add(isoWeekday(l.date));
    p.shifts++;
    p.minutes += l.minutes;
  }
  return [...by.values()].map((p) => ({
    person: p.person,
    times: [...p.times].map(([t, days]) => `${weekdaysLabel([...days])} ${t}`),
    shifts: p.shifts,
    minutes: p.minutes,
  }));
}

export async function listExtras(sql: Sql, siteId: string) {
  return sql<TimesheetExtra[]>`
    select id, person, to_char(start_time, 'HH24:MI') as start_time, to_char(end_time, 'HH24:MI') as end_time,
           break_minutes, weekdays::int[] as weekdays, valid_from::text, valid_until::text
      from app.site_timesheet_extras where site_id = ${siteId}
     order by valid_until is not null, valid_from, person`;
}

/** Tageszeilen eines Nachunternehmer-Eintrags im Zeitraum (ohne Feiertage und Schließzeiten des Objekts). */
function extraDays(x: TimesheetExtra, from: string, to: string, closures: { from: string; to: string }[]) {
  const out: TimesheetLine[] = [];
  const a = x.valid_from > from ? x.valid_from : from;
  const b = x.valid_until && x.valid_until < to ? x.valid_until : to;
  const span = spanMinutes(x.start_time, x.end_time);
  for (let d = a; d <= b; d = addDays(d, 1)) {
    if (!x.weekdays.includes(isoWeekday(d)) || holidayName(d) || isClosed(closures, d)) continue;
    out.push({
      date: d,
      person: x.person,
      start: x.start_time,
      end: x.end_time,
      brk: x.break_minutes,
      minutes: span - x.break_minutes,
      overnight: toMin(x.end_time) <= toMin(x.start_time),
      source: 'nu',
    });
  }
  return out;
}

export async function extraLines(sql: Sql, siteId: string, from: string, to: string) {
  const [extras, closures] = await Promise.all([listExtras(sql, siteId), siteClosureMap(sql, [siteId])]);
  return extras.flatMap((x) => extraDays(x, from, to, closures.get(siteId) ?? []));
}

/** Alle Tageszeilen des Nachweises (PDF): Einsatzplanung + Nachunternehmer, nach Tag und Beginn. */
export async function timesheetRows(sql: Sql, siteId: string, from: string, to: string) {
  const [plan, extra] = await Promise.all([
    planLines(sql, siteId, from, to),
    extraLines(sql, siteId, from, to),
  ]);
  return [...plan, ...extra].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.start.localeCompare(b.start) ||
      a.person.localeCompare(b.person, 'de', { numeric: true }),
  );
}

/** Vorschlag „Nachunternehmer – Person n“ (nächste freie Nummer). */
export async function suggestExtraPerson(sql: Sql, siteId: string) {
  let max = 0;
  for (const r of await listExtras(sql, siteId)) {
    const m = /Person\s+(\d+)\s*$/i.exec(r.person.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Nachunternehmer – Person ${max + 1}`;
}

/** Nachunternehmer-Person eintragen (feste ID je Formular → doppelt absenden legt nichts doppelt an). */
export async function addExtra(
  sql: Sql,
  p: {
    token: string;
    siteId: string;
    person: string;
    start: string;
    end: string;
    breakMinutes: number;
    weekdays: number[];
    from: string;
    to: string | null;
  },
  actor: string,
) {
  const person = p.person.trim();
  if (!person) throw new BusinessError('Person fehlt (z. B. „Nachunternehmer – Person 1“)');
  if (person.length > 120) throw new BusinessError('Person: höchstens 120 Zeichen');
  if (!HHMM.test(p.start) || !HHMM.test(p.end))
    throw new BusinessError('Zeit von/bis als Uhrzeit, z. B. 18:30');
  if (p.start === p.end) throw new BusinessError('Beginn und Ende sind gleich');
  if (
    !Number.isInteger(p.breakMinutes) ||
    p.breakMinutes < 0 ||
    p.breakMinutes >= spanMinutes(p.start, p.end)
  )
    throw new BusinessError('Pause ist länger als die Arbeitszeit');
  const days = [...new Set(p.weekdays)].filter((d) => d >= 1 && d <= 7);
  if (!days.length) throw new BusinessError('Mindestens einen Wochentag wählen');
  if (!ISO.test(p.from)) throw new BusinessError('„ab“ fehlt');
  const to = p.to && ISO.test(p.to) ? p.to : null;
  if (to && to < p.from) throw new BusinessError('„bis“ liegt vor „ab“');
  const id = uuidOf(`sts-extra:${p.token}`);
  const r = await sql`
    insert into app.site_timesheet_extras (id, site_id, person, start_time, end_time, break_minutes, weekdays, valid_from, valid_until, created_by)
    values (${id}, ${p.siteId}, ${person}, ${p.start}, ${p.end}, ${p.breakMinutes}, ${days}::smallint[], ${p.from}, ${to}, ${actor})
    on conflict (id) do nothing`;
  if (r.count)
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${actor}, 'timesheet_extra_add', 'site', ${p.siteId},
                      ${sql.json({ person, beginn: p.start, ende: p.end, pause: p.breakMinutes, tage: days, ab: p.from, bis: to })})`;
  return r.count;
}

/** Ende setzen bzw. wieder offen (leer). */
export async function setExtraEnd(sql: Sql, siteId: string, id: string, until: string | null, actor: string) {
  const [x] = await sql<{ valid_from: string; person: string; valid_until: string | null }[]>`
    select valid_from::text, person, valid_until::text from app.site_timesheet_extras
     where id = ${id} and site_id = ${siteId}`;
  if (!x) throw new BusinessError('Eintrag nicht gefunden');
  const to = until && ISO.test(until) ? until : null;
  if (to && to < x.valid_from) throw new BusinessError('Ende liegt vor „ab“');
  await sql`update app.site_timesheet_extras set valid_until = ${to} where id = ${id}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'timesheet_extra_end', 'site', ${siteId},
                    ${sql.json({ person: x.person, bis_alt: x.valid_until, bis: to })})`;
}

export async function deleteExtra(sql: Sql, siteId: string, id: string, actor: string) {
  const gone = await sql<Record<string, string | number | number[] | null>[]>`
    delete from app.site_timesheet_extras where id = ${id} and site_id = ${siteId}
    returning person, start_time::text, end_time::text, break_minutes, weekdays, valid_from::text, valid_until::text`;
  if (gone.length)
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${actor}, 'timesheet_extra_delete', 'site', ${siteId}, ${sql.json(gone[0]!)})`;
  return gone.length;
}
