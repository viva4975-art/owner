import { type GeoStatus, judgePosition } from '../domain/time/geo.js';
import type { Sql, Tx } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, holidayName, isoWeekday, mondayOf } from '../domain/time/holidays.js';
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
  abgelehnt: 'abgelehnt / entfernt',
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
  /** Beginn der Pause (Ende = Beginn + break_minutes) */
  break_start_at: Date | null;
  /** true = automatisch gesetzt, vom Mitarbeiter nicht geändert */
  break_auto: boolean;
  source: TimeSource;
  status: TimeStatus;
  via_qr: boolean;
  /** Standort beim Ein-/Ausstempeln (nur Bewertung + Entfernung, keine Koordinaten) */
  start_geo?: GeoStatus | null;
  start_geo_m?: number | null;
  start_geo_acc_m?: number | null;
  end_geo?: GeoStatus | null;
  end_geo_m?: number | null;
  end_geo_acc_m?: number | null;
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

/** Pause beginnt automatisch nach 4 Std. Arbeit (Pflicht spätestens nach 6 Std., § 4 ArbZG). */
export const BREAK_AFTER_MINUTES = 240;

/** Automatische Pause: gesetzliche Mindestdauer, Beginn nach 4 Std. */
export function autoBreak(startAt: Date, grossMinutes: number): { minutes: number; start: Date | null } {
  const minutes = suggestedBreak(grossMinutes);
  return minutes
    ? { minutes, start: new Date(startAt.getTime() + BREAK_AFTER_MINUTES * 60000) }
    : { minutes: 0, start: null };
}

/** Pausenbeginn nach 4 Std., höchstens so spät, dass die Pause vor dem Ende liegt. */
export function placeBreak(start: Date, end: Date, minutes: number): Date | null {
  if (!minutes) return null;
  const latest = end.getTime() - minutes * 60000;
  return new Date(Math.max(start.getTime(), Math.min(start.getTime() + BREAK_AFTER_MINUTES * 60000, latest)));
}

/** Lage der Pause für Anzeige/Stundenzettel (gespeichert oder – bei alten Einträgen – nach 4 Std.). */
export function breakRange(
  e: Pick<TimeEntry, 'start_at' | 'end_at' | 'break_minutes'> & { break_start_at?: Date | null },
) {
  if (!e.break_minutes) return null;
  const from =
    e.break_start_at ??
    placeBreak(e.start_at, e.end_at ?? new Date(e.start_at.getTime() + 24 * 3600e3), e.break_minutes)!;
  return { from, to: new Date(from.getTime() + e.break_minutes * 60000) };
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
            or exists (select 1 from app.shift_plans p where p.employee_id = e.id and p.site_id = ${siteId})
            or exists (select 1 from app.shift_exceptions x join app.shift_plans p on p.id = x.shift_plan_id
                        where x.substitute_employee_id = e.id and p.site_id = ${siteId} and x.kind <> 'ausfall'
                          and x.work_date between (now() at time zone 'Europe/Berlin')::date - 7
                                              and (now() at time zone 'Europe/Berlin')::date + 1))`;
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

/** Position beim Stempeln: undefined = nicht geprüft, null = Gerät lieferte keinen Standort */
export type GeoInput = { lat: number; lng: number; acc: number } | null | undefined;

/**
 * Standort bewerten (nur wenn unter Zeiterfassung → Einstellungen eingeschaltet) und nur Ergebnis + Entfernung speichern.
 * Stempeln wird nie verweigert – das Büro sieht „nicht am Objekt“ und klärt es.
 */
async function recordGeo(
  tx: Sql | Tx,
  entryId: string,
  siteId: string,
  which: 'start' | 'end',
  geo: GeoInput,
) {
  if (geo === undefined) return;
  const [cfg] = await tx<{ geo_check: boolean }[]>`select geo_check from app.time_settings`;
  if (!cfg?.geo_check) return;
  const [site] = await tx<{ lat: string | null; lng: string | null; radius: number }[]>`
    select geo_lat::text as lat, geo_lng::text as lng, geo_radius_m as radius from app.sites where id = ${siteId}`;
  const j = judgePosition(
    {
      lat: site?.lat != null ? Number(site.lat) : null,
      lng: site?.lng != null ? Number(site.lng) : null,
      radius: site?.radius ?? 250,
    },
    geo,
  );
  if (which === 'start')
    await tx`update app.time_entries set start_geo = ${j.status}, start_geo_m = ${j.distance}, start_geo_acc_m = ${j.accuracy}
              where id = ${entryId}`;
  else
    await tx`update app.time_entries set end_geo = ${j.status}, end_geo_m = ${j.distance}, end_geo_acc_m = ${j.accuracy}
              where id = ${entryId}`;
}

export async function geoCheckEnabled(sql: Sql) {
  const [cfg] = await sql<{ geo_check: boolean }[]>`select geo_check from app.time_settings`;
  return !!cfg?.geo_check;
}

export async function clockIn(
  sql: Sql,
  p: { id: string; employeeId: string; siteId: string; viaQr: boolean; actor: string; geo?: GeoInput },
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
    await recordGeo(tx, p.id, p.siteId, 'start', p.geo);
    return p.id;
  });
}

export async function clockOut(
  sql: Sql,
  p: {
    employeeId: string;
    /** null = automatische Pause (bzw. die vorher in der App geänderte Pause) */
    breakMinutes: number | null;
    actor: string;
    note?: string | null;
    geo?: GeoInput;
  },
) {
  if (
    p.breakMinutes !== null &&
    (!Number.isInteger(p.breakMinutes) || p.breakMinutes < 0 || p.breakMinutes > 240)
  ) {
    throw new BusinessError('Pause ungültig', 'bad_break');
  }
  return withActor(sql, p.actor, null, async (tx) => {
    const [run] = await tx<
      {
        id: string;
        site_id: string;
        start_at: Date;
        break_minutes: number;
        break_start_at: Date | null;
        break_auto: boolean;
      }[]
    >`
      select id, site_id, start_at, break_minutes, break_start_at, break_auto from app.time_entries
       where employee_id = ${p.employeeId} and status = 'laeuft' for update`;
    if (!run) return null; // schon ausgestempelt (z. B. zweimal getippt)
    const minutes = Math.floor((Date.now() - run.start_at.getTime()) / 60000);
    if (minutes > 16 * 60) {
      throw new BusinessError('Stempelung läuft seit über 16 Stunden – bitte im Büro melden', 'too_long');
    }
    let brk: { minutes: number; start: Date | null; auto: boolean };
    if (p.breakMinutes !== null) {
      brk = {
        minutes: p.breakMinutes,
        start: p.breakMinutes ? autoBreak(run.start_at, 24 * 60).start : null,
        auto: false,
      };
    } else if (run.break_start_at && !run.break_auto) {
      // vom Mitarbeiter in der App geändert („später Pause“) → so übernehmen
      brk = { minutes: run.break_minutes, start: run.break_start_at, auto: false };
    } else {
      // nicht geändert → gesetzliche Pause automatisch, Beginn nach 4 Std.
      const a = autoBreak(run.start_at, minutes);
      brk = { ...a, auto: true };
    }
    // Pause, die nach dem Ende läge, wird ans Ende gelegt (z. B. früher gegangen)
    if (brk.start && brk.minutes) {
      const latest = run.start_at.getTime() + Math.max(0, minutes - brk.minutes) * 60000;
      if (brk.start.getTime() > latest) brk.start = new Date(latest);
    }
    if (brk.minutes && brk.minutes >= Math.max(1, minutes))
      throw new BusinessError('Pause ist länger als die Arbeitszeit', 'bad_break');
    await tx`update app.time_entries
                set end_at = greatest(date_trunc('minute', now()), start_at + interval '1 minute'),
                    break_minutes = ${brk.minutes}, break_start_at = ${brk.minutes ? brk.start : null},
                    break_auto = ${brk.auto}, status = 'erfasst', note = coalesce(${p.note ?? null}, note)
              where id = ${run.id}`;
    await recordGeo(tx, run.id, run.site_id, 'end', p.geo);
    return run.id;
  });
}

/** Mitarbeiter verschiebt/ändert die Pause der laufenden Stempelung („ich mache später Pause“). */
export async function setRunningBreak(
  sql: Sql,
  p: { employeeId: string; start: string; minutes: number; actor: string },
) {
  if (!HHMM.test(p.start)) throw new BusinessError('Uhrzeit bitte als HH:MM', 'bad_time');
  if (!Number.isInteger(p.minutes) || p.minutes < 0 || p.minutes > 240)
    throw new BusinessError('Pause ungültig', 'bad_break');
  return withActor(sql, p.actor, 'Pause in der App geändert', async (tx) => {
    const [run] = await tx<{ id: string; work_date: string; start_at: Date }[]>`
      select id, work_date::text, start_at from app.time_entries
       where employee_id = ${p.employeeId} and status = 'laeuft' for update`;
    if (!run) throw new BusinessError('Nicht eingestempelt', 'not_running');
    const [{ at }] = (await tx`
      select ((${run.work_date}::date + ${p.start}::time) at time zone 'Europe/Berlin') as at`) as unknown as [
      { at: Date },
    ];
    // Pause über Mitternacht bzw. vor Arbeitsbeginn → am Folgetag bzw. ungültig
    const start = at < run.start_at ? new Date(at.getTime() + 864e5) : at;
    if (start.getTime() - run.start_at.getTime() > 16 * 3600e3)
      throw new BusinessError('Pausenbeginn liegt nicht in der Arbeitszeit', 'bad_break');
    await tx`update app.time_entries set break_minutes = ${p.minutes},
               break_start_at = ${p.minutes ? start : null}, break_auto = false where id = ${run.id}`;
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
  recurrence?: Recurrence;
  every?: number;
  months?: number[] | null;
  series_id?: string | null;
  planning_group?: string | null;
  /** auch an Sonn- und Feiertagen (Zuschläge); sonst ist der Feiertag frei (bezahlt) */
  holiday_work?: boolean;
}
export type Recurrence = 'einmalig' | 'woechentlich' | 'monatlich';
export const RECURRENCE: Record<Recurrence, string> = {
  einmalig: 'Einmalig',
  woechentlich: 'Wöchentlich',
  monatlich: 'Monatlich',
};
export const MONTHS_SHORT = [
  '',
  'Jan',
  'Feb',
  'Mär',
  'Apr',
  'Mai',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Okt',
  'Nov',
  'Dez',
];

/** Findet der (wiederkehrende) Einsatz an diesem Tag statt? Gültigkeit wird vom Aufrufer geprüft. */
export function occursOn(
  p: Pick<ShiftPlan, 'weekday' | 'valid_from' | 'recurrence' | 'every' | 'months'>,
  d: string,
): boolean {
  const rec = p.recurrence ?? 'woechentlich';
  const every = p.every ?? 1;
  if (p.months?.length && !p.months.includes(Number(d.slice(5, 7)))) return false;
  if (rec === 'einmalig') return d === p.valid_from;
  if (rec === 'monatlich') {
    if (d.slice(8, 10) !== p.valid_from.slice(8, 10)) return false;
    const m =
      (Number(d.slice(0, 4)) - Number(p.valid_from.slice(0, 4))) * 12 +
      Number(d.slice(5, 7)) -
      Number(p.valid_from.slice(5, 7));
    return m >= 0 && m % every === 0;
  }
  if (p.weekday !== isoWeekday(d)) return false;
  if (every === 1) return true;
  const weeks = Math.round((Date.parse(mondayOf(d)) - Date.parse(mondayOf(p.valid_from))) / (7 * 86_400_000));
  return weeks >= 0 && weeks % every === 0;
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
    /** null = offen („zu planender Einsatz“) */
    employeeId: string | null;
    siteId: string;
    weekdays: number[];
    startTime: string;
    endTime: string;
    breakMinutes: number;
    validFrom: string;
    validUntil: string | null;
    note: string | null;
    recurrence?: Recurrence;
    every?: number;
    months?: number[] | null;
    seriesId?: string | null;
    planningGroup?: string | null;
    holidayWork?: boolean;
  },
  actor: string,
): Promise<string[]> {
  const recurrence = input.recurrence ?? 'woechentlich';
  if (!(recurrence in RECURRENCE)) throw new BusinessError('Wiederholung ungültig');
  const every = input.every ?? 1;
  if (!Number.isInteger(every) || every < 1 || every > 12) throw new BusinessError('Intervall ungültig');
  const months = input.months?.length ? [...new Set(input.months)].sort((a, b) => a - b) : null;
  if (months?.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) throw new BusinessError('Monat ungültig');
  if (recurrence !== 'woechentlich') {
    // einmalig / monatlich: Tag ergibt sich aus dem Datum
    input = { ...input, weekdays: [isoWeekday(input.validFrom)] };
    if (recurrence === 'einmalig') input = { ...input, validUntil: input.validFrom };
  }
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
    if (input.employeeId) {
      const emp = input.employeeId;
      await assertMaySite(tx, emp, input.siteId).catch(async () => {
        // Einplanen ordnet zugleich zu
        await tx`insert into app.employee_sites (employee_id, site_id) values (${emp}, ${input.siteId}) on conflict do nothing`;
      });
    }
    for (const [i, wd] of input.weekdays.entries()) {
      // je Wochentag ein Eintrag; feste IDs aus der Formular-ID → Doppelklick legt nichts doppelt an
      const [{ pid }] =
        (await tx`select ${i === 0 ? tx`${id}::uuid` : tx`md5(${id} || ':' || ${wd})::uuid`} as pid`) as unknown as [
          { pid: string },
        ];
      await tx`
        insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, break_minutes, valid_from, valid_until,
                                     note, recurrence, every, months, series_id, planning_group, holiday_work)
        values (${pid}, ${input.employeeId}, ${input.siteId}, ${wd}, ${input.startTime}, ${input.endTime}, ${input.breakMinutes},
                ${input.validFrom}, ${input.validUntil}, ${input.note}, ${recurrence}, ${every}, ${months},
                ${input.seriesId ?? id}, ${input.planningGroup?.trim() || null}, ${!!input.holidayWork || wd === 7})
        on conflict (id) do update set employee_id = excluded.employee_id, site_id = excluded.site_id, weekday = excluded.weekday,
          start_time = excluded.start_time, end_time = excluded.end_time, break_minutes = excluded.break_minutes,
          valid_from = excluded.valid_from, valid_until = excluded.valid_until, note = excluded.note,
          recurrence = excluded.recurrence, every = excluded.every, months = excluded.months,
          series_id = excluded.series_id, planning_group = excluded.planning_group,
          holiday_work = excluded.holiday_work, updated_at = now()`;
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

/**
 * Einsatz (wiederkehrende Planung) ganz löschen – nur solange noch keine Zeit dazu erfasst ist (§ 17 MiLoG: erfasste
 * Zeiten bleiben unverändert). Tagesausnahmen und daraus berechnete Abwesenheitsstunden werden mit entfernt
 * (Abwesenheitsstunden des Tages zählen danach nach Wochenstunden). Der alte Stand steht im Protokoll.
 */
/**
 * Einsätze löschen (Ahmed 08.10.: „einfacher löschen, vom Import stimmt vieles nicht“). Erfasste Zeiten bleiben
 * immer erhalten (§ 17 MiLoG) – nur ihre Verknüpfung zum Einsatz wird gelöst (Änderungsprotokoll). Tagesausnahmen
 * entfallen, Abwesenheitsstunden verlieren nur die Verknüpfung. Alter Stand im Protokoll.
 */
export async function deleteShiftPlans(sql: Sql, ids: string[], actor: string) {
  if (!ids.length) return 0;
  return sql.begin(async (tx) => {
    await tx`select set_config('app.actor', ${actor}, true), set_config('app.reason', 'Einsatz gelöscht', true)`;
    const old = await tx`select * from app.shift_plans where id in ${tx(ids)} for update`;
    await tx`update app.time_entries set shift_plan_id = null where shift_plan_id in ${tx(ids)}`;
    await tx`delete from app.shift_exceptions where shift_plan_id in ${tx(ids)}`;
    await tx`update app.absence_hours set shift_plan_id = null where shift_plan_id in ${tx(ids)}`;
    await tx`delete from app.shift_plans where id in ${tx(ids)}`;
    for (const o of old)
      await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
               values (${actor}, 'delete', 'shift_plan', ${o.id as string}, ${tx.json(o as never)})`;
    return old.length;
  });
}

export interface PlannedShift {
  plan: ShiftPlanRow;
  date: string;
  minutes: number;
  absence: string | null;
  holiday: string | undefined;
  entry: TimeEntryRow | undefined;
  /** Tagesausnahme (Ausfall, Vertretung, umgeplant); bei Vertretung ist plan.employee_* der Vertreter */
  exception?: {
    id: string;
    kind: 'ausfall' | 'vertretung' | 'umgeplant';
    note: string | null;
    original: string;
    version: number;
  };
}

interface ShiftException {
  id: string;
  shift_plan_id: string;
  work_date: string;
  kind: 'ausfall' | 'vertretung' | 'umgeplant';
  substitute_employee_id: string | null;
  substitute_name: string | null;
  substitute_no: string | null;
  start_time: string | null;
  end_time: string | null;
  note: string | null;
  version: number;
}

/** Soll-Einsätze für einen Zeitraum (je Tag), mit Abwesenheiten, Feiertagen und zugehörigen Ist-Zeiten. */
export async function plannedShifts(
  sql: Sql,
  f: {
    from: string;
    to: string;
    employeeId?: string;
    siteId?: string;
    includeCancelled?: boolean;
    /** auch Einsätze ohne Mitarbeiter („zu planende Einsätze“) – nur für die Planungstafel */
    includeOpen?: boolean;
  },
): Promise<PlannedShift[]> {
  // Vertretungen: Einsätze anderer Mitarbeiter, die dieser Mitarbeiter übernimmt
  const subPlans = f.employeeId
    ? (
        await sql<{ id: string }[]>`
          select distinct shift_plan_id as id from app.shift_exceptions
           where substitute_employee_id = ${f.employeeId} and work_date between ${f.from} and ${f.to}`
      ).map((r) => r.id)
    : [];
  // Soll zählt erst ab dem Tag, an dem der Einsatz geplant wurde, und nicht vor dem Eintritt
  // (sonst würden rückwirkend angelegte Einsätze als „fehlende Zeiten“ erscheinen).
  const plans = await sql<(ShiftPlanRow & { effective_from: string; emp_exit: string | null })[]>`
    select p.*, e.exit_date as emp_exit, to_char(p.start_time, 'HH24:MI') as start_time, to_char(p.end_time, 'HH24:MI') as end_time,
           coalesce(e.last_name || ', ' || e.first_name, 'offen') as employee_name, coalesce(e.personnel_no, '') as personnel_no,
           s.name as site_name, s.site_no,
           ${
             f.includeOpen
               ? sql`p.valid_from`
               : sql`greatest(p.valid_from, (p.created_at at time zone 'Europe/Berlin')::date, e.entry_date)`
           } as effective_from
      from app.shift_plans p left join app.employees e on e.id = p.employee_id join app.sites s on s.id = p.site_id
     where p.valid_from <= ${f.to} and (p.valid_until is null or p.valid_until >= ${f.from})
       -- Ausgetretene: Einsätze bis zum Austrittstag bleiben sichtbar (Soll/Ist früherer Monate)
       and ${
         f.includeOpen
           ? sql`(p.employee_id is null or e.status = 'aktiv' or e.exit_date >= ${f.from})`
           : sql`(e.status = 'aktiv' or e.exit_date >= ${f.from})`
       }
       and ${
         f.employeeId
           ? subPlans.length
             ? sql`(p.employee_id = ${f.employeeId} or p.id in ${sql(subPlans)})`
             : sql`p.employee_id = ${f.employeeId}`
           : sql`true`
       }
       and ${f.siteId ? sql`p.site_id = ${f.siteId}` : sql`true`}`;
  if (!plans.length) return [];
  const exceptions = await sql<ShiftException[]>`
    select x.id, x.shift_plan_id, x.work_date, x.kind::text as kind, x.substitute_employee_id, x.note, x.version,
           to_char(x.start_time, 'HH24:MI') as start_time, to_char(x.end_time, 'HH24:MI') as end_time,
           e.last_name || ', ' || e.first_name as substitute_name, e.personnel_no as substitute_no
      from app.shift_exceptions x left join app.employees e on e.id = x.substitute_employee_id
     where x.shift_plan_id in ${sql(plans.map((p) => p.id))} and x.work_date between ${f.from} and ${f.to}`;
  const exOf = (planId: string, d: string) =>
    exceptions.find((x) => x.shift_plan_id === planId && x.work_date === d);
  const people = [
    ...new Set([
      ...plans.map((p) => p.employee_id).filter((x): x is string => !!x),
      ...exceptions.map((x) => x.substitute_employee_id).filter((x): x is string => !!x),
    ]),
  ];
  const absences = await sql<{ employee_id: string; kind: string; start_date: string; end_date: string }[]>`
    select employee_id, kind::text, start_date, end_date from app.absences
     where status = 'genehmigt' and start_date <= ${f.to} and end_date >= ${f.from}
       and employee_id in ${sql(people)}`;
  const entries = await listEntries(sql, {
    from: f.from,
    to: f.to,
    ...(f.employeeId ? { employeeId: f.employeeId } : {}),
    ...(f.siteId ? { siteId: f.siteId } : {}),
  });
  const out: PlannedShift[] = [];
  for (let d = f.from; d <= f.to; d = addDays(d, 1)) {
    for (const p0 of plans) {
      if (p0.effective_from > d || (p0.valid_until && p0.valid_until < d) || !occursOn(p0, d)) continue;
      if (p0.emp_exit && p0.emp_exit < d) continue;
      const ex = exOf(p0.id, d);
      if (ex?.kind === 'ausfall' && !f.includeCancelled) continue;
      // Vertretung/Umplanung: Einsatz gilt an diesem Tag für den anderen Mitarbeiter bzw. zu anderer Zeit
      const p: typeof p0 =
        ex && ex.kind !== 'ausfall'
          ? {
              ...p0,
              ...(ex.substitute_employee_id
                ? {
                    employee_id: ex.substitute_employee_id,
                    employee_name: ex.substitute_name ?? p0.employee_name,
                    personnel_no: ex.substitute_no ?? p0.personnel_no,
                  }
                : {}),
              ...(ex.start_time ? { start_time: ex.start_time, end_time: ex.end_time! } : {}),
            }
          : p0;
      if (f.employeeId && p.employee_id !== f.employeeId) continue;
      const [sh, sm] = p.start_time.split(':').map(Number) as [number, number];
      const [eh, em] = p.end_time.split(':').map(Number) as [number, number];
      const abs = absences.find(
        (a) => a.employee_id === p.employee_id && a.start_date <= d && a.end_date >= d,
      );
      out.push({
        plan: p,
        date: d,
        minutes: ex?.kind === 'ausfall' ? 0 : eh * 60 + em - (sh * 60 + sm) - p.break_minutes,
        absence: abs?.kind ?? null,
        // Feiertag frei (bezahlt), außer der Einsatz ist „auch an Sonn- und Feiertagen“
        holiday: p.holiday_work ? undefined : holidayName(d),
        entry: undefined,
        ...(ex
          ? {
              exception: {
                id: ex.id,
                kind: ex.kind,
                note: ex.note,
                original: p0.employee_name,
                version: ex.version,
              },
            }
          : {}),
      });
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.plan.start_time.localeCompare(b.plan.start_time));
  // Ist-Zeiten zuordnen: zuerst die ausdrücklich zum Einsatz bestätigten, dann übrige Zeiten desselben
  // Mitarbeiters am selben Objekt und Tag (jede Zeit höchstens einem Einsatz).
  const valid = entries.filter((e) => e.status !== 'abgelehnt');
  const used = new Set<string>();
  for (const s of out) {
    const e = valid.find((x) => x.shift_plan_id === s.plan.id && x.work_date === s.date);
    if (e) {
      s.entry = e;
      used.add(e.id);
    }
  }
  for (const s of out) {
    if (s.entry) continue;
    const e = valid.find(
      (x) =>
        !used.has(x.id) &&
        !x.shift_plan_id &&
        x.employee_id === s.plan.employee_id &&
        x.site_id === s.plan.site_id &&
        x.work_date === s.date,
    );
    if (e) {
      s.entry = e;
      used.add(e.id);
    }
  }
  return out;
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
    const [plan0] = await tx<ShiftPlan[]>`
      select *, to_char(start_time, 'HH24:MI') as start_time, to_char(end_time, 'HH24:MI') as end_time
        from app.shift_plans where id = ${p.planId}
         and valid_from <= ${p.date} and (valid_until is null or valid_until >= ${p.date})
         and (created_at at time zone 'Europe/Berlin')::date <= ${p.date}`;
    const [ex] = await tx<
      {
        kind: string;
        substitute_employee_id: string | null;
        start_time: string | null;
        end_time: string | null;
      }[]
    >`
      select kind::text, substitute_employee_id, to_char(start_time, 'HH24:MI') as start_time,
             to_char(end_time, 'HH24:MI') as end_time
        from app.shift_exceptions where shift_plan_id = ${p.planId} and work_date = ${p.date}`;
    const plan =
      plan0 && ex?.kind !== 'ausfall'
        ? {
            ...plan0,
            employee_id: ex?.substitute_employee_id ?? plan0.employee_id,
            ...(ex?.start_time ? { start_time: ex.start_time, end_time: ex.end_time! } : {}),
          }
        : undefined;
    if (!plan || plan.weekday !== isoWeekday(p.date) || plan.employee_id !== p.employeeId)
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
    // Pause wie geplant, mindestens die gesetzliche (§ 4 ArbZG), Lage nach 4 Std.
    const gross = Math.round((e.getTime() - s.getTime()) / 60000);
    const brk = Math.max(plan.break_minutes, suggestedBreak(gross));
    const brkStart = placeBreak(s, e, brk);
    await tx`
      insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, break_start_at,
                                    break_auto, source, status, shift_plan_id, created_by)
      values (${id}, ${p.employeeId}, ${plan.site_id}, ${p.date}, ${s}, ${e}, ${brk}, ${brkStart}, true,
              'soll_bestaetigt', 'erfasst', ${plan.id}, ${p.actor})`;
    return id;
  });
}

/**
 * Büro: „Plan-Zeiten als Ist-Zeiten erfassen“ (wie Fortytools) für einen Mitarbeiter und Zeitraum. Nimmt jeden
 * vergangenen Einsatz ohne erfasste Zeit (keine Abwesenheit, kein Ausfall, kein Feiertag) und trägt die geplante Zeit
 * als freigegebene Zeit ein – Pause wie geplant, mindestens gesetzlich. Feste ID wie beim Bestätigen in der App →
 * doppelt ausführen legt nichts doppelt an. Überschneidungen werden übersprungen und gemeldet.
 */
export async function officeConfirmPlanned(
  sql: Sql,
  p: {
    employeeId: string;
    from: string;
    to: string;
    actor: string;
    siteScope?: string[] | null;
    /** Protokollgrund, Standard „Plan als Ist (Büro)“ */
    reason?: string;
  },
): Promise<{ created: number; skipped: string[] }> {
  const today = todayBerlin();
  const to = p.to < today ? p.to : today;
  if (p.from > to) return { created: 0, skipped: [] };
  const shifts = await plannedShifts(sql, { from: p.from, to, employeeId: p.employeeId });
  const now = Date.now();
  let created = 0;
  const skipped: string[] = [];
  for (const sh of shifts) {
    if (sh.entry || sh.absence || sh.holiday || sh.exception?.kind === 'ausfall') continue;
    if (sh.plan.employee_id !== p.employeeId) continue;
    if (p.siteScope && !p.siteScope.includes(sh.plan.site_id)) continue;
    const r = await withActor(sql, p.actor, p.reason ?? 'Plan als Ist (Büro)', async (tx) => {
      const [{ id }] = (await tx`select md5(${sh.plan.id} || ':' || ${sh.date})::uuid as id`) as unknown as [
        { id: string },
      ];
      const [exists] = await tx`select 1 from app.time_entries where id = ${id}`;
      if (exists) return 'exists';
      const endDate = sh.plan.end_time <= sh.plan.start_time ? addDays(sh.date, 1) : sh.date;
      const [{ s, e }] = (await tx`
        select ((${sh.date}::date + ${sh.plan.start_time}::time) at time zone 'Europe/Berlin') as s,
               ((${endDate}::date + ${sh.plan.end_time}::time) at time zone 'Europe/Berlin') as e`) as unknown as [
        { s: Date; e: Date },
      ];
      if (e.getTime() > now) return 'open';
      try {
        await assertNoOverlap(tx, p.employeeId, s.toISOString(), e.toISOString(), null);
      } catch {
        return 'overlap';
      }
      const gross = Math.round((e.getTime() - s.getTime()) / 60000);
      const brk = Math.max(sh.plan.break_minutes ?? 0, suggestedBreak(gross));
      await tx`
        insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, break_start_at,
                                      break_auto, source, status, shift_plan_id, created_by, decided_by, decided_at)
        values (${id}, ${p.employeeId}, ${sh.plan.site_id}, ${sh.date}, ${s}, ${e}, ${brk}, ${placeBreak(s, e, brk)},
                true, 'soll_bestaetigt', 'freigegeben', ${sh.plan.id}, ${p.actor}, ${p.actor}, now())`;
      return 'ok';
    });
    if (r === 'ok') created++;
    else if (r === 'overlap')
      skipped.push(`${sh.date.split('-').reverse().join('.')} ${sh.plan.site_name} (überschneidet sich)`);
  }
  return { created, skipped };
}

/**
 * „Soll als Ist nach N Tagen“ (Ahmed 09.10.): vergangene Einsätze ohne erfasste Zeit werden N Tage nach dem
 * Einsatztag mit den Plan-Zeiten übernommen – nicht bei Abwesenheit, Ausfall, Feiertag oder Überschneidung.
 * Nur Einsätze ab dem Tag des Einschaltens, höchstens 14 Tage zurück. Läuft stündlich im Server.
 */
export async function autoConfirmPlanned(sql: Sql, today = todayBerlin()) {
  const [cfg] = await sql<{ days: number | null; since: string | null }[]>`
    select auto_confirm_days as days, auto_confirm_since::text as since from app.time_settings`;
  if (!cfg?.days) return 0;
  const to = addDays(today, -cfg.days);
  let from = addDays(today, -14);
  if (cfg.since && cfg.since > from) from = cfg.since;
  if (from > to) return 0;
  const shifts = await plannedShifts(sql, { from, to });
  const emps = [
    ...new Set(
      shifts
        .filter(
          (s) =>
            !s.entry && !s.absence && !s.holiday && s.exception?.kind !== 'ausfall' && s.plan.employee_id,
        )
        .map((s) => s.plan.employee_id!),
    ),
  ];
  let n = 0;
  for (const employeeId of emps) {
    const r = await officeConfirmPlanned(sql, {
      employeeId,
      from,
      to,
      actor: 'automatisch',
      reason: `Plan als Ist automatisch (keine Zeit nach ${cfg.days} Tagen)`,
    });
    n += r.created;
  }
  return n;
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

/**
 * Büro entfernt eine falsche Zeit: Sie zählt nirgends mehr (Status „abgelehnt / entfernt“), bleibt aber mit altem
 * Stand, Begründung und Akteur im Protokoll (§ 17 MiLoG – Aufzeichnungen dürfen nicht spurlos verschwinden).
 */
export async function officeRemove(sql: Sql, id: string, reason: string, actor: string) {
  if (!reason.trim())
    throw new BusinessError('Bitte begründen, warum die Zeit entfernt wird (wird protokolliert)');
  await withActor(sql, actor, `entfernt: ${reason.trim()}`, async (tx) => {
    const [e] = await tx<
      { status: TimeStatus }[]
    >`select status from app.time_entries where id = ${id} for update`;
    if (!e) throw new BusinessError('Eintrag nicht gefunden');
    if (e.status === 'abgelehnt') return;
    await tx`update app.time_entries set status = 'abgelehnt', end_at = coalesce(end_at, start_at + interval '1 minute'),
               decided_by = ${actor}, decided_at = now()
             where id = ${id}`;
  });
}

/**
 * Endgültig löschen (Admin/Personal): für Test-Zeiten und falsch übernommene Importe. Zeile und Änderungsprotokoll
 * wandern vollständig ins Löschprotokoll (`time_entry_deletions`, nur anhängen). Echte Arbeitszeiten nicht löschen,
 * sondern korrigieren oder entfernen (§ 17 MiLoG: 2 Jahre aufbewahren).
 */
export async function purgeEntries(sql: Sql, ids: string[], reason: string, actor: string) {
  // Grund freiwillig (Ahmed 09.10.: „löschen ohne Doku wie Fortytools“) – der Stand landet trotzdem im Löschprotokoll
  reason = reason.trim() || 'gelöscht (ohne Angabe)';
  const uniq = [...new Set(ids)].filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  if (!uniq.length) throw new BusinessError('Keine Zeiten ausgewählt');
  let n = 0;
  await sql.begin(async (tx) => {
    for (const id of uniq) {
      const [r] = await tx<
        { ok: boolean }[]
      >`select app.purge_time_entry(${id}, ${actor}, ${reason.trim()}) as ok`;
      if (r?.ok) n++;
    }
  });
  return n;
}

export async function listDeletions(sql: Sql, limit = 200) {
  return sql<
    {
      entry_id: string;
      deleted_at: Date;
      actor: string;
      reason: string;
      work_date: string;
      employee_name: string | null;
      site_name: string | null;
      start_at: string;
      end_at: string | null;
    }[]
  >`
    select d.entry_id, d.deleted_at, d.actor, d.reason, d.entry->>'work_date' as work_date,
           e.last_name || ', ' || e.first_name as employee_name, s.name as site_name,
           d.entry->>'start_at' as start_at, d.entry->>'end_at' as end_at
      from app.time_entry_deletions d
      left join app.employees e on e.id = (d.entry->>'employee_id')::uuid
      left join app.sites s on s.id = (d.entry->>'site_id')::uuid
     order by d.id desc limit ${limit}`;
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
      select id, last_name || ', ' || first_name as name, personnel_no, app.effective_wage_cents(e) as hourly_wage_cents, weekly_hours::text
        from app.employees e where status = 'aktiv' order by last_name, first_name`,
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

// ---------------------------------------------------------------- Terminserien (Planung wie Fortytools)

export interface ShiftSeriesInput {
  siteId: string;
  /** null = offen („zu planender Einsatz“); mehrere Mitarbeiter = je Mitarbeiter derselbe Termin */
  employeeIds: (string | null)[];
  recurrence: Recurrence;
  every: number;
  weekdays: number[];
  months: number[] | null;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  validFrom: string;
  validUntil: string | null;
  note: string | null;
  planningGroup: string | null;
  /** auch an Sonn- und Feiertagen arbeiten (Zuschläge); Sonntags-Einsätze immer */
  holidayWork?: boolean;
}

export interface ShiftSeries extends ShiftSeriesInput {
  seriesId: string;
  plans: { id: string; employee_id: string | null; weekday: number; valid_until: string | null }[];
}

/** Terminserie laden (alle Einsätze mit derselben Serien-ID; Altdaten: Serie = einzelner Einsatz). */
export async function getShiftSeries(sql: Sql, idOrSeries: string): Promise<ShiftSeries | undefined> {
  const rows = await sql<
    (ShiftPlan & { start: string; end: string })[]
  >`select p.*, to_char(p.start_time, 'HH24:MI') as start, to_char(p.end_time, 'HH24:MI') as end
      from app.shift_plans p
     where p.series_id = (select coalesce(series_id, id) from app.shift_plans where id = ${idOrSeries} or series_id = ${idOrSeries} limit 1)
     order by p.weekday`;
  if (!rows.length) return undefined;
  const today = todayBerlin();
  // laufende/künftige Teile der Serie bestimmen die Anzeige (beendete bleiben für die Vergangenheit)
  const live = rows.filter((r) => !r.valid_until || r.valid_until >= today || r.recurrence === 'einmalig');
  const base = live[0] ?? rows[0]!;
  const cur = live.length ? live : rows;
  return {
    seriesId: base.series_id ?? base.id,
    siteId: base.site_id,
    employeeIds: [...new Set(cur.map((r) => r.employee_id))],
    recurrence: base.recurrence ?? 'woechentlich',
    every: base.every ?? 1,
    weekdays: [...new Set(cur.map((r) => r.weekday))].sort(),
    months: base.months ?? null,
    startTime: base.start,
    endTime: base.end,
    breakMinutes: base.break_minutes,
    validFrom: base.valid_from,
    validUntil: base.valid_until,
    note: base.note,
    planningGroup: base.planning_group ?? null,
    holidayWork: !!base.holiday_work,
    plans: rows.map((r) => ({
      id: r.id,
      employee_id: r.employee_id,
      weekday: r.weekday,
      valid_until: r.valid_until,
    })),
  };
}

/**
 * Termin oder Terminserie speichern: je Mitarbeiter × Wochentag ein Einsatz (feste IDs aus Serie + Mitarbeiter +
 * Tag → doppelt absenden legt nichts doppelt an). Beim Ändern bleiben vorhandene Einsätze erhalten (gleiche ID,
 * Zeiten/Nachweise hängen daran); weggefallene Mitarbeiter/Tage enden gestern (nie genutzte künftige werden entfernt).
 */
/**
 * Serie ab einem Datum ändern (Ahmed: „gilt ab“): die bisherige Serie endet am Vortag, ab dem Datum gilt eine neue Serie
 * mit den neuen Angaben (feste ID aus Serie + Datum → doppelt absenden legt nichts doppelt an). Vergangene Termine und
 * erfasste Zeiten bleiben unverändert. Liegt das Datum nicht nach dem Beginn, wird die ganze Serie geändert.
 * Gibt die ID der gültigen (neuen) Serie zurück.
 */
export async function changeShiftSeriesFrom(
  sql: Sql,
  seriesId: string,
  from: string,
  p: ShiftSeriesInput,
  actor: string,
): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new BusinessError('Bitte das Datum „gilt ab“ angeben');
  const existing = await getShiftSeries(sql, seriesId);
  if (!existing || from <= existing.validFrom) {
    await saveShiftSeries(sql, existing?.seriesId ?? seriesId, p, actor);
    return existing?.seriesId ?? seriesId;
  }
  if (p.recurrence === 'einmalig') throw new BusinessError('Ein einmaliger Termin hat kein „gilt ab“');
  const nid = (
    await sql<{ nid: string }[]>`select md5(${existing.seriesId} || ':ab:' || ${from})::uuid::text as nid`
  )[0]!.nid;
  await saveShiftSeries(sql, nid, { ...p, validFrom: from > p.validFrom ? from : p.validFrom }, actor);
  for (const old of existing.plans)
    if (!old.valid_until || old.valid_until >= from)
      await endShiftPlan(sql, old.id, addDays(from, -1), actor);
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'split', 'shift_series', ${existing.seriesId}, ${sql.json({ ab: from, neu: nid })})`;
  return nid;
}

export async function saveShiftSeries(sql: Sql, seriesId: string, p: ShiftSeriesInput, actor: string) {
  if (!HHMM.test(p.startTime) || !HHMM.test(p.endTime)) throw new BusinessError('Uhrzeit bitte als HH:MM');
  if (p.endTime <= p.startTime)
    throw new BusinessError('Ende muss nach dem Beginn liegen (Nachtschichten bitte als zwei Termine)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.validFrom)) throw new BusinessError('Bitte das Datum „ab“ angeben');
  if (!(p.recurrence in RECURRENCE)) throw new BusinessError('Wiederholung ungültig');
  const weekdays =
    p.recurrence === 'woechentlich' ? [...new Set(p.weekdays)].sort() : [isoWeekday(p.validFrom)];
  if (!weekdays.length) throw new BusinessError('Bitte mindestens einen Wochentag wählen');
  if (weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7))
    throw new BusinessError('Wochentag ungültig');
  const validUntil = p.recurrence === 'einmalig' ? p.validFrom : p.validUntil;
  if (validUntil && validUntil < p.validFrom) throw new BusinessError('Enddatum liegt vor dem Beginn');
  const employees = [...new Set(p.employeeIds.length ? p.employeeIds : [null])];
  const existing = await getShiftSeries(sql, seriesId);
  const yesterday = addDays(todayBerlin(), -1);
  const keep = new Set<string>();
  await sql.begin(async (tx) => {
    for (const emp of employees) {
      if (emp) {
        await assertMaySite(tx, emp, p.siteId).catch(async () => {
          await tx`insert into app.employee_sites (employee_id, site_id) values (${emp}, ${p.siteId}) on conflict do nothing`;
        });
      }
      for (const wd of weekdays) {
        const old = existing?.plans.find(
          (x) => x.employee_id === emp && (x.weekday === wd || p.recurrence !== 'woechentlich'),
        );
        const pid =
          old?.id ??
          (
            await tx<
              { pid: string }[]
            >`select md5(${seriesId} || ':' || ${emp ?? 'offen'} || ':' || ${wd})::uuid::text as pid`
          )[0]!.pid;
        keep.add(pid);
        await tx`
          insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, break_minutes, valid_from,
                                       valid_until, note, recurrence, every, months, series_id, planning_group,
                                       holiday_work)
          values (${pid}, ${emp}, ${p.siteId}, ${wd}, ${p.startTime}, ${p.endTime}, ${p.breakMinutes}, ${p.validFrom},
                  ${validUntil}, ${p.note}, ${p.recurrence}, ${p.every}, ${p.months?.length ? p.months : null},
                  ${seriesId}, ${p.planningGroup?.trim() || null}, ${!!p.holidayWork || wd === 7})
          on conflict (id) do update set employee_id = excluded.employee_id, site_id = excluded.site_id,
            weekday = excluded.weekday, start_time = excluded.start_time, end_time = excluded.end_time,
            break_minutes = excluded.break_minutes, valid_from = excluded.valid_from, valid_until = excluded.valid_until,
            note = excluded.note, recurrence = excluded.recurrence, every = excluded.every, months = excluded.months,
            series_id = excluded.series_id, planning_group = excluded.planning_group,
            holiday_work = excluded.holiday_work, updated_at = now()`;
      }
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, ${existing ? 'update' : 'create'}, 'shift_series', ${seriesId},
                     ${tx.json({ recurrence: p.recurrence, weekdays, employees: employees.length })})`;
  });
  // weggefallene Teile der Serie beenden (Vergangenheit bleibt erhalten)
  for (const old of existing?.plans ?? [])
    if (!keep.has(old.id) && (!old.valid_until || old.valid_until > yesterday))
      await endShiftPlan(sql, old.id, yesterday, actor);
  return [...keep];
}
