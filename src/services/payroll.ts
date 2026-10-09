import type { Sql } from '../db/client.js';
import {
  DEFAULT_RATES,
  type SurchargeKind,
  type SurchargeRates,
  surchargeCents,
  surchargeMinutes,
} from '../domain/time/surcharges.js';
import { addDays, isoWeekday } from '../domain/time/holidays.js';
import { listAbsenceHours } from './absences.js';
import { BusinessError } from './errors.js';
import { breakRange, listEntries, plannedShifts } from './time.js';
import { monthRange } from './timesheet.js';

/*
 * Lohnarten je Mitarbeiter und Monat für die Lohnabrechnung (Lexware): Normalstunden (gearbeitet), Urlaub, Krank,
 * sonstige bezahlte Abwesenheit, unbezahlt (nur zur Info) und Zuschlagsstunden nach RTV Gebäudereinigung.
 * Zuschläge werden zusätzlich zum Grundlohn gezahlt (Stunden × Lohn × Satz). Nur erfasste/freigegebene Zeiten.
 */

export type WageType =
  'normal' | 'urlaub' | 'krank' | 'feiertag_lfz' | 'sonstige' | 'unbezahlt' | SurchargeKind | 'mehrarbeit';

export const WAGE_TYPE_LABEL: Record<WageType, string> = {
  normal: 'Normalstunden',
  urlaub: 'Urlaub',
  krank: 'Krankheit (Lohnfortzahlung)',
  feiertag_lfz: 'Feiertag (Entgeltfortzahlung)',
  sonstige: 'Sonstige bezahlte Abwesenheit',
  unbezahlt: 'Unbezahlt (Info)',
  nacht: 'Zuschlag Nachtarbeit',
  sonntag: 'Zuschlag Sonntagsarbeit',
  feiertag: 'Zuschlag Feiertagsarbeit',
  feiertag_hoch: 'Zuschlag hohe Feiertage',
  mehrarbeit: 'Zuschlag Mehrarbeit',
};
export const WAGE_TYPES = Object.keys(WAGE_TYPE_LABEL) as WageType[];
export const SURCHARGES: SurchargeKind[] = ['nacht', 'sonntag', 'feiertag', 'feiertag_hoch'];

export interface PayrollSettings {
  night_from: string;
  night_to: string;
  night_bp: number;
  sunday_bp: number;
  sunday_regular_bp: number;
  holiday_bp: number;
  high_holiday_bp: number;
  /** Mehrarbeit: Minuten je Woche, ab denen der Zuschlag gilt (0 = aus), Satz in Basispunkten */
  overtime_weekly_minutes: number;
  overtime_bp: number;
  wage_type_numbers: Partial<Record<WageType, string>>;
  version: number;
}

export async function getPayrollSettings(sql: Sql): Promise<PayrollSettings> {
  const [s] = await sql<PayrollSettings[]>`
    select to_char(night_from, 'HH24:MI') as night_from, to_char(night_to, 'HH24:MI') as night_to, night_bp,
           sunday_bp, sunday_regular_bp, holiday_bp, high_holiday_bp, overtime_weekly_minutes, overtime_bp,
           wage_type_numbers, version
      from app.payroll_settings`;
  return s!;
}

export async function savePayrollSettings(
  sql: Sql,
  p: Omit<PayrollSettings, 'version'> & { expectedVersion: number | null },
) {
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!hhmm.test(p.night_from) || !hhmm.test(p.night_to))
    throw new BusinessError('Nachtzeit bitte als HH:MM');
  if (
    !Number.isInteger(p.overtime_weekly_minutes) ||
    p.overtime_weekly_minutes < 0 ||
    p.overtime_weekly_minutes > 4800
  )
    throw new BusinessError('Mehrarbeit ab: 0–80 Stunden je Woche');
  for (const v of [
    p.night_bp,
    p.sunday_bp,
    p.sunday_regular_bp,
    p.holiday_bp,
    p.high_holiday_bp,
    p.overtime_bp,
  ])
    if (!Number.isInteger(v) || v < 0 || v > 50000) throw new BusinessError('Zuschläge 0–500 %');
  const [cur] = await sql<{ version: number }[]>`select version from app.payroll_settings`;
  if (p.expectedVersion != null && cur && cur.version !== p.expectedVersion)
    throw new BusinessError('Die Einstellungen wurden zwischenzeitlich geändert – bitte neu laden');
  await sql`update app.payroll_settings set night_from = ${p.night_from}, night_to = ${p.night_to},
              night_bp = ${p.night_bp}, sunday_bp = ${p.sunday_bp}, sunday_regular_bp = ${p.sunday_regular_bp},
              holiday_bp = ${p.holiday_bp}, high_holiday_bp = ${p.high_holiday_bp},
              overtime_weekly_minutes = ${p.overtime_weekly_minutes}, overtime_bp = ${p.overtime_bp},
              wage_type_numbers = ${sql.json(p.wage_type_numbers as never)}`;
}

export const ratesOf = (s: PayrollSettings): SurchargeRates => {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return {
    ...DEFAULT_RATES,
    nightFrom: m(s.night_from),
    nightTo: m(s.night_to),
    night: s.night_bp,
    sunday: s.sunday_bp,
    sundayRegular: s.sunday_regular_bp,
    holiday: s.holiday_bp,
    highHoliday: s.high_holiday_bp,
  };
};

export interface PayrollRow {
  employee_id: string;
  personnel_no: string;
  name: string;
  wage_cents: bigint | null;
  pay_model: string | null;
  regular_sunday_work: boolean;
  minutes: Record<WageType, number>;
  /** Zuschlagsbeträge in Cent (nur bei bekanntem Stundenlohn) */
  surchargeCents: Record<SurchargeKind, bigint>;
  /** angewandter Satz je Zuschlag (Basispunkte) */
  bp: Record<SurchargeKind, number>;
  /** Mehrarbeitszuschlag in Cent (Stunden über der Wochenschwelle × Lohn × Satz) */
  overtimeCents: bigint;
  pending: number;
  /** davon geplante (noch nicht gearbeitete) Minuten ab dem Stichtag – nur bei Vorab-Abrechnung */
  forecastMinutes: number;
  /** Minuten an Sonn-/Feiertagen ohne Einsatz „auch an Sonn- und Feiertagen“ – kein Zuschlag berechnet */
  uncoveredSundayHolidayMinutes: number;
}

/** Ortszeit Berlin (JJJJ-MM-TT, HH:MM) → Zeitpunkt; Sommer-/Winterzeit über Intl ermittelt. */
function berlinAt(date: string, hhmm: string): Date {
  const guess = new Date(`${date}T${hhmm}:00Z`);
  const off = (d: Date) => {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Berlin',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(d);
    const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute')) - d.getTime();
  };
  return new Date(guess.getTime() - off(new Date(guess.getTime() - off(guess))));
}

const zero = (): Record<WageType, number> =>
  Object.fromEntries(WAGE_TYPES.map((k) => [k, 0])) as Record<WageType, number>;

/**
 * Lohnarten eines Monats. Mit `cutoff` (Vorab-Abrechnung, Ahmed 09.10.: „Löhne müssen früher gedruckt werden“):
 * erfasste Zeiten bis einschließlich Stichtag, danach die geplanten Einsätze bis Monatsende (ohne Abwesenheit,
 * Ausfall, Feiertag). Abwesenheiten zählen für den ganzen Monat. Mehrarbeit nur aus erfassten Zeiten.
 */
export async function payrollMonth(
  sql: Sql,
  month: string,
  employeeId?: string,
  opts: { cutoff?: string | null } = {},
): Promise<PayrollRow[]> {
  const { from, to } = monthRange(month);
  const cutoff = opts.cutoff && opts.cutoff >= from && opts.cutoff < to ? opts.cutoff : null;
  const settings = await getPayrollSettings(sql);
  const rates = ratesOf(settings);
  const emps = await sql<
    {
      id: string;
      personnel_no: string;
      name: string;
      wage_cents: bigint | null;
      pay_model: string | null;
      regular_sunday_work: boolean;
    }[]
  >`
    select e.id, e.personnel_no, e.last_name || ', ' || e.first_name as name, app.effective_wage_cents(e) as wage_cents,
           e.pay_model, e.regular_sunday_work
      from app.employees e
     where e.entry_date <= ${to} and (e.exit_date is null or e.exit_date >= ${from})
       and ${employeeId ? sql`e.id = ${employeeId}` : sql`true`}
     order by e.last_name, e.first_name`;
  const [entries, absHours, kinds] = await Promise.all([
    listEntries(sql, { from, to, ...(employeeId ? { employeeId } : {}) }),
    listAbsenceHours(sql, { from, to, ...(employeeId ? { employeeId } : {}) }),
    sql<{ id: string; kind: string }[]>`
      select id, kind::text from app.absences where start_date <= ${to} and end_date >= ${from}`,
  ]);
  const kindOf = new Map(kinds.map((k) => [k.id, k.kind]));
  // Sonn-/Feiertagszuschläge nur für Zeiten zu Einsätzen „auch an Sonn- und Feiertagen“ (Ahmed 09.10.);
  // Nachtzuschlag gilt immer. Zeit ohne solchen Einsatz → Minuten als Hinweis (kein Zuschlag berechnet).
  const flagged = await sql<
    {
      employee_id: string;
      site_id: string;
      weekday: number;
      valid_from: string;
      valid_until: string | null;
    }[]
  >`select employee_id, site_id, weekday, valid_from, valid_until from app.shift_plans
     where holiday_work and employee_id is not null and valid_from <= ${to}
       and (valid_until is null or valid_until >= ${from})`;
  const holidayCovered = (emp: string, site: string, date: string) => {
    const wd = isoWeekday(date);
    return flagged.some(
      (p) =>
        p.employee_id === emp &&
        p.site_id === site &&
        p.weekday === wd &&
        p.valid_from <= date &&
        (!p.valid_until || p.valid_until >= date),
    );
  };
  const nightOnly = { ...rates, sunday: 0, sundayRegular: 0, holiday: 0, highHoliday: 0 };
  // Feiertag (§ 2 EFZG): geplante Einsätze an Feiertagen, die nicht gearbeitet wurden und auf die keine Abwesenheit fällt
  const holidayPay = new Map<string, number>();
  for (const sh of await plannedShifts(sql, { from, to, ...(employeeId ? { employeeId } : {}) })) {
    const emp = sh.plan.employee_id;
    if (!emp || !sh.holiday || sh.entry || sh.absence || sh.exception?.kind === 'ausfall') continue;
    holidayPay.set(emp, (holidayPay.get(emp) ?? 0) + Math.max(0, sh.minutes));
  }
  // Vorab: geplante Einsätze nach dem Stichtag als Zeiten (Beginn/Ende in Berliner Zeit)
  const forecast: {
    employee_id: string;
    start_at: Date;
    end_at: Date;
    break_minutes: number;
    holidayWork: boolean;
  }[] = [];
  if (cutoff) {
    const shifts = await plannedShifts(sql, {
      from: addDays(cutoff, 1),
      to,
      ...(employeeId ? { employeeId } : {}),
    });
    for (const sh of shifts) {
      // bei Vertretung/Umplanung enthält plan bereits Vertreter und geänderte Zeit
      const emp = sh.plan.employee_id;
      if (!emp || sh.absence || sh.holiday || sh.exception?.kind === 'ausfall') continue;
      const st = sh.plan.start_time;
      const en = sh.plan.end_time;
      const endDate = en <= st ? addDays(sh.date, 1) : sh.date;
      forecast.push({
        employee_id: emp,
        start_at: berlinAt(sh.date, st),
        end_at: berlinAt(endDate, en),
        break_minutes: sh.plan.break_minutes ?? 0,
        holidayWork: !!sh.plan.holiday_work,
      });
    }
  }
  // Mehrarbeit je Kalenderwoche (Mo–So): Wochen am Monatsrand vollständig laden, Minuten über der Schwelle dem Tag
  // zuordnen, an dem sie anfallen – gezählt wird nur, was im Monat liegt.
  const overtime = new Map<string, number>();
  if (settings.overtime_weekly_minutes > 0) {
    const wd = (d: string) => (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7;
    const wFrom = addDays(from, -wd(from));
    const wTo = addDays(to, 6 - wd(to));
    const wk = await listEntries(sql, { from: wFrom, to: wTo, ...(employeeId ? { employeeId } : {}) });
    const byWeek = new Map<string, (typeof wk)[number][]>();
    for (const t of wk) {
      if ((t.status !== 'erfasst' && t.status !== 'freigegeben') || !t.end_at) continue;
      const key = `${t.employee_id}|${addDays(t.work_date, -wd(t.work_date))}`;
      byWeek.set(key, [...(byWeek.get(key) ?? []), t]);
    }
    for (const [key, list] of byWeek) {
      list.sort((a, b) => a.start_at.getTime() - b.start_at.getTime());
      let cum = 0;
      for (const t of list) {
        const net = Math.max(0, t.gross_minutes - t.break_minutes);
        const over =
          Math.max(0, cum + net - settings.overtime_weekly_minutes) -
          Math.max(0, cum - settings.overtime_weekly_minutes);
        cum += net;
        if (over && t.work_date >= from && t.work_date <= to) {
          const emp = key.split('|')[0]!;
          overtime.set(emp, (overtime.get(emp) ?? 0) + over);
        }
      }
    }
  }
  const rows: PayrollRow[] = [];
  for (const e of emps) {
    const m = zero();
    let uncovered = 0;
    let pending = 0;
    let fc = 0;
    for (const f of forecast) {
      if (f.employee_id !== e.id) continue;
      const net = Math.max(
        0,
        Math.round((f.end_at.getTime() - f.start_at.getTime()) / 60000) - f.break_minutes,
      );
      m.normal += net;
      fc += net;
      const sm = surchargeMinutes(
        f.start_at,
        f.end_at,
        null,
        null,
        f.holidayWork ? rates : nightOnly,
        e.regular_sunday_work,
      );
      for (const k of SURCHARGES) m[k] += sm[k];
    }
    for (const t of entries) {
      if (t.employee_id !== e.id) continue;
      if (cutoff && t.work_date > cutoff) continue;
      if (t.status === 'beantragt' || t.status === 'laeuft') pending++;
      if ((t.status !== 'erfasst' && t.status !== 'freigegeben') || !t.end_at) continue;
      m.normal += Math.max(0, t.gross_minutes - t.break_minutes);
      const br = breakRange(t);
      const covered = holidayCovered(e.id, t.site_id, t.work_date);
      const sm = surchargeMinutes(
        t.start_at,
        t.end_at,
        br?.from ?? null,
        br?.to ?? null,
        covered ? rates : nightOnly,
        e.regular_sunday_work,
      );
      for (const k of SURCHARGES) m[k] += sm[k];
      if (!covered) {
        const full = surchargeMinutes(t.start_at, t.end_at, br?.from ?? null, br?.to ?? null, rates, false);
        uncovered += full.sonntag + full.feiertag + full.feiertag_hoch;
      }
    }
    m.mehrarbeit = overtime.get(e.id) ?? 0;
    m.feiertag_lfz = holidayPay.get(e.id) ?? 0;
    for (const h of absHours) {
      if (h.employee_id !== e.id) continue;
      const k = kindOf.get(h.absence_id);
      if (!h.paid) m.unbezahlt += h.minutes;
      else if (k === 'urlaub') m.urlaub += h.minutes;
      else if (k === 'krank' || k === 'kind_krank') m.krank += h.minutes;
      else m.sonstige += h.minutes;
    }
    const bp: Record<SurchargeKind, number> = {
      nacht: rates.night,
      sonntag: e.regular_sunday_work ? rates.sundayRegular : rates.sunday,
      feiertag: e.regular_sunday_work ? rates.sundayRegular : rates.holiday,
      feiertag_hoch: e.regular_sunday_work ? rates.sundayRegular : rates.highHoliday,
    };
    const sc = Object.fromEntries(
      SURCHARGES.map((k) => [k, e.wage_cents ? surchargeCents(m[k], e.wage_cents, bp[k]) : 0n]),
    ) as Record<SurchargeKind, bigint>;
    if (WAGE_TYPES.some((k) => m[k]) || pending)
      rows.push({
        ...e,
        employee_id: e.id,
        minutes: m,
        surchargeCents: sc,
        bp,
        overtimeCents: e.wage_cents ? surchargeCents(m.mehrarbeit, e.wage_cents, settings.overtime_bp) : 0n,
        pending,
        forecastMinutes: fc,
        uncoveredSundayHolidayMinutes: uncovered,
      });
  }
  return rows;
}

const dec = (minutes: number) => (minutes / 60).toFixed(2).replace('.', ',');
const eur = (c: bigint) => `${c / 100n},${String(c % 100n).padStart(2, '0')}`;

/** CSV für den Lohnimport: je Mitarbeiter und Lohnart eine Zeile (Format vorläufig, an Lexware anpassen). */
export function payrollCsv(
  rows: PayrollRow[],
  s: PayrollSettings,
  month: string,
  corrections?: { month: string; rows: PayrollCorrection[] },
): string {
  const safe = (v: string) => (/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/;/g, ',');
  const out = ['﻿Monat;Personalnummer;Name;Lohnart-Nr.;Lohnart;Stunden;Satz %;Stundenlohn;Betrag Zuschlag'];
  for (const r of rows)
    for (const k of WAGE_TYPES) {
      if (!r.minutes[k]) continue;
      const sur = (SURCHARGES as string[]).includes(k) ? (k as SurchargeKind) : null;
      const ot = k === 'mehrarbeit';
      out.push(
        [
          month,
          safe(r.personnel_no),
          safe(r.name),
          safe(s.wage_type_numbers[k] ?? ''),
          WAGE_TYPE_LABEL[k],
          dec(r.minutes[k]),
          sur
            ? String(r.bp[sur] / 100).replace('.', ',')
            : ot
              ? String(s.overtime_bp / 100).replace('.', ',')
              : '',
          r.wage_cents ? eur(r.wage_cents) : '',
          sur && r.wage_cents ? eur(r.surchargeCents[sur]) : ot && r.wage_cents ? eur(r.overtimeCents) : '',
        ].join(';'),
      );
    }
  // Korrektur Vormonat (Vorab-Abrechnung): Differenz in Stunden, Beträge rechnet das Lohnprogramm
  for (const r of corrections?.rows ?? [])
    for (const k of WAGE_TYPES) {
      const v = r.minutes[k];
      if (!v) continue;
      out.push(
        [
          `${corrections!.month} Korrektur`,
          safe(r.personnel_no),
          safe(r.name),
          safe(s.wage_type_numbers[k] ?? ''),
          WAGE_TYPE_LABEL[k],
          dec(v),
          '',
          '',
          '',
        ].join(';'),
      );
    }
  return `${out.join('\r\n')}\r\n`;
}

/** Vorab-Export festhalten (Grundlage für die Korrektur im Folgemonat). */
export async function recordPayrollExport(
  sql: Sql,
  month: string,
  cutoff: string | null,
  rows: PayrollRow[],
  actor: string,
) {
  const data = rows.map((r) => ({ employee_id: r.employee_id, minutes: r.minutes }));
  await sql`insert into app.payroll_exports (id, month, cutoff, rows, created_by)
            values (gen_random_uuid(), ${month}, ${cutoff}, ${sql.json(data as never)}, ${actor})`;
}

export interface PayrollCorrection {
  employee_id: string;
  personnel_no: string;
  name: string;
  /** tatsächlich − vorab exportiert, je Lohnart (Minuten, auch negativ) */
  minutes: Partial<Record<WageType, number>>;
}

/**
 * Korrektur Vormonat: Wurde der Monat vorab (mit Stichtag) exportiert, Differenz zwischen dem jetzt tatsächlichen Monat
 * und dem zuletzt exportierten Vorab-Stand. Leer, wenn es keinen Vorab-Export gab.
 */
export async function payrollCorrections(
  sql: Sql,
  month: string,
): Promise<{ cutoff: string | null; rows: PayrollCorrection[] }> {
  const [ex] = await sql<
    { cutoff: string | null; rows: { employee_id: string; minutes: Record<WageType, number> }[] }[]
  >`
    select cutoff::text, rows from app.payroll_exports where month = ${month} order by created_at desc limit 1`;
  if (!ex?.cutoff) return { cutoff: null, rows: [] };
  const actual = await payrollMonth(sql, month);
  const before = new Map(ex.rows.map((r) => [r.employee_id, r.minutes]));
  const ids = new Set([...actual.map((r) => r.employee_id), ...before.keys()]);
  const names = await sql<{ id: string; personnel_no: string; name: string }[]>`
    select id, personnel_no, last_name || ', ' || first_name as name from app.employees where id = any(${[...ids]}::uuid[])`;
  const out: PayrollCorrection[] = [];
  for (const id of ids) {
    const now = actual.find((r) => r.employee_id === id)?.minutes;
    const was = before.get(id);
    const diff: Partial<Record<WageType, number>> = {};
    for (const k of WAGE_TYPES) {
      const d = (now?.[k] ?? 0) - (was?.[k] ?? 0);
      if (d) diff[k] = d;
    }
    const n = names.find((x) => x.id === id);
    if (Object.keys(diff).length && n)
      out.push({ employee_id: id, personnel_no: n.personnel_no, name: n.name, minutes: diff });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return { cutoff: ex.cutoff, rows: out };
}
