import type { Sql } from '../db/client.js';
import {
  DEFAULT_RATES,
  type SurchargeKind,
  type SurchargeRates,
  surchargeCents,
  surchargeMinutes,
} from '../domain/time/surcharges.js';
import { addDays } from '../domain/time/holidays.js';
import { listAbsenceHours } from './absences.js';
import { BusinessError } from './errors.js';
import { breakRange, listEntries } from './time.js';
import { monthRange } from './timesheet.js';

/*
 * Lohnarten je Mitarbeiter und Monat für die Lohnabrechnung (Lexware): Normalstunden (gearbeitet), Urlaub, Krank,
 * sonstige bezahlte Abwesenheit, unbezahlt (nur zur Info) und Zuschlagsstunden nach RTV Gebäudereinigung.
 * Zuschläge werden zusätzlich zum Grundlohn gezahlt (Stunden × Lohn × Satz). Nur erfasste/freigegebene Zeiten.
 */

export type WageType =
  'normal' | 'urlaub' | 'krank' | 'sonstige' | 'unbezahlt' | SurchargeKind | 'mehrarbeit';

export const WAGE_TYPE_LABEL: Record<WageType, string> = {
  normal: 'Normalstunden',
  urlaub: 'Urlaub',
  krank: 'Krankheit (Lohnfortzahlung)',
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
}

const zero = (): Record<WageType, number> =>
  Object.fromEntries(WAGE_TYPES.map((k) => [k, 0])) as Record<WageType, number>;

export async function payrollMonth(sql: Sql, month: string, employeeId?: string): Promise<PayrollRow[]> {
  const { from, to } = monthRange(month);
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
    let pending = 0;
    for (const t of entries) {
      if (t.employee_id !== e.id) continue;
      if (t.status === 'beantragt' || t.status === 'laeuft') pending++;
      if ((t.status !== 'erfasst' && t.status !== 'freigegeben') || !t.end_at) continue;
      m.normal += Math.max(0, t.gross_minutes - t.break_minutes);
      const br = breakRange(t);
      const sm = surchargeMinutes(
        t.start_at,
        t.end_at,
        br?.from ?? null,
        br?.to ?? null,
        rates,
        e.regular_sunday_work,
      );
      for (const k of SURCHARGES) m[k] += sm[k];
    }
    m.mehrarbeit = overtime.get(e.id) ?? 0;
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
      });
  }
  return rows;
}

const dec = (minutes: number) => (minutes / 60).toFixed(2).replace('.', ',');
const eur = (c: bigint) => `${c / 100n},${String(c % 100n).padStart(2, '0')}`;

/** CSV für den Lohnimport: je Mitarbeiter und Lohnart eine Zeile (Format vorläufig, an Lexware anpassen). */
export function payrollCsv(rows: PayrollRow[], s: PayrollSettings, month: string): string {
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
  return `${out.join('\r\n')}\r\n`;
}
