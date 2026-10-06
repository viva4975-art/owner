import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, holidayName, isoWeekday } from '../domain/time/holidays.js';
import { ABSENCE_LABEL, type AbsenceKind, listAbsenceHours } from './absences.js';
import { BusinessError } from './errors.js';
import { breakRange, clock, listEntries, plannedShifts } from './time.js';
import type { Deps } from './workflow.js';

/*
 * Stundenzettel je Mitarbeiter und Monat (§ 17 MiLoG: Beginn, Ende und Dauer der täglichen Arbeitszeit;
 * dazu Pause mit Lage, Soll aus dem Einsatzplan, Urlaub/Krank/unbezahlt). Unterschrift des Mitarbeiters in der App
 * am Monatsende: Inhalt wird als Prüfsumme festgehalten – spätere Änderungen sind erkennbar.
 */

export interface SheetRow {
  date: string;
  holiday: string | null;
  site: string | null;
  /** geplant (Soll) */
  planFrom: string | null;
  planTo: string | null;
  planMinutes: number;
  /** Ist */
  start: string | null;
  end: string | null;
  breakFrom: string | null;
  breakTo: string | null;
  breakMinutes: number;
  workMinutes: number;
  /** Abwesenheit */
  absence: AbsenceKind | null;
  absenceMinutes: number;
  absencePaid: boolean;
  status: string | null;
  late: boolean;
  note: string | null;
}

export interface SheetTotals {
  plan: number;
  work: number;
  breaks: number;
  vacation: number;
  sick: number;
  otherPaid: number;
  unpaid: number;
  paid: number;
  diff: number;
}

export interface Timesheet {
  employee: {
    id: string;
    name: string;
    personnel_no: string;
    employment_type: string;
    weekly_hours: string | null;
  };
  month: string;
  from: string;
  to: string;
  rows: SheetRow[];
  totals: SheetTotals;
  /** offene Punkte, die eine Unterschrift verhindern */
  open: { running: number; pending: number };
  hash: string;
}

export const monthRange = (month: string) => {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new BusinessError('Monat ungültig');
  const from = `${month}-01`;
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return { from, to: d.toISOString().slice(0, 10) };
};

export const MONTH_NAMES = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];
export const monthLabel = (month: string) =>
  `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

export async function timesheet(sql: Sql, employeeId: string, month: string): Promise<Timesheet> {
  const { from, to } = monthRange(month);
  const [e] = await sql<Timesheet['employee'][]>`
    select id, last_name || ', ' || first_name as name, personnel_no, employment_type::text, weekly_hours::text
      from app.employees where id = ${employeeId}`;
  if (!e) throw new BusinessError('Mitarbeiter nicht gefunden');
  const [shifts, entries, absHours] = await Promise.all([
    plannedShifts(sql, { from, to, employeeId }),
    listEntries(sql, { from, to, employeeId }),
    listAbsenceHours(sql, { employeeId, from, to }),
  ]);
  const kinds = new Map(
    (
      await sql<{ id: string; kind: AbsenceKind }[]>`
        select id, kind::text as kind from app.absences where employee_id = ${employeeId}
           and start_date <= ${to} and end_date >= ${from}`
    ).map((a) => [a.id, a.kind]),
  );
  const rows: SheetRow[] = [];
  const empty = (date: string): SheetRow => ({
    date,
    holiday: holidayName(date) ?? null,
    site: null,
    planFrom: null,
    planTo: null,
    planMinutes: 0,
    start: null,
    end: null,
    breakFrom: null,
    breakTo: null,
    breakMinutes: 0,
    workMinutes: 0,
    absence: null,
    absenceMinutes: 0,
    absencePaid: false,
    status: null,
    late: false,
    note: null,
  });
  const usedEntries = new Set<string>();
  const usedAbs = new Set<string>();
  for (const s of shifts) {
    const r = empty(s.date);
    r.site = s.plan.site_name;
    r.planFrom = s.plan.start_time;
    r.planTo = s.plan.end_time;
    r.planMinutes = s.holiday ? 0 : s.minutes;
    const en = s.entry && s.entry.status !== 'abgelehnt' ? s.entry : undefined;
    if (en) usedEntries.add(en.id);
    const ah = absHours.find((h) => h.shift_plan_id === s.plan.id && h.work_date === s.date);
    if (ah) {
      usedAbs.add(ah.id);
      r.absence = kinds.get(ah.absence_id) ?? null;
      r.absenceMinutes = ah.minutes;
      r.absencePaid = ah.paid;
    } else if (s.absence) r.absence = s.absence as AbsenceKind;
    if (en) fillEntry(r, en);
    rows.push(r);
  }
  for (const en of entries) {
    if (usedEntries.has(en.id) || en.status === 'abgelehnt') continue;
    const r = empty(en.work_date);
    r.site = en.site_name;
    fillEntry(r, en);
    rows.push(r);
  }
  for (const h of absHours) {
    if (usedAbs.has(h.id)) continue;
    const r = empty(h.work_date);
    r.site = h.site_name;
    r.absence = kinds.get(h.absence_id) ?? null;
    r.absenceMinutes = h.minutes;
    r.absencePaid = h.paid;
    rows.push(r);
  }
  rows.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.start ?? a.planFrom ?? '99').localeCompare(b.start ?? b.planFrom ?? '99'),
  );
  const t: SheetTotals = {
    plan: 0,
    work: 0,
    breaks: 0,
    vacation: 0,
    sick: 0,
    otherPaid: 0,
    unpaid: 0,
    paid: 0,
    diff: 0,
  };
  for (const r of rows) {
    t.plan += r.planMinutes;
    // nur erfasste/freigegebene Zeiten zählen; Nachträge in Prüfung nicht
    if (r.status === 'erfasst' || r.status === 'freigegeben') {
      t.work += r.workMinutes;
      t.breaks += r.breakMinutes;
    }
    if (r.absence && r.absenceMinutes) {
      if (!r.absencePaid) t.unpaid += r.absenceMinutes;
      else if (r.absence === 'urlaub') t.vacation += r.absenceMinutes;
      else if (r.absence === 'krank' || r.absence === 'kind_krank') t.sick += r.absenceMinutes;
      else t.otherPaid += r.absenceMinutes;
    }
  }
  t.paid = t.work + t.vacation + t.sick + t.otherPaid;
  t.diff = t.paid - t.plan;
  const open = {
    running: entries.filter((x) => x.status === 'laeuft').length,
    pending: entries.filter((x) => x.status === 'beantragt').length,
  };
  const hash = createHash('sha256')
    .update(
      JSON.stringify(
        rows.map((r) => [
          r.date,
          r.site,
          r.start,
          r.end,
          r.breakFrom,
          r.breakTo,
          r.workMinutes,
          r.absence,
          r.absenceMinutes,
          r.absencePaid,
          r.status,
        ]),
      ),
    )
    .digest('hex');
  return { employee: e, month, from, to, rows, totals: t, open, hash };
}

function fillEntry(r: SheetRow, en: Awaited<ReturnType<typeof listEntries>>[number]) {
  r.start = clock(en.start_at);
  r.end = en.end_at ? clock(en.end_at) : null;
  const br = breakRange(en);
  r.breakFrom = br ? clock(br.from) : null;
  r.breakTo = br ? clock(br.to) : null;
  r.breakMinutes = en.break_minutes;
  r.workMinutes = en.end_at ? Math.max(0, en.gross_minutes - en.break_minutes) : 0;
  r.status = en.status;
  r.late = en.late;
  r.note = en.note;
  if (!r.site) r.site = en.site_name;
}

export const ABSENCE_SHORT: Record<AbsenceKind, string> = {
  ...ABSENCE_LABEL,
  unbezahlt: 'Unbezahlt',
};

// ---------------------------------------------------------------- Unterschrift

export interface SheetSignature {
  id: string;
  employee_id: string;
  month: string;
  sheet_hash: string;
  signature_path: string;
  signature_sha256: string;
  signed_at: Date;
  ip: string | null;
}

export async function latestSignature(sql: Sql, employeeId: string, month: string) {
  const [s] = await sql<SheetSignature[]>`
    select id, employee_id, month, sheet_hash, signature_path, signature_sha256, signed_at, ip
      from app.timesheet_signatures where employee_id = ${employeeId} and month = ${month}
     order by signed_at desc limit 1`;
  return s;
}

/** Unterschriften aller Mitarbeitenden eines Monats (für die Büro-Übersicht). */
export async function signaturesOfMonth(sql: Sql, month: string) {
  const rows = await sql<{ employee_id: string; sheet_hash: string; signed_at: Date }[]>`
    select distinct on (employee_id) employee_id, sheet_hash, signed_at
      from app.timesheet_signatures where month = ${month} order by employee_id, signed_at desc`;
  return new Map(rows.map((r) => [r.employee_id, r]));
}

/** Darf der Monat schon unterschrieben werden? Ab dem letzten Tag des Monats. */
export const signable = (month: string, today = todayBerlin()) => monthRange(month).to <= today;

/** Monat, der in der App zur Unterschrift angeboten wird: am letzten Tag der laufende, sonst der Vormonat. */
export function monthToSign(today = todayBerlin()): string {
  const cur = today.slice(0, 7);
  if (monthRange(cur).to === today) return cur;
  return addDays(`${cur}-01`, -1).slice(0, 7);
}

export async function signTimesheet(
  deps: Deps,
  p: {
    employeeId: string;
    month: string;
    png: Uint8Array;
    confirmed: boolean;
    ip: string | null;
    userAgent: string | null;
  },
) {
  const { sql } = deps;
  if (!p.confirmed) throw new BusinessError('Bitte bestätigen, dass die Zeiten stimmen', 'confirm_required');
  if (!signable(p.month)) throw new BusinessError('Unterschreiben geht erst am Monatsende', 'sheet_month');
  if (p.png.length < 200 || p.png.length > 2_000_000)
    throw new BusinessError('Unterschrift fehlt', 'signature');
  const sheet = await timesheet(sql, p.employeeId, p.month);
  if (!sheet.rows.some((r) => r.workMinutes || r.absenceMinutes))
    throw new BusinessError('Keine Zeiten in diesem Monat', 'sheet_empty');
  if (sheet.open.running || sheet.open.pending)
    throw new BusinessError('Es gibt noch offene Zeiten', 'sheet_open');
  const [same] = await sql`
    select 1 from app.timesheet_signatures
     where employee_id = ${p.employeeId} and month = ${p.month} and sheet_hash = ${sheet.hash}`;
  if (same) return; // schon genau so unterschrieben (doppelt gesendet)
  const sha = createHash('sha256').update(p.png).digest('hex');
  const path = `stundenzettel/${sha.slice(0, 2)}/${sha}.png`;
  await deps.archive.put(path, p.png);
  await sql`
    insert into app.timesheet_signatures ${sql({
      id: randomUUID(),
      employee_id: p.employeeId,
      month: p.month,
      sheet_hash: sheet.hash,
      snapshot: sql.json({ rows: sheet.rows, totals: sheet.totals } as never),
      signature_path: path,
      signature_sha256: sha,
      ip: p.ip,
      user_agent: p.userAgent?.slice(0, 300) ?? null,
    } as never)} on conflict do nothing`;
}

/** Wochentag kurz (Mo …) für den Stundenzettel */
export const dayShort = (d: string) => ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'][isoWeekday(d)]!;
