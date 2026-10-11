import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, holidayName, isoWeekday } from '../domain/time/holidays.js';

/*
 * Ausfallzeiten für die Kalkulation (Ahmed 11.10.): je Mitarbeiter und Jahr Urlaubs- und Krankheitstage gegen die
 * Arbeitstage im Beschäftigungszeitraum, dazu Durchschnitte je Beschäftigungsart und gesamt.
 *
 * Grundlage (alles Arbeitstage Mo–Fr, halbe Tage 0,5):
 *  - Tage Mo–Fr = Kalender-Arbeitstage im Beschäftigungszeitraum (laufendes Jahr: nur bis heute)
 *  - Feiertage = gesetzliche Feiertage Bayern auf Mo–Fr
 *  - Urlaub / Krank (inkl. Kind krank) = genehmigte Abwesenheiten; übernommene Stände aus Fortytools zählen bis zu
 *    ihrem Stichtag, Abwesenheiten aus der App erst danach (nichts doppelt)
 *  - anwesend = Tage Mo–Fr − Feiertage − Urlaub − Krank
 *  - Ausfallquote = (Feiertage + Urlaub + Krank) ÷ Tage Mo–Fr
 *  - Ausfallzuschlag = (Feiertage + Urlaub + Krank) ÷ anwesend → Aufschlag auf die Stunde, die tatsächlich gearbeitet
 *    wird (für den Stundenverrechnungssatz)
 * Bei Teilzeit mit weniger als 5 Arbeitstagen je Woche ist das eine Näherung (Kalendertage statt Einsatztage).
 */

export interface AbsenceStatRow {
  id: string;
  name: string;
  personnel_no: string;
  employment_type: string;
  weekly_hours: number | null;
  from: string;
  to: string;
  weekdays: number;
  holidays: number;
  vacation: number;
  sick: number;
  child_sick: number; // davon Kind krank
  sick_cases: number;
  present: number;
}

export interface AbsenceStatSum {
  label: string;
  heads: number;
  /** Vollzeit-Jahre (Tage Mo–Fr ÷ Tage Mo–Fr des Zeitraums) – Basis für „Ø je Mitarbeiter“ */
  fte_years: number;
  weekdays: number;
  holidays: number;
  vacation: number;
  sick: number;
  child_sick: number;
  sick_cases: number;
  present: number;
  vacation_per_head: number;
  sick_per_head: number;
  sick_rate: number;
  vacation_rate: number;
  outage_rate: number;
  surcharge: number;
}

export const EMPLOYMENT_LABEL: Record<string, string> = {
  vollzeit: 'Vollzeit',
  teilzeit: 'Teilzeit',
  minijob: 'Minijob',
  werkstudent: 'Werkstudent',
  aushilfe: 'Aushilfe',
};

const clip = (a: string, b: string, from: string, to: string): [string, string] | null => {
  const s = a > from ? a : from;
  const e = b < to ? b : to;
  return s > e ? null : [s, e];
};

function countDays(from: string, to: string) {
  let weekdays = 0;
  let holidays = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (isoWeekday(d) > 5) continue;
    weekdays++;
    if (holidayName(d)) holidays++;
  }
  return { weekdays, holidays };
}

/** Arbeitstage (Mo–Fr ohne Feiertage) einer Abwesenheit innerhalb [from, to] */
function absenceDays(
  a: { start_date: string; end_date: string; half_day: boolean },
  from: string,
  to: string,
) {
  const r = clip(a.start_date, a.end_date, from, to);
  if (!r) return 0;
  const { weekdays, holidays } = countDays(r[0], r[1]);
  const n = weekdays - holidays;
  return a.half_day ? n / 2 : n;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export async function absenceStats(
  sql: Sql,
  year: number,
  today = todayBerlin(),
): Promise<{
  from: string;
  to: string;
  partial: boolean;
  rows: AbsenceStatRow[];
  groups: AbsenceStatSum[];
  total: AbsenceStatSum;
}> {
  const yFrom = `${year}-01-01`;
  const yEnd = `${year}-12-31`;
  const to = today < yEnd ? today : yEnd;
  const partial = to < yEnd;
  if (to < yFrom) {
    const empty = sumUp('Gesamt', [], countDays(yFrom, yFrom).weekdays || 1);
    return { from: yFrom, to: yFrom, partial: true, rows: [], groups: [], total: empty };
  }
  const emps = await sql<
    {
      id: string;
      name: string;
      personnel_no: string;
      employment_type: string;
      weekly_hours: string | null;
      entry_date: string;
      exit_date: string | null;
    }[]
  >`
    select id, last_name || ', ' || first_name as name, personnel_no, employment_type::text,
           weekly_hours::text, entry_date::text, exit_date::text
      from app.employees
     where entry_date <= ${to} and (exit_date is null or exit_date >= ${yFrom})
     order by last_name, first_name`;
  const abs = await sql<
    { employee_id: string; kind: string; start_date: string; end_date: string; half_day: boolean }[]
  >`
    select employee_id, kind::text, start_date::text, end_date::text, half_day
      from app.absences
     where status = 'genehmigt' and kind in ('urlaub', 'krank', 'kind_krank')
       and start_date <= ${to} and end_date >= ${yFrom}`;
  const openings = await sql<
    {
      employee_id: string;
      as_of: string;
      taken_days: string | null;
      sick_as_of: string | null;
      sick_days: string | null;
    }[]
  >`
    select employee_id, as_of::text, taken_days::text, sick_as_of::text, sick_days::text
      from app.leave_openings where year = ${year}`;
  const op = new Map(openings.map((o) => [o.employee_id, o]));
  const byEmp = new Map<string, (typeof abs)[number][]>();
  for (const a of abs) byEmp.set(a.employee_id, [...(byEmp.get(a.employee_id) ?? []), a]);

  const rows: AbsenceStatRow[] = [];
  for (const e of emps) {
    const r = clip(e.entry_date, e.exit_date ?? yEnd, yFrom, to);
    if (!r) continue;
    const [from, end] = r;
    const { weekdays, holidays } = countDays(from, end);
    const o = op.get(e.id);
    // übernommener Urlaub/Krank bis Stichtag; App-Abwesenheiten danach
    const vacCut = o?.taken_days != null && o.as_of <= end ? o.as_of : null;
    const sickCut = o?.sick_days != null && o.sick_as_of && o.sick_as_of <= end ? o.sick_as_of : null;
    let vacation = vacCut ? Number(o!.taken_days) : 0;
    let sick = sickCut ? Number(o!.sick_days) : 0;
    let child = 0;
    let cases = 0;
    for (const a of byEmp.get(e.id) ?? []) {
      if (a.kind === 'urlaub') {
        vacation += absenceDays(a, vacCut ? addDays(vacCut, 1) : from, end);
      } else {
        const d = absenceDays(a, sickCut ? addDays(sickCut, 1) : from, end);
        if (d <= 0) continue;
        sick += d;
        cases++;
        if (a.kind === 'kind_krank') child += d;
      }
    }
    rows.push({
      id: e.id,
      name: e.name,
      personnel_no: e.personnel_no,
      employment_type: e.employment_type,
      weekly_hours: e.weekly_hours == null ? null : Number(e.weekly_hours),
      from,
      to: end,
      weekdays,
      holidays,
      vacation: round1(vacation),
      sick: round1(sick),
      child_sick: round1(child),
      sick_cases: cases,
      present: round1(Math.max(0, weekdays - holidays - vacation - sick)),
    });
  }
  const full = countDays(yFrom, to).weekdays;
  const types = [...new Set(rows.map((r) => r.employment_type))].sort(
    (a, b) => Object.keys(EMPLOYMENT_LABEL).indexOf(a) - Object.keys(EMPLOYMENT_LABEL).indexOf(b),
  );
  return {
    from: yFrom,
    to,
    partial,
    rows,
    groups: types.map((t) =>
      sumUp(
        EMPLOYMENT_LABEL[t] ?? t,
        rows.filter((r) => r.employment_type === t),
        full,
      ),
    ),
    total: sumUp('Gesamt', rows, full),
  };
}

function sumUp(label: string, rows: AbsenceStatRow[], fullWeekdays: number): AbsenceStatSum {
  const s = (k: keyof AbsenceStatRow) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const weekdays = s('weekdays');
  const holidays = s('holidays');
  const vacation = s('vacation');
  const sick = s('sick');
  const present = s('present');
  const fte = fullWeekdays > 0 ? weekdays / fullWeekdays : 0;
  const q = (n: number, d: number) => (d > 0 ? n / d : 0);
  return {
    label,
    heads: rows.length,
    fte_years: round1(fte),
    weekdays,
    holidays,
    vacation: round1(vacation),
    sick: round1(sick),
    child_sick: round1(s('child_sick')),
    sick_cases: s('sick_cases'),
    present: round1(present),
    vacation_per_head: round1(q(vacation, fte)),
    sick_per_head: round1(q(sick, fte)),
    sick_rate: q(sick, weekdays),
    vacation_rate: q(vacation, weekdays),
    outage_rate: q(holidays + vacation + sick, weekdays),
    surcharge: q(holidays + vacation + sick, present),
  };
}

/** Anonymisierte Bezeichnung (Excel/PDF „geschwärzt“): fortlaufend nach Reihenfolge der Liste */
export const anonName = (i: number) => `Mitarbeiter/in ${String(i + 1).padStart(3, '0')}`;
