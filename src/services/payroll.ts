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
 * Lohnarten je Mitarbeiter und Monat für die Lohnabrechnung (Lexware): Normalstunden (gearbeitet, dazu sonstige
 * bezahlte Abwesenheit), Aushilfslohn (Minijob mit Stundenlohn), Urlaub, Krank, Feiertag, Zuschläge nach RTV
 * Gebäudereinigung sowie Gehalt / Aushilfsgehalt (Minijob) / Geschäftsführergehalt als Monatsbetrag bei Festgehalt.
 * Unbezahlte Abwesenheit: bei Stundenlohn nicht bezahlt (keine Lohnart), bei Festgehalt Abzug vom Gehalt als eigene
 * Lohnart „Unbezahlte Abwesenheit (Abzug)“ mit Minusbetrag (Ahmed 28.10.). Nur erfasste/freigegebene Zeiten.
 */

/** Lohnarten mit Stunden */
export type HourType =
  'normal' | 'aushilfslohn' | 'urlaub' | 'krank' | 'feiertag_lfz' | SurchargeKind | 'mehrarbeit';
/** Lohnarten mit Monatsbetrag (Festgehalt) */
export type SalaryType = 'gehalt' | 'aushilfsgehalt' | 'gf_gehalt';
/** Abzug vom Festgehalt für unbezahlte Abwesenheit (Minusbetrag) */
export type DeductionType = 'unbezahlt';
export type WageType = HourType | SalaryType | DeductionType;

export const HOUR_TYPE_LABEL: Record<HourType, string> = {
  normal: 'Normalstunden',
  aushilfslohn: 'Aushilfslohn (Minijob)',
  urlaub: 'Urlaub',
  krank: 'Krankheit (Lohnfortzahlung)',
  feiertag_lfz: 'Feiertag (Entgeltfortzahlung)',
  nacht: 'Zuschlag Nachtarbeit',
  sonntag: 'Zuschlag Sonntagsarbeit',
  feiertag: 'Zuschlag Feiertagsarbeit',
  feiertag_hoch: 'Zuschlag hohe Feiertage',
  mehrarbeit: 'Zuschlag Mehrarbeit',
};
export const SALARY_TYPE_LABEL: Record<SalaryType, string> = {
  gehalt: 'Gehalt',
  aushilfsgehalt: 'Aushilfsgehalt (Minijob)',
  gf_gehalt: 'Geschäftsführergehalt GmbH-Gesellschafter',
};
export const WAGE_TYPE_LABEL: Record<WageType, string> = {
  ...HOUR_TYPE_LABEL,
  ...SALARY_TYPE_LABEL,
  unbezahlt: 'Unbezahlte Abwesenheit (Abzug)',
};
export const HOUR_TYPES = Object.keys(HOUR_TYPE_LABEL) as HourType[];
export const SALARY_TYPES = Object.keys(SALARY_TYPE_LABEL) as SalaryType[];
export const WAGE_TYPES = Object.keys(WAGE_TYPE_LABEL) as WageType[];
/** Grundlohn-Stunden: bei Festgehalt im Gehalt enthalten, im Export nicht einzeln */
const BASE_HOURS: HourType[] = ['normal', 'aushilfslohn', 'urlaub', 'krank', 'feiertag_lfz'];
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
  minutes: Record<HourType, number>;
  /** Festgehalt: Lohnart und Monatsbetrag (anteilig bei Ein-/Austritt im Monat) */
  salary: { type: SalaryType; cents: bigint } | null;
  /** unbezahlte Abwesenheit in Minuten (Info; bei Festgehalt Grundlage des Abzugs) */
  unpaidMinutes: number;
  /** Festgehalt: Abzug für unbezahlte Abwesenheit in Cent (positiv, wird als Minusbetrag exportiert) */
  unpaidDeductionCents: bigint;
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

const zero = (): Record<HourType, number> =>
  Object.fromEntries(HOUR_TYPES.map((k) => [k, 0])) as Record<HourType, number>;

/** Gehalts-Lohnart: Geschäftsführer (Tag „Geschäftsführer“), Minijob, sonst Gehalt. */
export function salaryTypeOf(e: { employment_type: string | null; tags: string[] | null }): SalaryType {
  const gf = (e.tags ?? []).some((t) => /gesch(ä|ae)ftsf(ü|ue)hr/i.test(t));
  return gf ? 'gf_gehalt' : e.employment_type === 'minijob' ? 'aushilfsgehalt' : 'gehalt';
}

/** Monatsgehalt anteilig nach Kalendertagen der Beschäftigung im Monat (kaufmännisch auf Cent). */
export function proratedSalary(cents: bigint, from: string, to: string, entry: string, exit: string | null) {
  const s = entry > from ? entry : from;
  const e = exit && exit < to ? exit : to;
  const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
  const total = days(from, to);
  const worked = Math.max(0, days(s, e));
  if (worked >= total) return cents;
  return (cents * BigInt(worked) * 2n + BigInt(total)) / (2n * BigInt(total));
}

/**
 * Gehaltsabzug für unbezahlte Abwesenheit (konkrete Berechnung): Monatsgehalt ÷ Soll-Minuten des Monats laut
 * Einsatzplan × ausgefallene Minuten, kaufmännisch auf Cent, höchstens das Gehalt. Ohne Einsatzplan: Stundensatz aus
 * dem Gehalt (Gehalt ÷ 4,33 ÷ Wochenstunden). Beispiel: 585 € bei 43 Std. Soll im Monat, 3 Tage à 2 Std. unbezahlt = 81,63 €.
 */
export function unpaidDeduction(
  salaryCents: bigint,
  unpaidMinutes: number,
  baseMinutes: number,
  hourlyCents: bigint | null,
): bigint {
  if (unpaidMinutes <= 0 || salaryCents <= 0n) return 0n;
  let c: bigint;
  if (baseMinutes > 0) {
    if (unpaidMinutes >= baseMinutes) return salaryCents;
    c = (salaryCents * BigInt(unpaidMinutes) * 2n + BigInt(baseMinutes)) / (2n * BigInt(baseMinutes));
  } else if (hourlyCents && hourlyCents > 0n) c = (hourlyCents * BigInt(unpaidMinutes) * 2n + 60n) / 120n;
  else return 0n;
  return c > salaryCents ? salaryCents : c;
}

/**
 * Lohnarten eines Monats. Mit `cutoff` (Vorab-Abrechnung, Ahmed 09.10.: „Löhne müssen früher gedruckt werden“;
 * im laufenden Monat automatisch gestern, Ahmed 27.10.): erfasste Zeiten bis einschließlich Stichtag, danach die geplanten Einsätze bis Monatsende (ohne Abwesenheit,
 * Ausfall, Feiertag). Abwesenheiten zählen für den ganzen Monat. Mehrarbeit nur aus erfassten Zeiten.
 */
export async function payrollMonth(
  sql: Sql,
  month: string,
  employeeId?: string,
  opts: { cutoff?: string | null } = {},
): Promise<PayrollRow[]> {
  const { from, to } = monthRange(month);
  // Stichtag = Vortag des Monatsbeginns: ganzer Monat nach Plan (Export am 1. eines Monats)
  const cutoff = opts.cutoff && opts.cutoff >= addDays(from, -1) && opts.cutoff < to ? opts.cutoff : null;
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
      employment_type: string | null;
      tags: string[] | null;
      monthly_salary_cents: bigint | null;
      entry_date: string;
      exit_date: string | null;
    }[]
  >`
    select e.id, e.personnel_no, e.last_name || ', ' || e.first_name as name, app.effective_wage_cents(e) as wage_cents,
           e.pay_model, e.regular_sunday_work, e.employment_type::text, e.tags, e.monthly_salary_cents,
           e.entry_date::text, e.exit_date::text
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
  // Soll-Minuten des Monats laut Einsatzplan (inkl. Feier- und Abwesenheitstage) = Grundlage des Gehaltsabzugs
  const planBase = new Map<string, number>();
  for (const sh of await plannedShifts(sql, { from, to, ...(employeeId ? { employeeId } : {}) })) {
    const emp = sh.plan.employee_id;
    if (!emp || sh.exception?.kind === 'ausfall') continue;
    planBase.set(emp, (planBase.get(emp) ?? 0) + Math.max(0, sh.minutes));
    if (!sh.holiday || sh.entry || sh.absence) continue;
    holidayPay.set(emp, (holidayPay.get(emp) ?? 0) + Math.max(0, sh.minutes));
  }
  for (const h of absHours)
    if (!h.shift_plan_id) planBase.set(h.employee_id, (planBase.get(h.employee_id) ?? 0) + h.minutes);
  // Abwesenheitsminuten je Einsatz und Tag (für halbe Tage in der Vorab-Abrechnung)
  const absOnShift = new Map<string, number>();
  for (const h of absHours)
    if (h.shift_plan_id) {
      const k = `${h.employee_id}|${h.shift_plan_id}|${h.work_date}`;
      absOnShift.set(k, (absOnShift.get(k) ?? 0) + h.minutes);
    }
  // Vorab: geplante Einsätze nach dem Stichtag als Zeiten (Beginn/Ende in Berliner Zeit)
  const forecast: {
    employee_id: string;
    start_at: Date;
    end_at: Date;
    break_minutes: number;
    holidayWork: boolean;
    /** nur Restminuten (Einsatz mit teilweiser Abwesenheit, z. B. halber Urlaubstag) – ohne Zuschläge */
    restMinutes?: number;
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
      if (!emp || sh.holiday || sh.exception?.kind === 'ausfall') continue;
      const st = sh.plan.start_time;
      const en = sh.plan.end_time;
      const endDate = en <= st ? addDays(sh.date, 1) : sh.date;
      if (sh.absence) {
        // Abwesenheit zählt über ihre Stunden (Urlaub, Krank …) – Normalstunden nur für den Rest des Einsatzes,
        // sonst stünde die Zeit doppelt im Export (Ahmed 28.10.: 39 Std. mit 5 Std. Urlaub = 34 + 5)
        const absMin = absOnShift.get(`${emp}|${sh.plan.id}|${sh.date}`) ?? 0;
        const rest = Math.max(0, sh.minutes) - absMin;
        if (absMin > 0 && rest > 0)
          forecast.push({
            employee_id: emp,
            start_at: berlinAt(sh.date, st),
            end_at: berlinAt(endDate, en),
            break_minutes: 0,
            holidayWork: false,
            restMinutes: rest,
          });
        continue;
      }
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
      if (f.restMinutes != null) {
        m.normal += f.restMinutes;
        fc += f.restMinutes;
        continue;
      }
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
    let unpaid = 0;
    for (const h of absHours) {
      if (h.employee_id !== e.id) continue;
      const k = kindOf.get(h.absence_id);
      if (!h.paid) {
        unpaid += h.minutes; // Stundenlohn: nicht bezahlt; Festgehalt: Abzug (unten)
        continue;
      }
      if (k === 'urlaub') m.urlaub += h.minutes;
      else if (k === 'krank' || k === 'kind_krank') m.krank += h.minutes;
      else m.normal += h.minutes; // sonstige bezahlte Abwesenheit = Normalstunden
    }
    // Minijob mit Stundenlohn: gearbeitete Stunden als Aushilfslohn
    if (e.employment_type === 'minijob' && e.pay_model !== 'festgehalt') {
      m.aushilfslohn = m.normal;
      m.normal = 0;
    }
    const salary =
      e.pay_model === 'festgehalt' && e.monthly_salary_cents
        ? {
            type: salaryTypeOf(e),
            cents: proratedSalary(BigInt(e.monthly_salary_cents), from, to, e.entry_date, e.exit_date),
          }
        : null;
    const unpaidDeductionCents = salary?.cents
      ? unpaidDeduction(salary.cents, unpaid, planBase.get(e.id) ?? 0, e.wage_cents)
      : 0n;
    const bp: Record<SurchargeKind, number> = {
      nacht: rates.night,
      sonntag: e.regular_sunday_work ? rates.sundayRegular : rates.sunday,
      feiertag: e.regular_sunday_work ? rates.sundayRegular : rates.holiday,
      feiertag_hoch: e.regular_sunday_work ? rates.sundayRegular : rates.highHoliday,
    };
    const sc = Object.fromEntries(
      SURCHARGES.map((k) => [k, e.wage_cents ? surchargeCents(m[k], e.wage_cents, bp[k]) : 0n]),
    ) as Record<SurchargeKind, bigint>;
    if (HOUR_TYPES.some((k) => m[k]) || pending || salary?.cents || unpaid)
      rows.push({
        employee_id: e.id,
        personnel_no: e.personnel_no,
        name: e.name,
        wage_cents: e.wage_cents,
        pay_model: e.pay_model,
        regular_sunday_work: e.regular_sunday_work,
        minutes: m,
        salary,
        unpaidMinutes: unpaid,
        unpaidDeductionCents,
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
/** Cent-Betrag mit Vorzeichen (Abzüge und Korrekturen sind negativ). */
const eurSigned = (c: bigint) => (c < 0n ? `-${eur(-c)}` : eur(c));

/** CSV für den Lohnimport: je Mitarbeiter und Lohnart eine Zeile (Format vorläufig, an Lexware anpassen). */
export function payrollCsv(
  rows: PayrollRow[],
  s: PayrollSettings,
  month: string,
  corrections?: { month: string; rows: PayrollCorrection[] },
): string {
  const safe = (v: string) => (/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/;/g, ',');
  const out = ['\uFEFFMonat;Personalnummer;Name;Lohnart-Nr.;Lohnart;Stunden;Satz %;Stundenlohn;Betrag'];
  for (const r of rows) {
    if (r.salary)
      out.push(
        [
          month,
          safe(r.personnel_no),
          safe(r.name),
          safe(s.wage_type_numbers[r.salary.type] ?? ''),
          WAGE_TYPE_LABEL[r.salary.type],
          '',
          '',
          '',
          eur(r.salary.cents),
        ].join(';'),
      );
    if (r.unpaidDeductionCents)
      out.push(
        [
          month,
          safe(r.personnel_no),
          safe(r.name),
          safe(s.wage_type_numbers.unbezahlt ?? ''),
          WAGE_TYPE_LABEL.unbezahlt,
          dec(r.unpaidMinutes),
          '',
          '',
          eurSigned(-r.unpaidDeductionCents),
        ].join(';'),
      );
    for (const k of HOUR_TYPES) {
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
  }
  // Korrektur Vormonat (Vorab-Abrechnung): Differenz in Stunden, Beträge rechnet das Lohnprogramm
  for (const r of corrections?.rows ?? [])
    for (const k of HOUR_TYPES) {
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
          r.cents?.[k] != null ? eurSigned(r.cents[k]!) : '',
        ].join(';'),
      );
    }
  for (const r of corrections?.rows ?? [])
    if (r.unpaidCents)
      out.push(
        [
          `${corrections!.month} Korrektur`,
          safe(r.personnel_no),
          safe(r.name),
          safe(s.wage_type_numbers.unbezahlt ?? ''),
          WAGE_TYPE_LABEL.unbezahlt,
          '',
          '',
          '',
          eurSigned(-r.unpaidCents),
        ].join(';'),
      );
  return `${out.join('\r\n')}\r\n`;
}

/** Zuschlag in Cent auch für negative Minuten (Korrektur), kaufmännisch gerundet. */
const surchargeSigned = (minutes: number, wage: bigint, bp: number) =>
  minutes < 0 ? -surchargeCents(-minutes, wage, bp) : surchargeCents(minutes, wage, bp);

/**
 * ASCII-Import für Lexware lohn+gehalt / Financial Office (Ahmed 11.10.: „ASCII also ANSI-Import“, Felder
 * „Jahr, Monat, Personalnummer, Lohnartnummer, Wert“): Windows-1252, Semikolon, Dezimalkomma, CRLF, ohne Kopfzeile.
 * Wert = Stunden bei Stunden-Lohnarten (Lexware rechnet × Stundenlohn), Euro-Betrag bei Zuschlägen (unsere Sätze)
 * und Gehältern. Bei Festgehalt keine Grundlohn-Stunden (im Gehalt enthalten), nur Gehalt + Zuschläge.
 * Nur Lohnarten mit hinterlegter Nummer. Korrekturen des Vormonats (Vorab-Abrechnung) im Exportmonat mit der
 * Differenz (auch minus). Rückgabe: Text, Lohnarten ohne Nummer, Personen ohne Stundenlohn (Zuschlag nicht berechnet).
 */
export function payrollLexwareAscii(
  rows: PayrollRow[],
  s: PayrollSettings,
  month: string,
  corrections?: PayrollCorrection[],
): { text: string; missing: WageType[]; noWage: string[] } {
  const out: string[] = [];
  const missing = new Set<WageType>();
  const noWage = new Set<string>();
  const [year, mon] = [month.slice(0, 4), String(Number(month.slice(5, 7)))];
  const clean = (v: string) => v.replace(/[;\r\n]/g, ' ').trim();
  const push = (no: string, k: WageType, value: string) => {
    const nr = clean(s.wage_type_numbers[k] ?? '');
    if (!nr) {
      missing.add(k);
      return;
    }
    out.push([year, mon, clean(no), nr, value].join(';'));
  };
  for (const r of rows) {
    if (r.salary?.cents) push(r.personnel_no, r.salary.type, eurSigned(r.salary.cents));
    if (r.unpaidDeductionCents) push(r.personnel_no, 'unbezahlt', eurSigned(-r.unpaidDeductionCents));
    for (const k of HOUR_TYPES) {
      const v = r.minutes[k] ?? 0;
      if (!v || (r.salary && BASE_HOURS.includes(k))) continue;
      if (!isAmount(k)) push(r.personnel_no, k, dec(v));
      else if (!r.wage_cents) noWage.add(r.name);
      else
        push(
          r.personnel_no,
          k,
          eurSigned(k === 'mehrarbeit' ? r.overtimeCents : r.surchargeCents[k as SurchargeKind]),
        );
    }
  }
  for (const r of corrections ?? [])
    for (const k of HOUR_TYPES) {
      const v = r.minutes[k] ?? 0;
      if (!v || (r.salaried && BASE_HOURS.includes(k))) continue;
      const a = r.cents?.[k];
      if (!isAmount(k)) push(r.personnel_no, k, dec(v));
      else if (a == null) noWage.add(r.name);
      else push(r.personnel_no, k, eurSigned(a));
    }
  for (const r of corrections ?? [])
    if (r.unpaidCents) push(r.personnel_no, 'unbezahlt', eurSigned(-r.unpaidCents));
  return { text: out.length ? `${out.join('\r\n')}\r\n` : '', missing: [...missing], noWage: [...noWage] };
}

/** Zuschläge (inkl. Mehrarbeit) werden als Betrag exportiert, alle übrigen Stunden-Lohnarten als Stunden. */
const isAmount = (k: HourType) => k === 'mehrarbeit' || (SURCHARGES as string[]).includes(k);

/** Vorab-Export festhalten (Grundlage für die Korrektur im Folgemonat). */
export async function recordPayrollExport(
  sql: Sql,
  month: string,
  cutoff: string | null,
  rows: PayrollRow[],
  actor: string,
) {
  const data = rows.map((r) => ({
    employee_id: r.employee_id,
    minutes: r.minutes,
    unpaid_cents: String(r.unpaidDeductionCents),
  }));
  await sql`insert into app.payroll_exports (id, month, cutoff, rows, created_by)
            values (gen_random_uuid(), ${month}, ${cutoff}, ${sql.json(data as never)}, ${actor})`;
}

export interface PayrollCorrection {
  employee_id: string;
  personnel_no: string;
  name: string;
  /** tatsächlich − vorab exportiert, je Lohnart (Minuten, auch negativ) */
  minutes: Partial<Record<HourType, number>>;
  /** Betrag der Differenz bei Zuschlägen (Cent, auch negativ; fehlt ohne Stundenlohn) */
  cents?: Partial<Record<HourType, bigint>>;
  /** Festgehalt: Grundlohn-Stunden sind im Gehalt enthalten */
  salaried?: boolean;
  /** Differenz des Gehaltsabzugs für unbezahlte Abwesenheit (Cent, positiv = mehr Abzug) */
  unpaidCents?: bigint;
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
    {
      cutoff: string | null;
      rows: { employee_id: string; minutes: Record<string, number>; unpaid_cents?: string }[];
    }[]
  >`
    select cutoff::text, rows from app.payroll_exports where month = ${month} order by created_at desc limit 1`;
  if (!ex?.cutoff) return { cutoff: null, rows: [] };
  const [actual, settings] = await Promise.all([payrollMonth(sql, month), getPayrollSettings(sql)]);
  // ältere Exporte: „sonstige“ war eine eigene Lohnart (jetzt Normalstunden), „unbezahlt“ gibt es nicht mehr,
  // Minijob-Stunden standen unter Normalstunden (jetzt Aushilfslohn)
  const minijob = new Set(actual.filter((r) => r.minutes.aushilfslohn).map((r) => r.employee_id));
  const before = new Map(
    ex.rows.map((r) => {
      const m: Record<string, number> = { ...r.minutes };
      if ('sonstige' in m || 'unbezahlt' in m) {
        m.normal = (m.normal ?? 0) + (m.sonstige ?? 0);
        delete m.sonstige;
        delete m.unbezahlt;
      }
      if (!('aushilfslohn' in m) && minijob.has(r.employee_id)) {
        m.aushilfslohn = m.normal ?? 0;
        m.normal = 0;
      }
      return [r.employee_id, m];
    }),
  );
  const ids = new Set([...actual.map((r) => r.employee_id), ...before.keys()]);
  const names = await sql<{ id: string; personnel_no: string; name: string }[]>`
    select id, personnel_no, last_name || ', ' || first_name as name from app.employees where id = any(${[...ids]}::uuid[])`;
  const out: PayrollCorrection[] = [];
  for (const id of ids) {
    const act = actual.find((r) => r.employee_id === id);
    const now = act?.minutes;
    const was = before.get(id);
    const diff: Partial<Record<HourType, number>> = {};
    const cents: Partial<Record<HourType, bigint>> = {};
    for (const k of HOUR_TYPES) {
      const d = (now?.[k] ?? 0) - (was?.[k] ?? 0);
      if (!d) continue;
      diff[k] = d;
      if (act?.wage_cents && isAmount(k))
        cents[k] = surchargeSigned(
          d,
          act.wage_cents,
          k === 'mehrarbeit' ? settings.overtime_bp : act.bp[k as SurchargeKind],
        );
    }
    const n = names.find((x) => x.id === id);
    const wasUnpaid = BigInt(ex.rows.find((r) => r.employee_id === id)?.unpaid_cents ?? '0');
    const unpaidCents = (act?.unpaidDeductionCents ?? 0n) - wasUnpaid;
    if ((Object.keys(diff).length || unpaidCents) && n)
      out.push({
        employee_id: id,
        personnel_no: n.personnel_no,
        name: n.name,
        minutes: diff,
        cents,
        salaried: !!act?.salary,
        ...(unpaidCents ? { unpaidCents } : {}),
      });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return { cutoff: ex.cutoff, rows: out };
}
