import type { Sql } from '../db/client.js';
import { workingDays } from '../domain/time/holidays.js';
import { BusinessError } from './errors.js';

export type AbsenceKind = 'urlaub' | 'krank' | 'kind_krank' | 'unbezahlt' | 'sonstiges';
export type AbsenceStatus = 'beantragt' | 'genehmigt' | 'abgelehnt' | 'storniert';

export const ABSENCE_LABEL: Record<AbsenceKind, string> = {
  urlaub: 'Urlaub',
  krank: 'Krank',
  kind_krank: 'Kind krank',
  unbezahlt: 'Unbezahlt frei',
  sonstiges: 'Sonstiges',
};
export const ABSENCE_STATUS_LABEL: Record<AbsenceStatus, string> = {
  beantragt: 'beantragt',
  genehmigt: 'genehmigt',
  abgelehnt: 'abgelehnt',
  storniert: 'storniert',
};

export interface Absence {
  id: string;
  employee_id: string;
  kind: AbsenceKind;
  start_date: string;
  end_date: string;
  half_day: boolean;
  status: AbsenceStatus;
  note: string | null;
  requested_by: string;
  requested_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  version: number;
}
export type AbsenceRow = Absence & { employee_name: string; personnel_no: string; days: number };

/** Tage (Mo–Fr ohne Feiertage Bayern); halber Tag = 0,5. */
export const absenceDays = (a: Pick<Absence, 'start_date' | 'end_date' | 'half_day'>) =>
  a.half_day ? 0.5 : workingDays(a.start_date, a.end_date);

export async function listAbsences(
  sql: Sql,
  f: { employeeId?: string; status?: AbsenceStatus[]; from?: string; to?: string } = {},
) {
  const rows = await sql<(Absence & { employee_name: string; personnel_no: string })[]>`
    select a.*, e.last_name || ', ' || e.first_name as employee_name, e.personnel_no
      from app.absences a join app.employees e on e.id = a.employee_id
     where ${f.employeeId ? sql`a.employee_id = ${f.employeeId}` : sql`true`}
       and ${f.status?.length ? sql`a.status in ${sql(f.status)}` : sql`true`}
       and ${f.to ? sql`a.start_date <= ${f.to}` : sql`true`}
       and ${f.from ? sql`a.end_date >= ${f.from}` : sql`true`}
     order by a.start_date desc`;
  return rows.map((r) => ({ ...r, days: absenceDays(r) })) as AbsenceRow[];
}

/**
 * Antrag (Mitarbeiter) oder direkte Erfassung (Büro, z. B. Krankmeldung → sofort genehmigt).
 * Überschneidung mit bestehender Abwesenheit wird abgelehnt.
 */
export async function requestAbsence(
  sql: Sql,
  p: {
    id: string;
    employeeId: string;
    kind: AbsenceKind;
    start: string;
    end: string;
    halfDay: boolean;
    note: string | null;
    actor: string;
    approved?: boolean;
  },
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.start) || !/^\d{4}-\d{2}-\d{2}$/.test(p.end))
    throw new BusinessError('Datum ungültig', 'bad_date');
  if (p.end < p.start) throw new BusinessError('„bis“ liegt vor „von“', 'bad_range');
  if (p.halfDay && p.start !== p.end)
    throw new BusinessError('Halber Tag nur für einen einzelnen Tag', 'bad_range');
  if (!(p.kind in ABSENCE_LABEL)) throw new BusinessError('Art ungültig');
  if (
    p.kind === 'urlaub' &&
    absenceDays({ start_date: p.start, end_date: p.end, half_day: p.halfDay }) === 0
  ) {
    throw new BusinessError('Im Zeitraum liegen keine Arbeitstage', 'no_workdays');
  }
  await sql.begin(async (tx) => {
    const [exists] = await tx`select 1 from app.absences where id = ${p.id}`;
    if (exists) return;
    await tx`select pg_advisory_xact_lock(hashtext(${'abs:' + p.employeeId}))`;
    const [overlap] = await tx<{ start_date: string; end_date: string }[]>`
      select start_date, end_date from app.absences
       where employee_id = ${p.employeeId} and status in ('beantragt', 'genehmigt')
         and start_date <= ${p.end} and end_date >= ${p.start}`;
    if (overlap)
      throw new BusinessError('Für diesen Zeitraum gibt es schon eine Abwesenheit', 'absence_overlap');
    await tx`
      insert into app.absences (id, employee_id, kind, start_date, end_date, half_day, status, note, requested_by,
                                decided_by, decided_at)
      values (${p.id}, ${p.employeeId}, ${p.kind}, ${p.start}, ${p.end}, ${p.halfDay}, ${p.approved ? 'genehmigt' : 'beantragt'},
              ${p.note}, ${p.actor}, ${p.approved ? p.actor : null}, ${p.approved ? tx`now()` : null})`;
  });
}

export async function decideAbsence(
  sql: Sql,
  id: string,
  status: 'genehmigt' | 'abgelehnt' | 'storniert',
  actor: string,
) {
  const [a] = await sql<Absence[]>`select * from app.absences where id = ${id}`;
  if (!a) throw new BusinessError('Abwesenheit nicht gefunden');
  const allowed: Record<AbsenceStatus, AbsenceStatus[]> = {
    beantragt: ['genehmigt', 'abgelehnt', 'storniert'],
    genehmigt: ['storniert'],
    abgelehnt: [],
    storniert: [],
  };
  if (a.status === status) return;
  if (!allowed[a.status].includes(status))
    throw new BusinessError(
      `„${ABSENCE_STATUS_LABEL[a.status]}“ kann nicht zu „${ABSENCE_STATUS_LABEL[status]}“ werden`,
    );
  await sql`update app.absences set status = ${status}, decided_by = ${actor}, decided_at = now() where id = ${id} and status = ${a.status}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details) values (${actor}, 'status', 'absence', ${id}, ${sql.json({ status })})`;
}

/** Urlaubskonto im Kalenderjahr: Anspruch (anteilig bei Ein-/Austritt), genommen, beantragt, Rest. */
export async function leaveBalance(sql: Sql, employeeId: string, year: number) {
  const [e] = await sql<{ annual_leave_days: string; entry_date: string; exit_date: string | null }[]>`
    select annual_leave_days::text, entry_date, exit_date from app.employees where id = ${employeeId}`;
  if (!e) throw new BusinessError('Mitarbeiter nicht gefunden');
  const yStart = `${year}-01-01`;
  const yEnd = `${year}-12-31`;
  const from = e.entry_date > yStart ? e.entry_date : yStart;
  const to = e.exit_date && e.exit_date < yEnd ? e.exit_date : yEnd;
  // anteilig: volle Beschäftigungsmonate (§ 5 BUrlG vereinfacht), auf halbe Tage gerundet
  const months =
    from > to ? 0 : Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1 - (from.slice(8) !== '01' ? 1 : 0);
  const full = Number(e.annual_leave_days);
  const entitlement =
    from === yStart && to === yEnd ? full : Math.round(((full * Math.max(0, months)) / 12) * 2) / 2;
  const list = await listAbsences(sql, { employeeId, from: yStart, to: yEnd });
  const inYear = (a: AbsenceRow) => {
    const s = a.start_date < yStart ? yStart : a.start_date;
    const t = a.end_date > yEnd ? yEnd : a.end_date;
    return a.half_day ? 0.5 : workingDays(s, t);
  };
  const taken = list
    .filter((a) => a.kind === 'urlaub' && a.status === 'genehmigt')
    .reduce((s, a) => s + inYear(a), 0);
  const requested = list
    .filter((a) => a.kind === 'urlaub' && a.status === 'beantragt')
    .reduce((s, a) => s + inYear(a), 0);
  return { entitlement, taken, requested, rest: entitlement - taken - requested };
}
