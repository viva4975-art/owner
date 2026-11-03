/**
 * Stundennachweis für den Kunden je Objekt (Ahmed 03.11.: „Stunden für jeweilige Tage mit Person 1, Person 2 usw.
 * eintragen – manchmal haben wir auch Nachunternehmer im Einsatz“). Zeilen je Tag und Person, übernommen aus den
 * erfassten Zeiten bzw. der Einsatzplanung oder von Hand ergänzt. Gibt es für ein Objekt im Leistungszeitraum Zeilen,
 * nimmt der Stundennachweis zur Rechnung diese (redacted-timesheet.ts), sonst wie bisher die erfassten Zeiten.
 * Namen erscheinen nie: Mitarbeitende werden je Objekt und Zeitraum als „Person 1, 2 …“ durchgezählt.
 */
import { addDays } from '../domain/time/holidays.js';
import type { Sql } from '../db/client.js';
import { BusinessError } from './errors.js';
import { uuidOf } from './fortytools-export-import.js';
import { countsAsActual } from './site-times.js';
import { clock, listEntries, plannedShifts } from './time.js';

export interface TimesheetRow {
  id: string;
  work_date: string;
  person: string;
  employee_id: string | null;
  start_time: string;
  end_time: string;
  break_minutes: number;
  minutes: number;
  source: 'manuell' | 'ist' | 'plan';
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const isoDay = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay(); // 0 = So

export async function listTimesheetRows(sql: Sql, siteId: string, from: string, to: string) {
  return sql<TimesheetRow[]>`
    select id, work_date::text, person, employee_id, to_char(start_time, 'HH24:MI') as start_time,
           to_char(end_time, 'HH24:MI') as end_time, break_minutes,
           (extract(epoch from (end_time - start_time)) / 60)::int - break_minutes as minutes, source
      from app.site_timesheet_rows
     where site_id = ${siteId} and work_date between ${from} and ${to}
     order by work_date, start_time, person`;
}

/** Nächste freie Nummer „Person n“ im Zeitraum. */
function nextPersonNo(rows: Pick<TimesheetRow, 'person'>[]) {
  let max = 0;
  for (const r of rows) {
    const m = /^Person\s+(\d+)\b/i.exec(r.person.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export async function suggestPerson(sql: Sql, siteId: string, from: string, to: string) {
  return `Person ${nextPersonNo(await listTimesheetRows(sql, siteId, from, to))}`;
}

/** Zeilen von Hand: eine Person, gleiche Zeit, an allen gewählten Wochentagen im Zeitraum (von = bis → ein Tag). */
export async function addTimesheetRows(
  sql: Sql,
  p: {
    token: string;
    siteId: string;
    person: string;
    start: string;
    end: string;
    breakMinutes: number;
    from: string;
    to: string;
    weekdays: number[];
  },
  actor: string,
) {
  const person = p.person.trim();
  if (!person) throw new BusinessError('Person fehlt (z. B. „Person 3“ oder „Nachunternehmer – Person 1“)');
  if (person.length > 120) throw new BusinessError('Person: höchstens 120 Zeichen');
  if (!HHMM.test(p.start) || !HHMM.test(p.end))
    throw new BusinessError('Beginn/Ende als Uhrzeit, z. B. 06:00');
  if (toMin(p.end) <= toMin(p.start))
    throw new BusinessError('Ende muss nach dem Beginn liegen (über Mitternacht: zwei Zeilen eintragen)');
  if (
    !Number.isInteger(p.breakMinutes) ||
    p.breakMinutes < 0 ||
    p.breakMinutes >= toMin(p.end) - toMin(p.start)
  )
    throw new BusinessError('Pause ist länger als die Arbeitszeit');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.from)) throw new BusinessError('Datum fehlt');
  const to = /^\d{4}-\d{2}-\d{2}$/.test(p.to) ? p.to : p.from;
  if (to < p.from) throw new BusinessError('„bis“ liegt vor „von“');
  const days: string[] = [];
  for (let d = p.from; d <= to; d = addDays(d, 1)) {
    if (days.length > 400) throw new BusinessError('Höchstens ein Jahr auf einmal');
    if (p.from === to || !p.weekdays.length || p.weekdays.includes(isoDay(d))) days.push(d);
  }
  if (!days.length) throw new BusinessError('Im Zeitraum liegt keiner der gewählten Wochentage');
  let n = 0;
  for (const d of days) {
    const r = await sql`
      insert into app.site_timesheet_rows (id, site_id, work_date, person, start_time, end_time, break_minutes, source, created_by)
      values (${uuidOf(`sts:${p.token}:${d}`)}, ${p.siteId}, ${d}, ${person}, ${p.start}, ${p.end}, ${p.breakMinutes}, 'manuell', ${actor})
      on conflict (id) do nothing`;
    n += r.count;
  }
  if (n)
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${actor}, 'timesheet_rows_add', 'site', ${p.siteId},
                      ${sql.json({ person, von: p.from, bis: to, beginn: p.start, ende: p.end, anzahl: n })})`;
  return n;
}

/**
 * Übernehmen aus erfassten Zeiten („ist“) oder Einsatzplanung („plan“). Je Mitarbeiter bleibt die Nummer im Zeitraum
 * gleich; Tage, an denen die Person schon eine Zeile hat, werden übersprungen (Ist und Plan nicht doppelt).
 */
export async function importTimesheetRows(
  sql: Sql,
  p: { siteId: string; from: string; to: string; source: 'ist' | 'plan' },
  actor: string,
) {
  const existing = await listTimesheetRows(sql, p.siteId, p.from, p.to);
  const label = new Map<string, string>();
  for (const r of existing)
    if (r.employee_id && !label.has(r.employee_id)) label.set(r.employee_id, r.person);
  const have = new Set(existing.filter((r) => r.employee_id).map((r) => `${r.employee_id}|${r.work_date}`));
  let next = nextPersonNo(existing);
  const personOf = (emp: string) => {
    let l = label.get(emp);
    if (!l) label.set(emp, (l = `Person ${next++}`));
    return l;
  };
  type Cand = { id: string; emp: string; date: string; start: string; end: string; brk: number };
  const cands: Cand[] = [];
  let skipped = 0;
  if (p.source === 'ist') {
    const entries = (await listEntries(sql, { siteId: p.siteId, from: p.from, to: p.to }))
      .filter((e) => countsAsActual(e) && e.end_at)
      .sort((a, b) => a.work_date.localeCompare(b.work_date) || a.start_at.getTime() - b.start_at.getTime());
    for (const e of entries) {
      const start = clock(e.start_at);
      const end = clock(e.end_at);
      if (toMin(end) <= toMin(start)) {
        skipped++; // über Mitternacht – von Hand in zwei Zeilen eintragen
        continue;
      }
      cands.push({
        id: uuidOf(`sts-ist:${e.id}`),
        emp: e.employee_id,
        date: e.work_date,
        start,
        end,
        brk: e.break_minutes,
      });
    }
  } else {
    const shifts = (await plannedShifts(sql, { from: p.from, to: p.to, siteId: p.siteId }))
      .filter((s) => s.plan.employee_id && !s.absence && s.exception?.kind !== 'ausfall')
      .filter((s) => !s.holiday || s.plan.holiday_work)
      .sort((a, b) => a.date.localeCompare(b.date) || a.plan.start_time.localeCompare(b.plan.start_time));
    for (const s of shifts) {
      const start = s.plan.start_time.slice(0, 5);
      const end = s.plan.end_time.slice(0, 5);
      if (toMin(end) <= toMin(start)) {
        skipped++;
        continue;
      }
      cands.push({
        id: uuidOf(`sts-plan:${s.plan.id}:${s.date}`),
        emp: s.plan.employee_id!,
        date: s.date,
        start,
        end,
        brk: Math.min(s.plan.break_minutes ?? 0, toMin(end) - toMin(start) - 1),
      });
    }
  }
  let n = 0;
  for (const c of cands) {
    if (have.has(`${c.emp}|${c.date}`) && !existing.some((r) => r.id === c.id)) {
      skipped++;
      continue;
    }
    const r = await sql`
      insert into app.site_timesheet_rows (id, site_id, work_date, person, employee_id, start_time, end_time, break_minutes, source, created_by)
      values (${c.id}, ${p.siteId}, ${c.date}, ${personOf(c.emp)}, ${c.emp}, ${c.start}, ${c.end}, ${c.brk}, ${p.source}, ${actor})
      on conflict (id) do nothing`;
    n += r.count;
  }
  if (n)
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${actor}, 'timesheet_rows_import', 'site', ${p.siteId},
                      ${sql.json({ quelle: p.source, von: p.from, bis: p.to, anzahl: n })})`;
  return { added: n, skipped };
}

export async function deleteTimesheetRows(sql: Sql, siteId: string, ids: string[], actor: string) {
  if (!ids.length) return 0;
  const gone = await sql<{ work_date: string; person: string }[]>`
    delete from app.site_timesheet_rows where site_id = ${siteId} and id = any(${ids}::uuid[])
    returning work_date::text, person`;
  if (gone.length)
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${actor}, 'timesheet_rows_delete', 'site', ${siteId}, ${sql.json({ zeilen: gone })})`;
  return gone.length;
}
