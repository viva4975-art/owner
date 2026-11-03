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

/** Abweichender Tag einer Nachunternehmer-Person: anders gearbeitet oder nicht ausgeführt. */
export interface TimesheetExtraDay {
  id: string;
  extra_id: string;
  day: string;
  kind: 'anders' | 'entfaellt';
  start_time: string | null;
  end_time: string | null;
  break_minutes: number;
  note: string | null;
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

export async function listExtraDays(sql: Sql, siteId: string) {
  const rows = await sql<TimesheetExtraDay[]>`
    select d.id, d.extra_id, d.day::text as day, d.kind,
           to_char(d.start_time, 'HH24:MI') as start_time, to_char(d.end_time, 'HH24:MI') as end_time,
           d.break_minutes, d.note
      from app.site_timesheet_extra_days d join app.site_timesheet_extras x on x.id = d.extra_id
     where x.site_id = ${siteId} order by d.day`;
  const by = new Map<string, Map<string, TimesheetExtraDay>>();
  for (const r of rows) {
    if (!by.has(r.extra_id)) by.set(r.extra_id, new Map());
    by.get(r.extra_id)!.set(r.day, r);
  }
  return by;
}

const line = (d: string, person: string, start: string, end: string, brk: number): TimesheetLine => ({
  date: d,
  person,
  start,
  end,
  brk,
  minutes: spanMinutes(start, end) - brk,
  overnight: toMin(end) <= toMin(start),
  source: 'nu',
});

/**
 * Tageszeilen eines Nachunternehmer-Eintrags im Zeitraum (ohne Feiertage und Schließzeiten des Objekts).
 * Abweichende Tage gehen vor: „nicht ausgeführt“ fällt weg, „anders gearbeitet“ nimmt die Zeit des Tages – auch an
 * einem sonst freien Tag (ausdrücklich eingetragen).
 */
function extraDays(
  x: TimesheetExtra,
  from: string,
  to: string,
  closures: { from: string; to: string }[],
  days?: Map<string, TimesheetExtraDay>,
) {
  const out: TimesheetLine[] = [];
  const a = x.valid_from > from ? x.valid_from : from;
  const b = x.valid_until && x.valid_until < to ? x.valid_until : to;
  for (let d = a; d <= b; d = addDays(d, 1)) {
    const ex = days?.get(d);
    if (ex) {
      if (ex.kind === 'anders' && ex.start_time && ex.end_time)
        out.push(line(d, x.person, ex.start_time, ex.end_time, ex.break_minutes));
      continue;
    }
    if (!x.weekdays.includes(isoWeekday(d)) || holidayName(d) || isClosed(closures, d)) continue;
    out.push(line(d, x.person, x.start_time, x.end_time, x.break_minutes));
  }
  return out;
}

export async function extraLines(sql: Sql, siteId: string, from: string, to: string) {
  const [extras, closures, days] = await Promise.all([
    listExtras(sql, siteId),
    siteClosureMap(sql, [siteId]),
    listExtraDays(sql, siteId),
  ]);
  return extras.flatMap((x) => extraDays(x, from, to, closures.get(siteId) ?? [], days.get(x.id)));
}

/** Einzelnen Tag abweichend festhalten (ersetzt einen vorhandenen Eintrag für denselben Tag). */
export async function setExtraDay(
  sql: Sql,
  p: {
    siteId: string;
    extraId: string;
    day: string;
    kind: 'anders' | 'entfaellt';
    start?: string;
    end?: string;
    breakMinutes?: number;
    note?: string;
  },
  actor: string,
) {
  const [x] = await sql<{ person: string; valid_from: string; valid_until: string | null }[]>`
    select person, valid_from::text, valid_until::text from app.site_timesheet_extras
     where id = ${p.extraId} and site_id = ${p.siteId}`;
  if (!x) throw new BusinessError('Eintrag nicht gefunden');
  if (!ISO.test(p.day)) throw new BusinessError('Datum fehlt');
  if (p.day < x.valid_from || (x.valid_until && p.day > x.valid_until))
    throw new BusinessError(
      `Datum liegt außerhalb des Zeitraums von ${x.person} – vorher „ab“ bzw. Ende anpassen`,
    );
  const note = (p.note ?? '').trim().slice(0, 300) || null;
  let start: string | null = null;
  let end: string | null = null;
  let brk = 0;
  if (p.kind === 'anders') {
    start = p.start ?? '';
    end = p.end ?? '';
    brk = p.breakMinutes ?? 0;
    if (!HHMM.test(start) || !HHMM.test(end))
      throw new BusinessError('Zeit von/bis als Uhrzeit, z. B. 18:30');
    if (start === end) throw new BusinessError('Beginn und Ende sind gleich');
    if (!Number.isInteger(brk) || brk < 0 || brk >= spanMinutes(start, end))
      throw new BusinessError('Pause ist länger als die Arbeitszeit');
  }
  const id = uuidOf(`sts-extra-day:${p.extraId}:${p.day}`);
  await sql`
    insert into app.site_timesheet_extra_days (id, extra_id, day, kind, start_time, end_time, break_minutes, note, created_by)
    values (${id}, ${p.extraId}, ${p.day}, ${p.kind}, ${start}, ${end}, ${brk}, ${note}, ${actor})
    on conflict (extra_id, day) do update set kind = excluded.kind, start_time = excluded.start_time,
      end_time = excluded.end_time, break_minutes = excluded.break_minutes, note = excluded.note,
      created_by = excluded.created_by, created_at = now()`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'timesheet_extra_day', 'site', ${p.siteId},
                    ${sql.json({ person: x.person, tag: p.day, art: p.kind, beginn: start, ende: end, pause: brk, notiz: note })})`;
  return x.person;
}

export async function deleteExtraDay(sql: Sql, siteId: string, dayId: string, actor: string) {
  const gone = await sql<{ person: string; day: string; kind: string }[]>`
    delete from app.site_timesheet_extra_days d using app.site_timesheet_extras x
     where d.id = ${dayId} and x.id = d.extra_id and x.site_id = ${siteId}
    returning x.person, d.day::text as day, d.kind`;
  if (gone.length)
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${actor}, 'timesheet_extra_day_delete', 'site', ${siteId}, ${sql.json(gone[0]!)})`;
  return gone.length;
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
