import type { Sql } from '../db/client.js';
import { isoWeekday } from '../domain/time/holidays.js';
import { assertVersion } from './crm.js';
import { BusinessError } from './errors.js';
import { type PlannedShift, plannedShifts } from './time.js';

/*
 * Planung wie Fortytools: Tagesausnahmen zu wiederkehrenden Einsätzen.
 *   ausfall    – Einsatz findet an diesem Tag nicht statt (z. B. Objekt geschlossen)
 *   vertretung – anderer Mitarbeiter übernimmt (Urlaub/Krankheit), optional andere Zeit
 *   umgeplant  – andere Uhrzeit und/oder anderer Mitarbeiter an diesem Tag
 * Die wiederkehrende Planung selbst bleibt unverändert.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export type ExceptionKind = 'ausfall' | 'vertretung' | 'umgeplant';
export const EXCEPTION_LABEL: Record<ExceptionKind, string> = {
  ausfall: 'Ausfall',
  vertretung: 'Vertretung',
  umgeplant: 'umgeplant',
};

export interface ExceptionInput {
  planId: string;
  date: string;
  kind: ExceptionKind;
  substituteId: string | null;
  start: string | null;
  end: string | null;
  note: string | null;
  expectedVersion: number | null;
  /** nur bei Ausfall: Tag wird von dieser Nachunternehmer-Bestellung abgedeckt */
  subcontractId?: string | null;
}

export async function saveException(sql: Sql, id: string, p: ExceptionInput, actor: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new BusinessError('Datum ungültig');
  if (!(p.kind in EXCEPTION_LABEL)) throw new BusinessError('Art ungültig');
  const [plan] = await sql<
    {
      employee_id: string;
      weekday: number;
      valid_from: string;
      valid_until: string | null;
      site_id: string;
    }[]
  >`
    select employee_id, weekday, valid_from, valid_until, site_id from app.shift_plans where id = ${p.planId}`;
  if (
    !plan ||
    plan.weekday !== isoWeekday(p.date) ||
    plan.valid_from > p.date ||
    (plan.valid_until && plan.valid_until < p.date)
  ) {
    throw new BusinessError('An diesem Tag ist dieser Einsatz nicht geplant');
  }
  if ((p.start == null) !== (p.end == null)) throw new BusinessError('Bitte Beginn und Ende angeben');
  if (p.start && (!HHMM.test(p.start) || !HHMM.test(p.end!) || p.end! <= p.start)) {
    throw new BusinessError('Uhrzeit bitte als HH:MM, Ende nach Beginn');
  }
  if (p.kind === 'vertretung' && !p.substituteId) throw new BusinessError('Bitte Vertretung auswählen');
  if (p.subcontractId) {
    const [o] = await sql<
      { status: string }[]
    >`select status from app.subcontracts where id = ${p.subcontractId}`;
    if (!o || o.status !== 'erteilt') throw new BusinessError('Nachunternehmer-Bestellung ist nicht erteilt');
  }
  if (p.kind === 'umgeplant' && !p.substituteId && !p.start)
    throw new BusinessError('Bitte neue Zeit oder Mitarbeiter angeben');
  const sub = p.kind === 'ausfall' ? null : p.substituteId === plan.employee_id ? null : p.substituteId;
  if (sub) {
    const [e] = await sql<{ status: string }[]>`select status from app.employees where id = ${sub}`;
    if (!e || e.status !== 'aktiv') throw new BusinessError('Vertretung ist kein aktiver Mitarbeiter');
    const [abs] = await sql`select 1 from app.absences where employee_id = ${sub} and status = 'genehmigt'
                             and start_date <= ${p.date} and end_date >= ${p.date}`;
    if (abs) throw new BusinessError('Die Vertretung ist an diesem Tag selbst abwesend');
    // keine Überschneidung mit eigenen Einsätzen der Vertretung
    const [pl] = await sql<{ start_time: string; end_time: string }[]>`
      select to_char(start_time, 'HH24:MI') as start_time, to_char(end_time, 'HH24:MI') as end_time
        from app.shift_plans where id = ${p.planId}`;
    const s = p.start ?? pl!.start_time;
    const en = p.end ?? pl!.end_time;
    const own = (await plannedShifts(sql, { from: p.date, to: p.date, employeeId: sub })).filter(
      (x) => x.plan.id !== p.planId,
    );
    const clash = own.find((x) => x.plan.start_time < en && x.plan.end_time > s);
    if (clash) {
      throw new BusinessError(
        `Überschneidung: ${clash.plan.employee_name} ist ${clash.plan.start_time}–${clash.plan.end_time} in ${clash.plan.site_name} eingeplant`,
      );
    }
  }
  await sql.begin(async (tx) => {
    const [cur] = await tx<{ id: string; version: number }[]>`
      select id, version from app.shift_exceptions where shift_plan_id = ${p.planId} and work_date = ${p.date} for update`;
    assertVersion(cur?.version, p.expectedVersion, 'Die Umplanung');
    const [entry] =
      await tx`select 1 from app.time_entries where shift_plan_id = ${p.planId} and work_date = ${p.date}`;
    if (entry)
      throw new BusinessError('Für diesen Einsatz ist schon eine Zeit erfasst – bitte dort korrigieren');
    const row = {
      kind: p.kind,
      substitute_employee_id: sub,
      start_time: p.kind === 'ausfall' ? null : p.start,
      end_time: p.kind === 'ausfall' ? null : p.end,
      note: p.note,
      subcontract_id: p.kind === 'ausfall' ? (p.subcontractId ?? null) : null,
    };
    if (cur) {
      await tx`update app.shift_exceptions set ${tx(row as Record<string, unknown>)} where id = ${cur.id}`;
    } else {
      await tx`insert into app.shift_exceptions ${tx({ id, shift_plan_id: p.planId, work_date: p.date, created_by: actor, ...row } as Record<string, unknown>)}`;
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'exception', 'shift_plan', ${p.planId}, ${tx.json({ date: p.date, ...row })})`;
  });
}

export async function deleteException(sql: Sql, planId: string, date: string, actor: string) {
  const [entry] =
    await sql`select 1 from app.time_entries where shift_plan_id = ${planId} and work_date = ${date}`;
  if (entry) throw new BusinessError('Für diesen Einsatz ist schon eine Zeit erfasst');
  const res =
    await sql`delete from app.shift_exceptions where shift_plan_id = ${planId} and work_date = ${date} returning id`;
  if (res.length) {
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${actor}, 'exception_removed', 'shift_plan', ${planId}, ${sql.json({ date })})`;
  }
}

/** Einsätze, deren Mitarbeiter abwesend ist und für die noch nichts geregelt ist (Fortytools-Warnung). */
export async function uncoveredShifts(sql: Sql, from: string, to: string, scope: string[] | null = null) {
  const all = await plannedShifts(sql, { from, to });
  return all.filter(
    // auch, wenn die Vertretung inzwischen selbst abwesend ist
    (s) =>
      s.absence &&
      s.exception?.kind !== 'ausfall' &&
      !s.holiday &&
      (!scope || scope.includes(s.plan.site_id)),
  );
}

/** Vorschläge für die Vertretung: zuerst Mitarbeitende des Objekts, ohne Abwesenheit und ohne Überschneidung. */
export async function substituteCandidates(sql: Sql, shift: PlannedShift) {
  const d = shift.date;
  // bei bestehender Vertretung zählt der ursprünglich geplante Mitarbeiter, nicht die Vertretung
  const [orig] = await sql<
    { employee_id: string }[]
  >`select employee_id from app.shift_plans where id = ${shift.plan.id}`;
  const originalId = orig?.employee_id ?? shift.plan.employee_id;
  const emps = await sql<
    { id: string; name: string; personnel_no: string; on_site: boolean; planning_group: string | null }[]
  >`
    select e.id, e.last_name || ', ' || e.first_name as name, e.personnel_no, e.planning_group,
           exists(select 1 from app.employee_sites es where es.employee_id = e.id and es.site_id = ${shift.plan.site_id}) as on_site
      from app.employees e
     where e.status = 'aktiv' and e.id <> ${originalId}
       and not exists (select 1 from app.absences a where a.employee_id = e.id and a.status = 'genehmigt'
                        and a.start_date <= ${d} and a.end_date >= ${d})
     order by on_site desc, e.last_name, e.first_name`;
  const day = await plannedShifts(sql, { from: d, to: d });
  return emps.map((e) => {
    const clash = day.find(
      (x) =>
        x.plan.id !== shift.plan.id &&
        x.plan.employee_id === e.id &&
        x.plan.start_time < shift.plan.end_time &&
        x.plan.end_time > shift.plan.start_time,
    );
    return {
      ...e,
      busy: clash ? `${clash.plan.start_time}–${clash.plan.end_time} ${clash.plan.site_name}` : null,
    };
  });
}
