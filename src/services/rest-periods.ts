import type { Sql } from '../db/client.js';
import { formatDateDe as fmtDate } from '../domain/invoice/calc.js';
import { deleteAbsence, requestAbsence } from './absences.js';
import { BusinessError } from './errors.js';
import { uuidOf } from './fortytools-export-import.js';

/*
 * Ruhendes Arbeitsverhältnis mit Zeitraum (Ahmed 24.11.: „von wann bis wann und dann auch keine Kosten berechnen“).
 * Im Zeitraum wird „Unbezahlt frei“ eingetragen – damit fallen Lohn (Stundenlohn: keine Stunden, Festgehalt: Abzug),
 * Nach-/Plan-Kalkulation und Budget auf 0; eingeplante Einsätze brauchen eine Vertretung. Urlaub entsteht im
 * Ruhenszeitraum nicht (leaveDaysPeriods, BAG 19.03.2019, 9 AZR 315/17).
 */

export interface RestPeriod {
  id: string;
  start_date: string;
  end_date: string;
  reason: string | null;
  absence_id: string | null;
  created_by: string;
  created_at: Date;
}

export async function listRestPeriods(sql: Sql, employeeId: string): Promise<RestPeriod[]> {
  return sql<RestPeriod[]>`
    select id, start_date::text, end_date::text, reason, absence_id, created_by, created_at
      from app.employee_rest_periods where employee_id = ${employeeId} order by start_date desc`;
}

/** Ruhenszeiträume im Bereich (für Urlaubsanspruch) */
export async function restRanges(sql: Sql, employeeId: string, from: string, to: string) {
  return sql<{ start_date: string; end_date: string }[]>`
    select start_date::text, end_date::text from app.employee_rest_periods
     where employee_id = ${employeeId} and start_date <= ${to} and end_date >= ${from} order by start_date`;
}

export async function addRestPeriod(
  sql: Sql,
  p: { id: string; employeeId: string; start: string; end: string; reason: string | null; actor: string },
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.start) || !/^\d{4}-\d{2}-\d{2}$/.test(p.end))
    throw new BusinessError('Bitte „ruht von“ und „ruht bis“ angeben');
  if (p.end < p.start) throw new BusinessError('„bis“ liegt vor „von“');
  const [dup] = await sql`select 1 from app.employee_rest_periods where id = ${p.id}`;
  if (dup) return;
  const [e] = await sql<{ entry_date: string; exit_date: string | null }[]>`
    select entry_date::text, exit_date::text from app.employees where id = ${p.employeeId}`;
  if (!e) throw new BusinessError('Mitarbeiter nicht gefunden');
  if (p.start < e.entry_date)
    throw new BusinessError(`Ruhen kann erst ab Eintritt (${fmtDate(e.entry_date)}) beginnen`);
  if (e.exit_date && p.end > e.exit_date)
    throw new BusinessError(`Ruhen kann höchstens bis zum Austritt (${fmtDate(e.exit_date)}) gehen`);
  const [over] = await sql<{ start_date: string; end_date: string }[]>`
    select start_date::text, end_date::text from app.employee_rest_periods
     where employee_id = ${p.employeeId} and start_date <= ${p.end} and end_date >= ${p.start}`;
  if (over)
    throw new BusinessError(
      `Für ${fmtDate(over.start_date)}–${fmtDate(over.end_date)} ist schon ein Ruhenszeitraum eingetragen`,
    );
  const abs = await sql<{ kind: string; start_date: string; end_date: string }[]>`
    select kind::text, start_date::text, end_date::text from app.absences
     where employee_id = ${p.employeeId} and status in ('beantragt', 'genehmigt')
       and start_date <= ${p.end} and end_date >= ${p.start} order by start_date`;
  if (abs.length)
    throw new BusinessError(
      `Im Zeitraum sind schon Abwesenheiten eingetragen (${abs
        .map(
          (a) =>
            `${a.kind === 'urlaub' ? 'Urlaub' : a.kind === 'krank' ? 'Krank' : a.kind} ${fmtDate(a.start_date)}–${fmtDate(a.end_date)}`,
        )
        .join(', ')}) – bitte erst ändern oder löschen`,
    );
  const absenceId = uuidOf(`rest:${p.id}`);
  await requestAbsence(sql, {
    id: absenceId,
    employeeId: p.employeeId,
    kind: 'unbezahlt',
    start: p.start,
    end: p.end,
    halfDay: false,
    note: `Arbeitsverhältnis ruht${p.reason ? ` – ${p.reason}` : ''}`,
    actor: p.actor,
    approved: true,
  });
  await sql`
    insert into app.employee_rest_periods (id, employee_id, start_date, end_date, reason, absence_id, created_by)
    values (${p.id}, ${p.employeeId}, ${p.start}, ${p.end}, ${p.reason}, ${absenceId}, ${p.actor})
    on conflict (id) do nothing`;
  // Status „ruhend“ ergibt sich jetzt aus dem Zeitraum
  await sql`update app.employees set hr_stage = null where id = ${p.employeeId} and hr_stage = 'ruhend'`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${p.actor}, 'rest_add', 'employee', ${p.employeeId},
                    ${sql.json({ von: p.start, bis: p.end, grund: p.reason })})`;
}

export async function deleteRestPeriod(sql: Sql, id: string, employeeId: string, actor: string) {
  const [r] = await sql<RestPeriod[]>`
    select id, start_date::text, end_date::text, reason, absence_id, created_by, created_at
      from app.employee_rest_periods where id = ${id} and employee_id = ${employeeId}`;
  if (!r) return;
  if (r.absence_id) await deleteAbsence(sql, r.absence_id, actor);
  await sql`delete from app.employee_rest_periods where id = ${id}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'rest_delete', 'employee', ${employeeId},
                    ${sql.json({ von: r.start_date, bis: r.end_date, grund: r.reason })})`;
}
