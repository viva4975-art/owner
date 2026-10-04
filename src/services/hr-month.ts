import type { Sql } from '../db/client.js';
import { monthBounds } from '../domain/invoice/calc.js';
import { addDays, holidayName, workingDays } from '../domain/time/holidays.js';
import { BusinessError } from './errors.js';
import { listAbsences } from './absences.js';
import { listEntries, netMinutes, plannedShifts } from './time.js';

/*
 * Soll / Plan / Ist je Mitarbeiter und Monat (wie Fortytools „Dispo & Zeiterfassung“):
 *   Soll = Wochenstunden ÷ 5 × Arbeitstage (Mo–Fr ohne Feiertage Bayern) im Beschäftigungszeitraum des Monats
 *   Plan = geplante Einsätze (ohne Feiertage und genehmigte Abwesenheiten)
 *   Ist  = erfasste Zeiten netto (ohne abgelehnte)
 * Alles in Minuten.
 */
export async function sollPlanIst(sql: Sql, employeeId: string, month: string) {
  const [e] = await sql<{ weekly_hours: string | null; entry_date: string; exit_date: string | null }[]>`
    select weekly_hours::text, entry_date, exit_date from app.employees where id = ${employeeId}`;
  if (!e) throw new BusinessError('Mitarbeiter nicht gefunden');
  const { start, end } = monthBounds(month);
  const from = e.entry_date > start ? e.entry_date : start;
  const to = e.exit_date && e.exit_date < end ? e.exit_date : end;
  const days = from > to ? 0 : workingDays(from, to);
  const soll = e.weekly_hours ? Math.round((Number(e.weekly_hours) * 60 * days) / 5) : null;
  const shifts = await plannedShifts(sql, { from: start, to: end, employeeId });
  const plan = shifts.filter((s) => !s.holiday && !s.absence).reduce((a, s) => a + s.minutes, 0);
  const entries = await listEntries(sql, { from: start, to: end, employeeId });
  const ist = entries
    .filter((x) => x.status !== 'abgelehnt' && x.end_at)
    .reduce((a, x) => a + netMinutes(x), 0);
  return { month, soll, plan, ist };
}

export interface CalendarDay {
  date: string;
  holiday: string | undefined;
  absence: string | null;
  shifts: { site: string; from: string; to: string; minutes: number; done: boolean }[];
  extra: { site: string; minutes: number }[]; // Ist-Zeiten ohne Einsatz
}

/** Einsatzkalender eines Mitarbeiters für einen Monat (Einsätze, Abwesenheiten, Feiertage, Ist-Zeiten). */
export async function employeeCalendar(sql: Sql, employeeId: string, month: string): Promise<CalendarDay[]> {
  const { start, end } = monthBounds(month);
  const [shifts, entries, absences] = await Promise.all([
    plannedShifts(sql, { from: start, to: end, employeeId }),
    listEntries(sql, { from: start, to: end, employeeId }),
    listAbsences(sql, { employeeId, from: start, to: end }),
  ]);
  const used = new Set(shifts.map((s) => s.entry?.id).filter(Boolean));
  const days: CalendarDay[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const abs = absences.find((a) => a.status === 'genehmigt' && a.start_date <= d && a.end_date >= d);
    days.push({
      date: d,
      holiday: undefined,
      absence: abs?.kind ?? null,
      shifts: shifts
        .filter((s) => s.date === d)
        .map((s) => ({
          site: s.plan.site_name,
          from: s.plan.start_time,
          to: s.plan.end_time,
          minutes: s.minutes,
          done: !!s.entry,
        })),
      extra: entries
        .filter((x) => x.work_date === d && !used.has(x.id) && x.status !== 'abgelehnt')
        .map((x) => ({ site: x.site_name, minutes: netMinutes(x) })),
    });
  }
  for (const day of days) day.holiday = holidayName(day.date);
  return days;
}
