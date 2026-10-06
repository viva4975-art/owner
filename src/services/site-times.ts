import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { addDays } from '../domain/time/holidays.js';
import { BusinessError } from './errors.js';
import { type PlannedShift, type TimeEntryRow, listEntries, netMinutes, plannedShifts } from './time.js';

/** Erfasste Zeiten eines Objekts (wie Fortytools): je Mitarbeiter Dauer (Ist) und Geplant (Soll laut Einsatzplan). */

export interface EmployeeTimeSum {
  employee_id: string;
  name: string;
  personnel_no: string;
  entries: number;
  actual: number;
  planned: number;
  /** Nachträge, die noch auf Freigabe warten */
  pending: number;
}

/** Ist zählt: erfasst und freigegeben (nicht laufend, nicht abgelehnt, nicht beantragt). */
export const countsAsActual = (e: Pick<TimeEntryRow, 'status'>) =>
  e.status === 'erfasst' || e.status === 'freigegeben';

const lastOfMonth = (month: string) => addDays(`${nextMonth(month)}-01`, -1);
export function nextMonth(month: string) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
export function prevMonth(month: string) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
export const monthRange = (month: string) => ({ from: `${month}-01`, to: lastOfMonth(month) });

export async function siteTimes(sql: Sql, siteId: string, from: string, to: string) {
  const [entries, shifts] = await Promise.all([
    listEntries(sql, { siteId, from, to }),
    plannedShifts(sql, { siteId, from, to }),
  ]);
  const byEmp = new Map<string, EmployeeTimeSum>();
  const get = (id: string, name: string, no: string) => {
    let x = byEmp.get(id);
    if (!x) {
      x = { employee_id: id, name, personnel_no: no, entries: 0, actual: 0, planned: 0, pending: 0 };
      byEmp.set(id, x);
    }
    return x;
  };
  for (const e of entries) {
    const x = get(e.employee_id, e.employee_name, e.personnel_no);
    if (countsAsActual(e)) {
      x.entries++;
      x.actual += netMinutes(e);
    } else if (e.status === 'beantragt') x.pending++;
  }
  for (const s of shifts) {
    if (s.holiday) continue;
    get(s.plan.employee_id, s.plan.employee_name, s.plan.personnel_no).planned += s.minutes;
  }
  const sums = [...byEmp.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return {
    entries: [...entries].sort(
      (a, b) => a.work_date.localeCompare(b.work_date) || a.start_at.getTime() - b.start_at.getTime(),
    ),
    shifts,
    sums,
    total: {
      actual: sums.reduce((a, s) => a + s.actual, 0),
      planned: sums.reduce((a, s) => a + s.planned, 0),
      entries: sums.reduce((a, s) => a + s.entries, 0),
      pending: sums.reduce((a, s) => a + s.pending, 0),
    },
  };
}

/** Geplante Minuten eines Einsatzes für den Vergleich in der Detailansicht. */
export const plannedFor = (shifts: PlannedShift[], e: TimeEntryRow) =>
  shifts.find((s) => s.entry?.id === e.id && !s.holiday)?.minutes ?? null;

export interface MonthRow {
  month: string;
  actual: number;
  planned: number;
  confirmed: { by: string; at: Date; minutes: number } | null;
}

/** Monatsübersicht der letzten `n` Monate bis einschließlich `upTo` (JJJJ-MM). */
export async function siteMonthOverview(
  sql: Sql,
  siteId: string,
  upTo: string,
  n = 12,
  today?: string,
): Promise<MonthRow[]> {
  const months: string[] = [];
  for (let m = upTo, i = 0; i < n; i++, m = prevMonth(m)) months.push(m);
  const first = months[months.length - 1]!;
  const { entries, shifts } = await siteTimes(
    sql,
    siteId,
    `${first}-01`,
    today && today < lastOfMonth(upTo) ? today : lastOfMonth(upTo),
  );
  const conf = await sql<
    { month: string; confirmed: boolean; actor: string; created_at: Date; minutes: number }[]
  >`
    select distinct on (month) to_char(month, 'YYYY-MM') as month, confirmed, actor, created_at, minutes
      from app.site_time_confirmations where site_id = ${siteId}
     order by month, created_at desc`;
  return months.map((m) => {
    const c = conf.find((x) => x.month === m);
    return {
      month: m,
      actual: entries
        .filter((e) => e.work_date.startsWith(m) && countsAsActual(e))
        .reduce((a, e) => a + netMinutes(e), 0),
      planned: shifts.filter((s) => s.date.startsWith(m) && !s.holiday).reduce((a, s) => a + s.minutes, 0),
      confirmed: c?.confirmed ? { by: c.actor, at: c.created_at, minutes: c.minutes } : null,
    };
  });
}

/**
 * „Zeiterfassung bestätigt“ setzen oder zurücknehmen. Bestätigen nur, wenn im Monat nichts mehr offen ist
 * (laufende Stempelung, Nachtrag ohne Entscheidung) und der Monat begonnen hat.
 */
export async function confirmSiteMonth(
  sql: Sql,
  siteId: string,
  month: string,
  confirmed: boolean,
  actor: string,
  today: string,
) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new BusinessError('Monat ungültig');
  if (`${month}-01` > today) throw new BusinessError('Ein künftiger Monat kann nicht bestätigt werden');
  const { from, to } = monthRange(month);
  const entries = await listEntries(sql, { siteId, from, to });
  if (confirmed) {
    const open = entries.filter((e) => e.status === 'laeuft' || e.status === 'beantragt');
    if (open.length)
      throw new BusinessError(
        `Noch ${open.length} offene Zeit(en) im Monat (laufende Stempelung oder Nachtrag ohne Freigabe) – bitte zuerst klären.`,
      );
  }
  const minutes = entries.filter(countsAsActual).reduce((a, e) => a + netMinutes(e), 0);
  await sql`
    insert into app.site_time_confirmations (id, site_id, month, confirmed, minutes, actor)
    values (${randomUUID()}, ${siteId}, ${`${month}-01`}, ${confirmed}, ${minutes}, ${actor})`;
}
