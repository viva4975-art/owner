import type { Sql, Tx } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, holidayName, isoWeekday } from '../domain/time/holidays.js';
import { BusinessError } from './errors.js';

/*
 * Einsatzplanung (Soll) und Zeiterfassung (Ist).
 *
 * Grundsätze:
 * - Uhrzeit beim Stempeln kommt vom Server (nicht vom Handy) → nicht manipulierbar, immer Europe/Berlin.
 * - Jede Stempelung hat eine vom Gerät erzeugte ID → doppelt senden (Funkloch) bucht nur einmal.
 * - „Soll als Ist“ nur mit ausdrücklicher Bestätigung, erst nach Schichtende, höchstens 7 Tage rückwirkend.
 * - Vergessene Stempelung = Nachtrag → Freigabe durch Büro/Objektleitung.
 * - Nichts wird gelöscht; Änderungen nur mit Begründung, protokolliert (DB-Trigger).
 */

export type TimeStatus = 'laeuft' | 'erfasst' | 'beantragt' | 'freigegeben' | 'abgelehnt';
export type TimeSource = 'stempel' | 'soll_bestaetigt' | 'nachtrag' | 'buero';

export const STATUS_LABEL: Record<TimeStatus, string> = {
  laeuft: 'läuft',
  erfasst: 'erfasst',
  beantragt: 'Nachtrag – Freigabe offen',
  freigegeben: 'freigegeben',
  abgelehnt: 'abgelehnt',
};
export const SOURCE_LABEL: Record<TimeSource, string> = {
  stempel: 'Stempeluhr',
  soll_bestaetigt: 'Soll bestätigt',
  nachtrag: 'Nachtrag',
  buero: 'Büro',
};

export interface TimeEntry {
  id: string;
  employee_id: string;
  site_id: string;
  work_date: string;
  start_at: Date;
  end_at: Date | null;
  break_minutes: number;
  source: TimeSource;
  status: TimeStatus;
  via_qr: boolean;
  shift_plan_id: string | null;
  note: string | null;
  recorded_at: Date;
  created_by: string;
  decided_by: string | null;
  decided_at: Date | null;
  version: number;
}

export type TimeEntryRow = TimeEntry & {
  personnel_no: string;
  employee_name: string;
  site_name: string;
  site_no: string;
  gross_minutes: number;
  late: boolean;
};

/** Minuten → "7:30" */
export function hm(minutes: number): string {
  const neg = minutes < 0;
  const m = Math.abs(Math.round(minutes));
  return `${neg ? '-' : ''}${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** Uhrzeit (Berlin) eines Zeitpunkts als "07:30" */
export function clock(d: Date | null): string {
  if (!d) return '–';
  return d.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
}

export const netMinutes = (e: { gross_minutes: number; break_minutes: number }) =>
  e.gross_minutes - e.break_minutes;

/** Hinweise nach ArbZG / MiLoG – Grundlage für die Ampel im Büro. */
export function warningsFor(
  e: Pick<TimeEntryRow, 'gross_minutes' | 'break_minutes' | 'late' | 'status'>,
): string[] {
  const w: string[] = [];
  const gross = e.gross_minutes;
  if (e.status === 'laeuft') {
    if (gross > 12 * 60) w.push('Stempelung läuft seit über 12 Stunden – ausstempeln vergessen?');
    return w;
  }
  if (gross > 9 * 60 && e.break_minutes < 45) w.push('Weniger als 45 Min. Pause bei über 9 Std. (§ 4 ArbZG)');
  else if (gross > 6 * 60 && e.break_minutes < 30)
    w.push('Weniger als 30 Min. Pause bei über 6 Std. (§ 4 ArbZG)');
  if (gross - e.break_minutes > 10 * 60) w.push('Über 10 Std. Arbeitszeit am Tag (§ 3 ArbZG)');
  if (e.late) w.push('Aufgezeichnet nach Ablauf der 7-Tage-Frist (§ 17 MiLoG)');
  return w;
}

/** Gesetzliche Mindestpause als Vorschlag beim Ausstempeln. */
export function suggestedBreak(grossMinutes: number): number {
  if (grossMinutes > 9 * 60) return 45;
  if (grossMinutes > 6 * 60) return 30;
  return 0;
}

const entrySelect = (sql: Sql | Tx) => sql`
  select t.*, e.personnel_no, e.last_name || ', ' || e.first_name as employee_name, s.name as site_name, s.site_no,
         (extract(epoch from (coalesce(t.end_at, now()) - t.start_at)) / 60)::int as gross_minutes,
         t.recorded_at >= ((t.work_date + 8)::timestamp at time zone 'Europe/Berlin') as late
    from app.time_entries t
    join app.employees e on e.id = t.employee_id
    join app.sites s on s.id = t.site_id`;

export async function listEntries(
  sql: Sql,
  f: { from?: string; to?: string; employeeId?: string; siteId?: string; status?: TimeStatus[] } = {},
) {
  return sql<TimeEntryRow[]>`
    ${entrySelect(sql)}
     where ${f.from ? sql`t.work_date >= ${f.from}` : sql`true`}
       and ${f.to ? sql`t.work_date <= ${f.to}` : sql`true`}
       and ${f.employeeId ? sql`t.employee_id = ${f.employeeId}` : sql`true`}
       and ${f.siteId ? sql`t.site_id = ${f.siteId}` : sql`true`}
       and ${f.status?.length ? sql`t.status in ${sql(f.status)}` : sql`true`}
     order by t.work_date desc, t.start_at desc`;
}

export async function getEntry(sql: Sql | Tx, id: string) {
  const [e] = await sql<TimeEntryRow[]>`${entrySelect(sql)} where t.id = ${id}`;
  return e;
}

export async function entryLog(sql: Sql, id: string) {
  return sql<
    {
      at: Date;
      actor: string | null;
      reason: string | null;
      old_row: Partial<TimeEntry> | null;
      new_row: TimeEntry;
    }[]
  >`
    select at, actor, reason, old_row, new_row from app.time_entry_log where entry_id = ${id} order by id`;
}

/** Transaktion mit Akteur und Begründung für das Änderungsprotokoll. */
async function withActor<T>(
  sql: Sql,
  actor: string,
  reason: string | null,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.actor', ${actor}, true), set_config('app.reason', ${reason ?? ''}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

async function assertNoOverlap(
  tx: Tx,
  employeeId: string,
  startSql: unknown,
  endSql: unknown,
  exceptId: string | null,
) {
  const [o] = await tx<{ site_name: string; start_at: Date; end_at: Date | null }[]>`
    select s.name as site_name, t.start_at, t.end_at from app.time_entries t join app.sites s on s.id = t.site_id
     where t.employee_id = ${employeeId} and t.status not in ('abgelehnt')
       and ${exceptId ? tx`t.id <> ${exceptId}` : tx`true`}
       and tstzrange(t.start_at, coalesce(t.end_at, 'infinity')) && tstzrange((${startSql as string}::text)::timestamptz, (${endSql as string}::text)::timestamptz)`;
  if (o) {
    throw new BusinessError(
      `Überschneidet sich mit einer anderen Zeit (${o.site_name}, ${clock(o.start_at)}–${clock(o.end_at)})`,
      'overlap',
      { site: o.site_name, from: clock(o.start_at), to: clock(o.end_at) },
    );
  }
}

async function assertMaySite(sql: Sql | Tx, employeeId: string, siteId: string) {
  const [ok] = await sql`
    select 1 from app.employees e where e.id = ${employeeId} and e.status = 'aktiv'
       and (exists (select 1 from app.employee_sites es where es.employee_id = e.id and es.site_id = ${siteId})
            or exists (select 1 from app.shift_plans p where p.employee_id = e.id and p.site_id = ${siteId}))`;
  if (!ok)
    throw new BusinessError('Diesem Objekt nicht zugeordnet – bitte Objektleitung anrufen', 'not_assigned');
}

// ---------------------------------------------------------------- Stempeln

export async function runningEntry(sql: Sql, employeeId: string) {
  const [e] = await sql<
    TimeEntryRow[]
  >`${entrySelect(sql)} where t.employee_id = ${employeeId} and t.status = 'laeuft'`;
  return e;
}

export async function clockIn(
  sql: Sql,
  p: { id: string; employeeId: string; siteId: string; viaQr: boolean; actor: string },
) {
  return withActor(sql, p.actor, null, async (tx) => {
    const [exists] = await tx`select 1 from app.time_entries where id = ${p.id}`;
    if (exists) return p.id; // gleiche Stempelung erneut gesendet
    await assertMaySite(tx, p.employeeId, p.siteId);
    await tx`select pg_advisory_xact_lock(hashtext(${'clock:' + p.employeeId}))`;
    const [run] = await tx<{ site_name: string; start_at: Date }[]>`
      select s.name as site_name, t.start_at from app.time_entries t join app.sites s on s.id = t.site_id
       where t.employee_id = ${p.employeeId} and t.status = 'laeuft'`;
    if (run) {
      throw new BusinessError(
        `Schon eingestempelt seit ${clock(run.start_at)} (${run.site_name})`,
        'already_running',
        {
          time: clock(run.start_at),
          site: run.site_name,
        },
      );
    }
    await assertNoOverlap(tx, p.employeeId, new Date().toISOString(), 'infinity', null);
    await tx`
      insert into app.time_entries (id, employee_id, site_id, work_date, start_at, source, status, via_qr, created_by)
      values (${p.id}, ${p.employeeId}, ${p.siteId}, (now() at time zone 'Europe/Berlin')::date, date_trunc('minute', now()),
              'stempel', 'laeuft', ${p.viaQr}, ${p.actor})`;
    return p.id;
  });
}

export async function clockOut(
  sql: Sql,
  p: { employeeId: string; breakMinutes: number; actor: string; note?: string | null },
) {
  if (!Number.isInteger(p.breakMinutes) || p.breakMinutes < 0 || p.breakMinutes > 240) {
    throw new BusinessError('Pause ungültig', 'bad_break');
  }
  return withActor(sql, p.actor, null, async (tx) => {
    const [run] = await tx<{ id: string; start_at: Date }[]>`
      select id, start_at from app.time_entries where employee_id = ${p.employeeId} and status = 'laeuft' for update`;
    if (!run) return null; // schon ausgestempelt (z. B. zweimal getippt)
    const minutes = Math.floor((Date.now() - run.start_at.getTime()) / 60000);
    if (minutes > 16 * 60) {
      throw new BusinessError('Stempelung läuft seit über 16 Stunden – bitte im Büro melden', 'too_long');
    }
    if (p.breakMinutes >= Math.max(1, minutes))
      throw new BusinessError('Pause ist länger als die Arbeitszeit', 'bad_break');
    await tx`update app.time_entries
                set end_at = greatest(date_trunc('minute', now()), start_at + interval '1 minute'),
                    break_minutes = ${p.breakMinutes}, status = 'erfasst', note = coalesce(${p.note ?? null}, note)
              where id = ${run.id}`;
    return run.id;
  });
}

// ---------------------------------------------------------------- Einsatzplanung

export interface ShiftPlan {
  id: string;
  employee_id: string;
  site_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  break_minutes: number;
  valid_from: string;
  valid_until: string | null;
  note: string | null;
  version: number;
}
export type ShiftPlanRow = ShiftPlan & {
  employee_name: string;
  personnel_no: string;
  site_name: string;
  site_no: string;
};

export const WEEKDAYS = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
export const WEEKDAYS_SHORT = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

export async function listShiftPlans(
  sql: Sql,
  f: { siteId?: string; employeeId?: string; activeOn?: string } = {},
) {
  return sql<ShiftPlanRow[]>`
    select p.*, to_char(p.start_time, 'HH24:MI') as start_time, to_char(p.end_time, 'HH24:MI') as end_time,
           e.last_name || ', ' || e.first_name as employee_name, e.personnel_no, s.name as site_name, s.site_no
      from app.shift_plans p join app.employees e on e.id = p.employee_id join app.sites s on s.id = p.site_id
     where ${f.siteId ? sql`p.site_id = ${f.siteId}` : sql`true`}
       and ${f.employeeId ? sql`p.employee_id = ${f.employeeId}` : sql`true`}
       and ${f.activeOn ? sql`p.valid_from <= ${f.activeOn} and (p.valid_until is null or p.valid_until >= ${f.activeOn})` : sql`true`}
     order by s.site_no, p.weekday, p.start_time, e.last_name`;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function saveShiftPlan(
  sql: Sql,
  id: string,
  input: {
    employeeId: string;
    siteId: string;
    weekdays: number[];
    startTime: string;
    endTime: string;
    breakMinutes: number;
    validFrom: string;
    validUntil: string | null;
    note: string | null;
  },
  actor: string,
): Promise<string[]> {
  if (!HHMM.test(input.startTime) || !HHMM.test(input.endTime))
    throw new BusinessError('Uhrzeit bitte als HH:MM');
  if (input.endTime <= input.startTime)
    throw new BusinessError('Ende muss nach dem Beginn liegen (Nachtschichten bitte in zwei Einsätzen)');
  if (!input.weekdays.length) throw new BusinessError('Bitte mindestens einen Wochentag wählen');
  if (input.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7))
    throw new BusinessError('Wochentag ungültig');
  if (input.validUntil && input.validUntil < input.validFrom) throw new BusinessError('„bis“ liegt vor „ab“');
  const ids: string[] = [];
  await sql.begin(async (tx) => {
    await assertMaySite(tx, input.employeeId, input.siteId).catch(async () => {
      // Einplanen ordnet zugleich zu
      await tx`insert into app.employee_sites (employee_id, site_id) values (${input.employeeId}, ${input.siteId}) on conflict do nothing`;
    });
    for (const [i, wd] of input.weekdays.entries()) {
      // je Wochentag ein Eintrag; feste IDs aus der Formular-ID → Doppelklick legt nichts doppelt an
      const [{ pid }] =
        (await tx`select ${i === 0 ? tx`${id}::uuid` : tx`md5(${id} || ':' || ${wd})::uuid`} as pid`) as unknown as [
          { pid: string },
        ];
      await tx`
        insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, break_minutes, valid_from, valid_until, note)
        values (${pid}, ${input.employeeId}, ${input.siteId}, ${wd}, ${input.startTime}, ${input.endTime}, ${input.breakMinutes},
                ${input.validFrom}, ${input.validUntil}, ${input.note})
        on conflict (id) do update set employee_id = excluded.employee_id, site_id = excluded.site_id, weekday = excluded.weekday,
          start_time = excluded.start_time, end_time = excluded.end_time, break_minutes = excluded.break_minutes,
          valid_from = excluded.valid_from, valid_until = excluded.valid_until, note = excluded.note, updated_at = now()`;
      ids.push(pid);
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'save', 'shift_plan', ${id}, ${tx.json({ weekdays: input.weekdays })})`;
  });
  return ids;
}

/** Einsatz beenden (bleibt für die Vergangenheit erhalten). */
export async function endShiftPlan(sql: Sql, id: string, lastDay: string, actor: string) {
  const [p] = await sql<{ valid_from: string }[]>`select valid_from from app.shift_plans where id = ${id}`;
  if (!p) throw new BusinessError('Einsatz nicht gefunden');
  if (lastDay < p.valid_from) {
    // noch nie gültig gewesen → ganz entfernen ist unschädlich
    const [used] = await sql`select 1 from app.time_entries where shift_plan_id = ${id}`;
    if (!used) {
      await sql`delete from app.shift_plans where id = ${id}`;
      return;
    }
    lastDay = p.valid_from;
  }
  await sql`update app.shift_plans set valid_until = ${lastDay}, updated_at = now() where id = ${id}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, 'end', 'shift_plan', ${id})`;
}

export interface PlannedShift {
  plan: ShiftPlanRow;
  date: string;
  minutes: number;
  absence: string | null;
  holiday: string | undefined;
  entry: TimeEntryRow | undefined;
}

/** Soll-Einsätze für einen Zeitraum (je Tag), mit Abwesenheiten, Feiertagen und zugehörigen Ist-Zeiten. */
export async function plannedShifts(
  sql: Sql,
  f: { from: string; to: string; employeeId?: string; siteId?: string },
): Promise<PlannedShift[]> {
  // Soll zählt erst ab dem Tag, an dem der Einsatz geplant wurde, und nicht vor dem Eintritt
  // (sonst würden rückwirkend angelegte Einsätze als „fehlende Zeiten“ erscheinen).
  const plans = await sql<(ShiftPlanRow & { effective_from: string })[]>`
    select p.*, to_char(p.start_time, 'HH24:MI') as start_time, to_char(p.end_time, 'HH24:MI') as end_time,
           e.last_name || ', ' || e.first_name as employee_name, e.personnel_no, s.name as site_name, s.site_no,
           greatest(p.valid_from, (p.created_at at time zone 'Europe/Berlin')::date, e.entry_date) as effective_from
      from app.shift_plans p join app.employees e on e.id = p.employee_id join app.sites s on s.id = p.site_id
     where p.valid_from <= ${f.to} and (p.valid_until is null or p.valid_until >= ${f.from}) and e.status = 'aktiv'
       and ${f.employeeId ? sql`p.employee_id = ${f.employeeId}` : sql`true`}
       and ${f.siteId ? sql`p.site_id = ${f.siteId}` : sql`true`}`;
  if (!plans.length) return [];
  const absences = await sql<{ employee_id: string; kind: string; start_date: string; end_date: string }[]>`
    select employee_id, kind::text, start_date, end_date from app.absences
     where status = 'genehmigt' and start_date <= ${f.to} and end_date >= ${f.from}
       and employee_id in ${sql([...new Set(plans.map((p) => p.employee_id))])}`;
  const entries = await listEntries(sql, {
    from: f.from,
    to: f.to,
    ...(f.employeeId ? { employeeId: f.employeeId } : {}),
    ...(f.siteId ? { siteId: f.siteId } : {}),
  });
  const out: PlannedShift[] = [];
  for (let d = f.from; d <= f.to; d = addDays(d, 1)) {
    const wd = isoWeekday(d);
    for (const p of plans) {
      if (p.weekday !== wd || p.effective_from > d || (p.valid_until && p.valid_until < d)) continue;
      const [sh, sm] = p.start_time.split(':').map(Number) as [number, number];
      const [eh, em] = p.end_time.split(':').map(Number) as [number, number];
      const abs = absences.find(
        (a) => a.employee_id === p.employee_id && a.start_date <= d && a.end_date >= d,
      );
      out.push({
        plan: p,
        date: d,
        minutes: eh * 60 + em - (sh * 60 + sm) - p.break_minutes,
        absence: abs?.kind ?? null,
        holiday: holidayName(d),
        entry: entries.find(
          (e) =>
            e.employee_id === p.employee_id &&
            e.site_id === p.site_id &&
            e.work_date === d &&
            e.status !== 'abgelehnt',
        ),
      });
    }
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || a.plan.start_time.localeCompare(b.plan.start_time),
  );
}

// ---------------------------------------------------------------- Soll als Ist, Nachtrag, Büro

/**
 * „Soll als Ist“: Mitarbeiter bestätigt ausdrücklich, dass er den geplanten Einsatz genau so gearbeitet hat.
 * Erst nach Schichtende, höchstens 7 Tage zurück. Feste ID aus Einsatz + Datum → nur einmal möglich.
 */
export async function confirmPlanned(
  sql: Sql,
  p: { employeeId: string; planId: string; date: string; confirmed: boolean; actor: string },
) {
  if (!p.confirmed) throw new BusinessError('Bitte bestätigen, dass die Zeiten stimmen', 'confirm_required');
  const today = todayBerlin();
  if (p.date > today || p.date < addDays(today, -7)) {
    throw new BusinessError('Bestätigen geht nur für die letzten 7 Tage – sonst bitte Nachtrag', 'too_old');
  }
  return withActor(sql, p.actor, null, async (tx) => {
    const [plan] = await tx<ShiftPlan[]>`
      select *, to_char(start_time, 'HH24:MI') as start_time, to_char(end_time, 'HH24:MI') as end_time
        from app.shift_plans where id = ${p.planId} and employee_id = ${p.employeeId}
         and valid_from <= ${p.date} and (valid_until is null or valid_until >= ${p.date})
         and (created_at at time zone 'Europe/Berlin')::date <= ${p.date}`;
    if (!plan || plan.weekday !== isoWeekday(p.date))
      throw new BusinessError('Kein geplanter Einsatz an diesem Tag', 'no_plan');
    const [{ id }] = (await tx`select md5(${p.planId} || ':' || ${p.date})::uuid as id`) as unknown as [
      { id: string },
    ];
    const [exists] = await tx`select 1 from app.time_entries where id = ${id}`;
    if (exists) return id;
    const [{ ended }] = (await tx`
      select ((${p.date}::date + ${plan.end_time}::time) at time zone 'Europe/Berlin') <= now() as ended`) as unknown as [
      { ended: boolean },
    ];
    if (!ended)
      throw new BusinessError('Der Einsatz ist noch nicht zu Ende – bitte danach bestätigen', 'not_ended');
    const start = tx`((${p.date}::date + ${plan.start_time}::time) at time zone 'Europe/Berlin')`;
    const end = tx`((${p.date}::date + ${plan.end_time}::time) at time zone 'Europe/Berlin')`;
    const [{ s, e }] = (await tx`select ${start} as s, ${end} as e`) as unknown as [{ s: Date; e: Date }];
    await assertNoOverlap(tx, p.employeeId, s.toISOString(), e.toISOString(), null);
    await tx`
      insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source, status, shift_plan_id, created_by)
      values (${id}, ${p.employeeId}, ${plan.site_id}, ${p.date}, ${s}, ${e}, ${plan.break_minutes}, 'soll_bestaetigt', 'erfasst',
              ${plan.id}, ${p.actor})`;
    return id;
  });
}

function toRange(date: string, start: string, end: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BusinessError('Datum ungültig', 'bad_date');
  if (!HHMM.test(start) || !HHMM.test(end)) throw new BusinessError('Uhrzeit bitte als HH:MM', 'bad_time');
  // Ende vor Beginn = über Mitternacht
  const endDate = end <= start ? addDays(date, 1) : date;
  return { start: `${date} ${start}`, end: `${endDate} ${end}` };
}

/** Nachtrag (vergessen zu stempeln): Mitarbeiter beantragt, Büro/Objektleitung gibt frei. */
export async function requestCorrection(
  sql: Sql,
  p: {
    id: string;
    employeeId: string;
    siteId: string;
    date: string;
    start: string;
    end: string;
    breakMinutes: number;
    reason: string;
    actor: string;
  },
) {
  if (!p.reason.trim()) throw new BusinessError('Bitte kurz begründen (z. B. Handy leer)', 'reason_required');
  if (p.date > todayBerlin()) throw new BusinessError('Datum liegt in der Zukunft', 'future');
  const r = toRange(p.date, p.start, p.end);
  return withActor(sql, p.actor, p.reason, async (tx) => {
    const [exists] = await tx`select 1 from app.time_entries where id = ${p.id}`;
    if (exists) return p.id;
    await assertMaySite(tx, p.employeeId, p.siteId);
    const [{ s, e }] = (await tx`
      select (${r.start}::timestamp at time zone 'Europe/Berlin') as s, (${r.end}::timestamp at time zone 'Europe/Berlin') as e`) as unknown as [
      { s: Date; e: Date },
    ];
    if (e.getTime() > Date.now()) throw new BusinessError('Ende liegt in der Zukunft', 'future');
    const gross = (e.getTime() - s.getTime()) / 60000;
    if (p.breakMinutes < 0 || p.breakMinutes >= gross) throw new BusinessError('Pause ungültig', 'bad_break');
    await assertNoOverlap(tx, p.employeeId, s.toISOString(), e.toISOString(), null);
    await tx`
      insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source, status, note, created_by)
      values (${p.id}, ${p.employeeId}, ${p.siteId}, ${p.date}, ${s}, ${e}, ${p.breakMinutes}, 'nachtrag', 'beantragt', ${p.reason.trim()}, ${p.actor})`;
    return p.id;
  });
}

export async function decideCorrection(
  sql: Sql,
  id: string,
  approve: boolean,
  actor: string,
  reason: string | null,
) {
  if (!approve && !reason?.trim()) throw new BusinessError('Bitte Ablehnung begründen');
  await withActor(sql, actor, reason, async (tx) => {
    const [e] = await tx<
      { status: TimeStatus }[]
    >`select status from app.time_entries where id = ${id} for update`;
    if (!e) throw new BusinessError('Eintrag nicht gefunden');
    if (e.status !== 'beantragt') return;
    await tx`update app.time_entries set status = ${approve ? 'freigegeben' : 'abgelehnt'}, decided_by = ${actor}, decided_at = now()
              where id = ${id}`;
  });
}

/** Büro erfasst oder korrigiert eine Zeit (immer mit Begründung, protokolliert). */
export async function officeSave(
  sql: Sql,
  p: {
    id: string;
    employeeId: string;
    siteId: string;
    date: string;
    start: string;
    end: string;
    breakMinutes: number;
    reason: string;
    expectedVersion: number | null;
    actor: string;
  },
) {
  if (!p.reason.trim()) throw new BusinessError('Bitte Begründung angeben (wird protokolliert)');
  const r = toRange(p.date, p.start, p.end);
  await withActor(sql, p.actor, p.reason.trim(), async (tx) => {
    const [cur] = await tx<
      { version: number; status: TimeStatus }[]
    >`select version, status from app.time_entries where id = ${p.id} for update`;
    if (cur && p.expectedVersion !== null && cur.version !== p.expectedVersion) {
      throw new BusinessError('Der Eintrag wurde zwischenzeitlich geändert – bitte neu laden.');
    }
    const [{ s, e }] = (await tx`
      select (${r.start}::timestamp at time zone 'Europe/Berlin') as s, (${r.end}::timestamp at time zone 'Europe/Berlin') as e`) as unknown as [
      { s: Date; e: Date },
    ];
    const gross = (e.getTime() - s.getTime()) / 60000;
    if (gross > 16 * 60) throw new BusinessError('Mehr als 16 Stunden am Stück – bitte prüfen');
    if (p.breakMinutes < 0 || p.breakMinutes >= gross) throw new BusinessError('Pause ungültig');
    await assertNoOverlap(tx, p.employeeId, s.toISOString(), e.toISOString(), p.id);
    if (cur) {
      await tx`update app.time_entries set employee_id = ${p.employeeId}, site_id = ${p.siteId}, work_date = ${p.date},
                 start_at = ${s}, end_at = ${e}, break_minutes = ${p.breakMinutes},
                 status = case when status in ('laeuft', 'beantragt', 'abgelehnt') then 'freigegeben'::app.time_status else status end,
                 decided_by = ${p.actor}, decided_at = now()
               where id = ${p.id}`;
    } else {
      await tx`
        insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source, status, note,
                                      created_by, decided_by, decided_at)
        values (${p.id}, ${p.employeeId}, ${p.siteId}, ${p.date}, ${s}, ${e}, ${p.breakMinutes}, 'buero', 'freigegeben',
                ${p.reason.trim()}, ${p.actor}, ${p.actor}, now())`;
    }
  });
}

// ---------------------------------------------------------------- Auswertungen

export interface ReportRow {
  employee_id: string;
  personnel_no: string;
  employee_name: string;
  work_date: string;
  site_name: string;
  start_at: Date;
  end_at: Date;
  break_minutes: number;
  net_minutes: number;
  recorded_at: Date;
  source: TimeSource;
  late: boolean;
}

/**
 * Prüfbericht § 17 MiLoG: je Mitarbeiter und Tag Beginn, Ende, Dauer, Aufzeichnungszeitpunkt.
 * Enthält nur gültige Zeiten (erfasst/freigegeben); offene Nachträge werden separat ausgewiesen.
 */
export async function zollReport(sql: Sql, f: { from: string; to: string; employeeId?: string }) {
  const rows = await sql<ReportRow[]>`
    select t.employee_id, e.personnel_no, e.last_name || ', ' || e.first_name as employee_name, t.work_date, s.name as site_name,
           t.start_at, t.end_at, t.break_minutes,
           (extract(epoch from (t.end_at - t.start_at)) / 60)::int - t.break_minutes as net_minutes,
           t.recorded_at, t.source, t.recorded_at >= ((t.work_date + 8)::timestamp at time zone 'Europe/Berlin') as late
      from app.time_entries t join app.employees e on e.id = t.employee_id join app.sites s on s.id = t.site_id
     where t.status in ('erfasst', 'freigegeben') and t.work_date between ${f.from} and ${f.to}
       and ${f.employeeId ? sql`t.employee_id = ${f.employeeId}` : sql`true`}
     order by e.last_name, e.first_name, t.work_date, t.start_at`;
  const [{ open }] = (await sql`
    select count(*)::int as open from app.time_entries
     where status in ('laeuft', 'beantragt') and work_date between ${f.from} and ${f.to}
       and ${f.employeeId ? sql`employee_id = ${f.employeeId}` : sql`true`}`) as unknown as [
    { open: number },
  ];
  return { rows, open };
}

export function zollCsv(rows: ReportRow[]): string {
  const d = (x: Date) =>
    x.toLocaleDateString('de-DE', {
      timeZone: 'Europe/Berlin',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  const head = [
    'Personalnummer',
    'Name',
    'Datum',
    'Objekt',
    'Beginn',
    'Ende',
    'Pause (Min.)',
    'Dauer (Std.)',
    'Aufgezeichnet am',
    'Art',
  ];
  const lines = rows.map((r) =>
    [
      r.personnel_no,
      r.employee_name,
      r.work_date.split('-').reverse().join('.'),
      r.site_name,
      clock(r.start_at),
      clock(r.end_at),
      String(r.break_minutes),
      hm(r.net_minutes),
      `${d(r.recorded_at)} ${clock(r.recorded_at)}`,
      SOURCE_LABEL[r.source],
    ]
      .map((v) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v))
      .join(';'),
  );
  return '﻿' + [head.join(';'), ...lines].join('\r\n') + '\r\n';
}

export async function getTimeSettings(sql: Sql) {
  const [s] = await sql<
    { min_wage_cents: bigint; min_wage_note: string | null }[]
  >`select min_wage_cents, min_wage_note from app.time_settings`;
  return s!;
}

export async function saveTimeSettings(sql: Sql, minWageCents: bigint, note: string | null, actor: string) {
  if (minWageCents <= 0n) throw new BusinessError('Mindestlohn muss größer 0 sein');
  await sql`update app.time_settings set min_wage_cents = ${minWageCents}, min_wage_note = ${note}`;
  await sql`insert into app.audit_log (actor, action, entity, details) values (${actor}, 'save', 'time_settings', ${sql.json({ min_wage_cents: String(minWageCents) })})`;
}

/** Monatsübersicht je Mitarbeiter: Soll, Ist, Differenz, Lohn-Check. */
export async function monthSummary(sql: Sql, month: string) {
  const from = `${month}-01`;
  const to = addDays(addDays(from, 32).slice(0, 8) + '01', -1);
  const [shifts, entries, settings, emps] = await Promise.all([
    plannedShifts(sql, { from, to }),
    listEntries(sql, { from, to, status: ['erfasst', 'freigegeben'] }),
    getTimeSettings(sql),
    sql<
      {
        id: string;
        name: string;
        personnel_no: string;
        hourly_wage_cents: bigint | null;
        weekly_hours: string | null;
      }[]
    >`
      select id, last_name || ', ' || first_name as name, personnel_no, hourly_wage_cents, weekly_hours::text
        from app.employees where status = 'aktiv' order by last_name, first_name`,
  ]);
  return {
    from,
    to,
    minWage: settings.min_wage_cents,
    rows: emps.map((e) => {
      const soll = shifts
        .filter((s) => s.plan.employee_id === e.id && !s.absence)
        .reduce((a, s) => a + s.minutes, 0);
      const mine = entries.filter((t) => t.employee_id === e.id);
      const ist = mine.reduce((a, t) => a + netMinutes(t), 0);
      const warnings = mine.reduce((a, t) => a + warningsFor(t).length, 0);
      const missing = shifts.filter(
        (s) => s.plan.employee_id === e.id && !s.absence && !s.entry && s.date < todayBerlin(),
      ).length;
      return {
        ...e,
        soll,
        ist,
        warnings,
        missing,
        belowMinWage: e.hourly_wage_cents !== null && e.hourly_wage_cents < settings.min_wage_cents,
      };
    }),
  };
}
