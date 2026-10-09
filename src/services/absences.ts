import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, workingDays } from '../domain/time/holidays.js';
import { BusinessError } from './errors.js';
import { uuidOf } from './fortytools-export-import.js';
import { leaveOpening } from './leave-import.js';
import { plannedShifts } from './time.js';

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

/** Bezahlt nach Art (änderbar je Tag): Urlaub, Krank, Sonstiges bezahlt; unbezahlt frei und Kind krank nicht
 *  (Kinderkrankengeld zahlt die Krankenkasse, § 45 SGB V – außer der Vertrag sieht Fortzahlung nach § 616 BGB vor). */
export const ABSENCE_PAID: Record<AbsenceKind, boolean> = {
  urlaub: true,
  krank: true,
  kind_krank: false,
  unbezahlt: false,
  sonstiges: true,
};

export interface AbsenceHour {
  id: string;
  absence_id: string;
  employee_id: string;
  work_date: string;
  shift_plan_id: string | null;
  site_id: string | null;
  site_name: string | null;
  plan_from: string | null;
  plan_to: string | null;
  minutes: number;
  paid: boolean;
  manual: boolean;
  version: number;
}

/**
 * Genehmigte Abwesenheit auf die geplanten Einsätze übertragen: je Einsatz die geplanten Stunden
 * (halber Tag = Hälfte), bezahlt laut Art. Ohne Einsatzplan: Wochenstunden ÷ 5 je Arbeitstag.
 * Von Hand geänderte Zeilen bleiben; storniert/abgelehnt → Stunden entfallen.
 */
export async function applyAbsenceHours(sql: Sql, absenceId: string) {
  const [a] = await sql<(Absence & { weekly_hours: string | null })[]>`
    select a.*, a.start_date::text, a.end_date::text, e.weekly_hours::text
      from app.absences a join app.employees e on e.id = a.employee_id where a.id = ${absenceId}`;
  if (!a) return 0;
  if (a.status !== 'genehmigt') {
    await sql`delete from app.absence_hours where absence_id = ${absenceId}`;
    return 0;
  }
  const paid = ABSENCE_PAID[a.kind];
  const shifts = (
    await plannedShifts(sql, { from: a.start_date, to: a.end_date, employeeId: a.employee_id })
  ).filter((s) => !s.holiday && s.minutes > 0);
  const rows: Record<string, unknown>[] = [];
  const half = (m: number) => (a.half_day ? Math.round(m / 2) : m);
  if (shifts.length) {
    for (const s of shifts)
      rows.push({
        id: uuidOf(`abs-h:${a.id}:${s.date}:${s.plan.id}`),
        absence_id: a.id,
        employee_id: a.employee_id,
        work_date: s.date,
        shift_plan_id: s.plan.id,
        site_id: s.plan.site_id,
        minutes: half(s.minutes),
        paid,
      });
  } else if (Number(a.weekly_hours) > 0) {
    const perDay = Math.round((Number(a.weekly_hours) * 60) / 5);
    for (let d = a.start_date; d <= a.end_date; d = addDays(d, 1)) {
      if (workingDays(d, d) === 0) continue;
      rows.push({
        id: uuidOf(`abs-h:${a.id}:${d}:-`),
        absence_id: a.id,
        employee_id: a.employee_id,
        work_date: d,
        shift_plan_id: null,
        site_id: null,
        minutes: half(perDay),
        paid,
      });
    }
  }
  if (rows.length) await sql`insert into app.absence_hours ${sql(rows as never)} on conflict do nothing`;
  return rows.length;
}

export async function listAbsenceHours(
  sql: Sql,
  f: { absenceId?: string; employeeId?: string; from?: string; to?: string },
) {
  return sql<AbsenceHour[]>`
    select h.*, h.work_date::text, s.name as site_name,
           to_char(p.start_time, 'HH24:MI') as plan_from, to_char(p.end_time, 'HH24:MI') as plan_to
      from app.absence_hours h
      join app.absences a on a.id = h.absence_id and a.status = 'genehmigt'
      left join app.sites s on s.id = h.site_id
      left join app.shift_plans p on p.id = h.shift_plan_id
     where ${f.absenceId ? sql`h.absence_id = ${f.absenceId}` : sql`true`}
       and ${f.employeeId ? sql`h.employee_id = ${f.employeeId}` : sql`true`}
       and ${f.from ? sql`h.work_date >= ${f.from}` : sql`true`}
       and ${f.to ? sql`h.work_date <= ${f.to}` : sql`true`}
     order by h.work_date, p.start_time nulls last`;
}

/** Büro: Stunden je Tag/Einsatz ändern (z. B. abweichende Stunden, bezahlt/unbezahlt). */
export async function saveAbsenceHours(
  sql: Sql,
  absenceId: string,
  rows: { id: string; minutes: number; paid: boolean }[],
  actor: string,
) {
  for (const r of rows)
    if (!Number.isInteger(r.minutes) || r.minutes < 0 || r.minutes > 960)
      throw new BusinessError('Stunden je Tag zwischen 0 und 16');
  await sql.begin(async (tx) => {
    for (const r of rows)
      await tx`update app.absence_hours set minutes = ${r.minutes}, paid = ${r.paid}, manual = true
                where id = ${r.id} and absence_id = ${absenceId}
                  and (minutes <> ${r.minutes} or paid <> ${r.paid})`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'stunden', 'absence', ${absenceId}, ${tx.json({ rows: rows.length })})`;
  });
}

/** Büro: einen Tag ohne Einsatz von Hand ergänzen (z. B. Urlaub an einem Tag ohne Plan). */
export async function addAbsenceDay(
  sql: Sql,
  absenceId: string,
  p: { date: string; minutes: number; paid: boolean },
) {
  const [a] = await sql<
    Absence[]
  >`select *, start_date::text, end_date::text from app.absences where id = ${absenceId}`;
  if (!a || a.status !== 'genehmigt') throw new BusinessError('Abwesenheit nicht genehmigt');
  if (p.date < a.start_date || p.date > a.end_date) throw new BusinessError('Tag liegt nicht im Zeitraum');
  if (!Number.isInteger(p.minutes) || p.minutes <= 0 || p.minutes > 960)
    throw new BusinessError('Stunden zwischen 0 und 16');
  await sql`insert into app.absence_hours (id, absence_id, employee_id, work_date, minutes, paid, manual)
            values (${uuidOf(`abs-h:${a.id}:${p.date}:-`)}, ${a.id}, ${a.employee_id}, ${p.date}, ${p.minutes}, ${p.paid}, true)
            on conflict do nothing`;
}

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
  if (p.kind === 'urlaub') {
    const [dup] = await sql`select 1 from app.absences where id = ${p.id}`;
    if (!dup) await assertLeaveLeft(sql, p.employeeId, p.start, p.end, p.halfDay, false);
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
  if (p.approved) await applyAbsenceHours(sql, p.id);
}

export async function getAbsence(sql: Sql, id: string) {
  const [a] = await sql<(Absence & { employee_name: string })[]>`
    select a.*, a.start_date::text, a.end_date::text, e.last_name || ', ' || e.first_name as employee_name
      from app.absences a join app.employees e on e.id = a.employee_id where a.id = ${id}`;
  return a;
}

/**
 * Büro ändert eine Abwesenheit (Art, Zeitraum, halber Tag, Notiz). Stunden je Einsatz werden neu berechnet
 * (von Hand geänderte Stunden gehen dabei verloren). Altstand steht im Protokoll.
 */
export async function updateAbsence(
  sql: Sql,
  id: string,
  p: {
    kind: AbsenceKind;
    start: string;
    end: string;
    halfDay: boolean;
    note: string | null;
    expectedVersion: number | null;
  },
  actor: string,
) {
  const a = await getAbsence(sql, id);
  if (!a) throw new BusinessError('Abwesenheit nicht gefunden');
  if (!['beantragt', 'genehmigt'].includes(a.status))
    throw new BusinessError('Abgelehnte oder stornierte Abwesenheiten können nicht geändert werden');
  if (p.expectedVersion !== null && p.expectedVersion !== a.version)
    throw new BusinessError('Die Abwesenheit wurde zwischenzeitlich geändert – bitte neu laden.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.start) || !/^\d{4}-\d{2}-\d{2}$/.test(p.end))
    throw new BusinessError('Datum ungültig');
  if (p.end < p.start) throw new BusinessError('„bis“ liegt vor „von“');
  if (p.halfDay && p.start !== p.end) throw new BusinessError('Halber Tag nur für einen einzelnen Tag');
  if (!(p.kind in ABSENCE_LABEL)) throw new BusinessError('Art ungültig');
  if (p.kind === 'urlaub') {
    // Rest + bisherige Tage dieser Abwesenheit (sie sind im Rest schon abgezogen, falls Urlaub)
    for (let y = Number(p.start.slice(0, 4)); y <= Number(p.end.slice(0, 4)); y++) {
      const clip = (s: string, e: string) =>
        [s > `${y}-01-01` ? s : `${y}-01-01`, e < `${y}-12-31` ? e : `${y}-12-31`] as const;
      const [ns, ne] = clip(p.start, p.end);
      const need = p.halfDay ? 0.5 : workingDays(ns, ne);
      if (!need) continue;
      const [os, oe] = clip(a.start_date, a.end_date);
      const old = a.kind === 'urlaub' && os <= oe ? (a.half_day ? 0.5 : workingDays(os, oe)) : 0;
      const bal = await leaveBalance(sql, a.employee_id, y);
      if (bal.rest + old < need)
        throw new BusinessError(
          `Kein ausreichender Urlaubsanspruch ${y}: Rest ${String(bal.rest + old).replace('.', ',')} Tage, benötigt ${String(need).replace('.', ',')} Tage`,
        );
    }
  }
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${'abs:' + a.employee_id}))`;
    const [overlap] = await tx`
      select 1 from app.absences
       where employee_id = ${a.employee_id} and id <> ${id} and status in ('beantragt', 'genehmigt')
         and start_date <= ${p.end} and end_date >= ${p.start}`;
    if (overlap) throw new BusinessError('Für diesen Zeitraum gibt es schon eine andere Abwesenheit');
    await tx`update app.absences set kind = ${p.kind}, start_date = ${p.start}, end_date = ${p.end},
               half_day = ${p.halfDay}, note = ${p.note} where id = ${id}`;
    await tx`delete from app.absence_hours where absence_id = ${id}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'update', 'absence', ${id},
                     ${tx.json({ vorher: { kind: a.kind, start: a.start_date, end: a.end_date, half_day: a.half_day, note: a.note } })})`;
  });
  await applyAbsenceHours(sql, id);
}

/** Büro löscht eine falsch erfasste Abwesenheit ganz (samt Stunden je Einsatz). Inhalt steht im Protokoll. */
export async function deleteAbsence(sql: Sql, id: string, actor: string) {
  const a = await getAbsence(sql, id);
  if (!a) return;
  await sql.begin(async (tx) => {
    await tx`delete from app.absence_hours where absence_id = ${id}`;
    await tx`delete from app.absences where id = ${id}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'delete', 'absence', ${id},
                     ${tx.json({ employee_id: a.employee_id, kind: a.kind, start: a.start_date, end: a.end_date, half_day: a.half_day, status: a.status, note: a.note })})`;
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
  // Genehmigen nur mit ausreichendem Urlaubsanspruch (der Antrag ist im Rest schon als „beantragt“ abgezogen)
  if (status === 'genehmigt' && a.kind === 'urlaub')
    await assertLeaveLeft(sql, a.employee_id, a.start_date, a.end_date, a.half_day, true);
  if (!allowed[a.status].includes(status))
    throw new BusinessError(
      `„${ABSENCE_STATUS_LABEL[a.status]}“ kann nicht zu „${ABSENCE_STATUS_LABEL[status]}“ werden`,
    );
  await sql`update app.absences set status = ${status}, decided_by = ${actor}, decided_at = now() where id = ${id} and status = ${a.status}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details) values (${actor}, 'status', 'absence', ${id}, ${sql.json({ status })})`;
  await applyAbsenceHours(sql, id);
}

/**
 * Urlaub nur mit Anspruch: je betroffenem Jahr Rest (Anspruch + Übertrag − genommen − beantragt) ≥ beantragte Tage.
 * `included` = der Antrag ist im Rest schon als „beantragt“ enthalten (beim Genehmigen).
 */
export async function assertLeaveLeft(
  sql: Sql,
  employeeId: string,
  start: string,
  end: string,
  halfDay: boolean,
  included: boolean,
) {
  for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) {
    const s = start > `${y}-01-01` ? start : `${y}-01-01`;
    const t = end < `${y}-12-31` ? end : `${y}-12-31`;
    const days = halfDay ? 0.5 : workingDays(s, t);
    if (!days) continue;
    const bal = await leaveBalance(sql, employeeId, y);
    const left = bal.rest + (included ? days : 0);
    if (left < days)
      throw new BusinessError(
        `Kein ausreichender Urlaubsanspruch ${y}: Rest ${String(left).replace('.', ',')} Tage, beantragt ${String(days).replace('.', ',')} Tage`,
        'no_leave',
        { rest: String(left).replace('.', ','), days: String(days).replace('.', ',') },
      );
  }
}

/** Urlaubskonto im Kalenderjahr: Anspruch (anteilig bei Ein-/Austritt), genommen, beantragt, Rest. */
export interface LeaveBalance {
  entitlement: number;
  taken: number;
  requested: number;
  rest: number;
  /** Resturlaub aus dem Vorjahr (nur bei „Resturlaub übertragen“) */
  carried: number;
  /** davon zum 31.03. verfallen (nicht bis dahin genommen) */
  carriedExpired: number;
  /** Stand aus Fortytools übernommen (Stichtag); eigene Abwesenheiten zählen erst danach */
  openingAsOf?: string;
}

/**
 * Urlaubskonto eines Jahres. Resturlaub des Vorjahres wird übertragen und vorrangig bis 31.03. verbraucht; der Rest
 * verfällt danach (§ 7 Abs. 3 BUrlG). ACHTUNG (BAG 19.02.2019, 9 AZR 541/15): Verfall nur, wenn der Arbeitgeber
 * rechtzeitig zum Urlaub aufgefordert und auf den Verfall hingewiesen hat – die Anzeige ist nur ein Rechenwert.
 */
export async function leaveBalance(sql: Sql, employeeId: string, year: number): Promise<LeaveBalance> {
  const op = await leaveOpening(sql, employeeId, year);
  if (op && op.taken != null) {
    // Stand aus Fortytools: Anspruch/Resturlaub/genommen bis Stichtag, verfallener Rest so wie dort gerechnet
    const after = await baseBalance(sql, employeeId, year, addDays(op.as_of, 1));
    const entitlement = op.entitlement ?? after.entitlement;
    const carried = op.carried ?? 0;
    const expired = op.available != null ? Math.max(0, carried + entitlement - op.taken - op.available) : 0;
    const taken = op.taken + after.taken;
    return {
      entitlement,
      taken,
      requested: after.requested,
      rest: entitlement + carried - expired - taken - after.requested,
      carried,
      carriedExpired: expired,
      openingAsOf: op.as_of,
    };
  }
  const base = await baseBalance(sql, employeeId, year);
  const [e] = await sql<{ carry_over_leave: boolean; entry_date: string }[]>`
    select carry_over_leave, entry_date from app.employees where id = ${employeeId}`;
  let carried = 0;
  if (e?.carry_over_leave && e.entry_date < `${year}-01-01`) {
    const pop = await leaveOpening(sql, employeeId, year - 1);
    if (pop && pop.taken != null) {
      const after = await baseBalance(sql, employeeId, year - 1, addDays(pop.as_of, 1));
      carried = Math.max(0, (pop.entitlement ?? after.entitlement) - pop.taken - after.taken);
    } else {
      const prev = await baseBalance(sql, employeeId, year - 1);
      carried = Math.max(0, prev.entitlement - prev.taken);
    }
  }
  // im 1. Quartal genommener Urlaub verbraucht zuerst den Übertrag
  const q1 = base.takenQ1;
  const usedCarry = Math.min(carried, q1);
  const expired = todayBerlin() > `${year}-03-31` ? carried - usedCarry : 0;
  const rest = base.entitlement + carried - expired - base.taken - base.requested;
  return {
    entitlement: base.entitlement,
    taken: base.taken,
    requested: base.requested,
    rest,
    carried,
    carriedExpired: expired,
  };
}

/** `countFrom`: Abwesenheiten erst ab diesem Tag zählen (nach einem übernommenen Stand) */
async function baseBalance(sql: Sql, employeeId: string, year: number, countFrom?: string) {
  const [e] = await sql<{ annual_leave_days: string; entry_date: string; exit_date: string | null }[]>`
    select annual_leave_days::text, entry_date, exit_date from app.employees where id = ${employeeId}`;
  if (!e) throw new BusinessError('Mitarbeiter nicht gefunden');
  const yStart0 = `${year}-01-01`;
  const yEnd = `${year}-12-31`;
  const from = e.entry_date > yStart0 ? e.entry_date : yStart0;
  const to = e.exit_date && e.exit_date < yEnd ? e.exit_date : yEnd;
  // anteilig: volle Beschäftigungsmonate (§ 5 BUrlG vereinfacht), auf halbe Tage gerundet
  const months =
    from > to ? 0 : Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1 - (from.slice(8) !== '01' ? 1 : 0);
  const full = Number(e.annual_leave_days);
  const entitlement =
    from === yStart0 && to === yEnd ? full : Math.round(((full * Math.max(0, months)) / 12) * 2) / 2;
  const yStart = countFrom && countFrom > yStart0 ? countFrom : yStart0;
  if (yStart > yEnd) return { entitlement, taken: 0, requested: 0, takenQ1: 0 };
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
  const takenQ1 = list
    .filter((a) => a.kind === 'urlaub' && a.status === 'genehmigt' && a.start_date <= `${year}-03-31`)
    .reduce((sum, a) => {
      const st = a.start_date < yStart ? yStart : a.start_date;
      const t = a.end_date > `${year}-03-31` ? `${year}-03-31` : a.end_date;
      return sum + (a.half_day ? 0.5 : workingDays(st, t));
    }, 0);
  return { entitlement, taken, requested, takenQ1 };
}

export interface AbsentNow {
  employee_id: string;
  name: string;
  kind: AbsenceKind;
  start_date: string;
  end_date: string;
  half_day: boolean;
  sites: string[];
}

type Frag = ReturnType<Sql>;

/**
 * Objektleitung: Ist die Person im Zeitraum an einem ihrer Objekte eingeplant (wiederkehrender Einsatz oder
 * Vertretung)? Grundlage für Abwesenheiten – Krankheit/Urlaub nur von Leuten, die bei ihr eingeplant sind, nicht von
 * allen, die irgendwann dem Objekt zugeordnet wurden (Ahmed 09.10.).
 */
export const plannedAtSites = (sql: Sql, emp: Frag, siteIds: string[], from: Frag | string, to: Frag | string) =>
  sql`(exists (select 1 from app.shift_plans p
                where p.employee_id = ${emp} and p.site_id = any(${siteIds}::uuid[])
                  and p.valid_from <= ${to}::date and (p.valid_until is null or p.valid_until >= ${from}::date))
       or exists (select 1 from app.shift_exceptions x join app.shift_plans p on p.id = x.shift_plan_id
                   where x.substitute_employee_id = ${emp} and p.site_id = any(${siteIds}::uuid[])
                     and x.work_date between ${from}::date and ${to}::date))`;

/**
 * Abwesend im Zeitraum (genehmigt) – für „heute abwesend“ und „demnächst“ (z. B. Urlaub eine Woche vorher). Mit den
 * Objekten der Person; `siteIds` begrenzt auf Mitarbeitende, die während der Abwesenheit an diesen Objekten eingeplant
 * sind (Objektleitung: nur eigene Leute, Objekte nur die eigenen).
 * Art wird angezeigt (auch „krank“ – Vorgesetzte dürfen die Arbeitsunfähigkeit kennen, die Diagnose wird nie erfasst).
 */
export async function absentBetween(sql: Sql, from: string, to: string, siteIds: string[] | null) {
  const sites =
    siteIds === null
      ? sql`coalesce((select array_agg(s.name order by s.name) from app.employee_sites es
                       join app.sites s on s.id = es.site_id where es.employee_id = e.id), '{}')`
      : sql`coalesce((select array_agg(distinct s.name) from app.shift_plans p join app.sites s on s.id = p.site_id
                       where p.employee_id = e.id and p.site_id = any(${siteIds}::uuid[])
                         and p.valid_from <= least(a.end_date, ${to}::date)
                         and (p.valid_until is null or p.valid_until >= greatest(a.start_date, ${from}::date))), '{}')`;
  return sql<AbsentNow[]>`
    select a.employee_id, e.first_name || ' ' || e.last_name as name, a.kind, a.start_date::text,
           a.end_date::text, a.half_day, ${sites} as sites
      from app.absences a join app.employees e on e.id = a.employee_id
     where a.status = 'genehmigt' and a.start_date <= ${to} and a.end_date >= ${from}
       and ${
         siteIds === null
           ? sql`true`
           : plannedAtSites(
               sql,
               sql`e.id`,
               siteIds,
               sql`greatest(a.start_date, ${from}::date)`,
               sql`least(a.end_date, ${to}::date)`,
             )
       }
     order by a.start_date, e.last_name`;
}

/** Wer ist am Tag abwesend (genehmigt)? */
export const absentOn = (sql: Sql, day: string, siteIds: string[] | null) =>
  absentBetween(sql, day, day, siteIds);
