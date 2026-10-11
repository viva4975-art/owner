import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { leaveBalance, onLeaveChange } from './absences.js';

/*
 * Warnung „kein Urlaub mehr“ (Ahmed 11.10.): aktive Mitarbeitende mit Resturlaub 0 oder weniger im laufenden Jahr
 * (im Folgejahr nur bei weniger als 0, also schon überplant). Als erledigt markierbar; sinkt der Rest danach weiter,
 * erscheint die Warnung wieder. Rechnen kostet je Person einige Abfragen → kurz zwischengespeichert.
 */

export interface LeaveWarning {
  employee_id: string;
  name: string;
  personnel_no: string;
  year: number;
  entitlement: number;
  rest: number;
  acked: { by: string; at: Date; rest: number } | null;
}

let cache: { key: string; at: number; rows: LeaveWarning[] } | null = null;
onLeaveChange(() => (cache = null));

export async function leaveWarnings(sql: Sql, today = todayBerlin()): Promise<LeaveWarning[]> {
  const key = today;
  if (cache && cache.key === key && Date.now() - cache.at < 600_000) return cache.rows;
  const year = Number(today.slice(0, 4));
  const emps = await sql<{ id: string; name: string; personnel_no: string; next: boolean }[]>`
    select e.id, e.last_name || ', ' || e.first_name as name, e.personnel_no,
           exists (select 1 from app.absences a where a.employee_id = e.id and a.kind = 'urlaub'
                    and a.status in ('beantragt', 'genehmigt') and a.end_date >= ${`${year + 1}-01-01`}) as next
      from app.employees e
     where e.status = 'aktiv' and e.entry_date <= ${today} and (e.exit_date is null or e.exit_date >= ${today})
     order by e.last_name, e.first_name`;
  const acks = await sql<
    { employee_id: string; year: number; rest: string; acked_by: string; acked_at: Date }[]
  >`
    select employee_id, year, rest::text, acked_by, acked_at from app.leave_warning_acks where year >= ${year}`;
  const ack = new Map(acks.map((a) => [`${a.employee_id}:${a.year}`, a]));
  const rows: LeaveWarning[] = [];
  for (const e of emps) {
    for (const y of e.next ? [year, year + 1] : [year]) {
      const b = await leaveBalance(sql, e.id, y);
      if (y === year ? b.rest > 0 : b.rest >= 0) continue;
      const a = ack.get(`${e.id}:${y}`);
      rows.push({
        employee_id: e.id,
        name: e.name,
        personnel_no: e.personnel_no,
        year: y,
        entitlement: b.entitlement,
        rest: b.rest,
        acked: a ? { by: a.acked_by, at: a.acked_at, rest: Number(a.rest) } : null,
      });
    }
  }
  cache = { key, at: Date.now(), rows };
  return rows;
}

/** Offen = nicht abgehakt, oder Rest ist seit dem Abhaken weiter gesunken. */
export const isOpen = (w: LeaveWarning) => !w.acked || w.rest < w.acked.rest;

export async function ackLeaveWarning(sql: Sql, employeeId: string, year: number, actor: string) {
  const b = await leaveBalance(sql, employeeId, year);
  await sql`
    insert into app.leave_warning_acks (employee_id, year, rest, acked_by)
    values (${employeeId}, ${year}, ${b.rest}, ${actor})
    on conflict (employee_id, year) do update set rest = excluded.rest, acked_by = excluded.acked_by, acked_at = now()`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'ack', 'leave_warning', ${employeeId}, ${sql.json({ year, rest: b.rest })})`;
  cache = null;
}

export const warningText = (w: LeaveWarning) =>
  w.entitlement === 0 && w.rest === 0
    ? `${w.name}: kein Urlaubsanspruch hinterlegt (${w.year})`
    : `${w.name}: ${w.rest < 0 ? `${String(w.rest).replace('.', ',')} Tage Urlaub (überzogen)` : 'kein Urlaub mehr'} (${w.year})`;
