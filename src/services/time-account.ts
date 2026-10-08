import { sollMinutesFor } from '../domain/time/soll.js';
import type { Sql } from '../db/client.js';
import { monthBounds, todayBerlin } from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import { BusinessError } from './errors.js';
import { payrollMonth } from './payroll.js';

/*
 * Arbeitszeitkonto (Ahmed 08.10.: „ja Arbeitszeitkonto gute Idee“). Je Mitarbeiter und Monat:
 *   Soll = Wochenstunden × 4,33 je Monat (anteilig) (Mo–Fr ohne Feiertage Bayern, mit Stunden-Verlauf, im Beschäftigungszeitraum)
 *   Ist  = gearbeitet (erfasst/freigegeben, ohne Pause) + bezahlte Abwesenheit (Urlaub, Krank, Sonstige)
 *   Saldo Monat = Ist − Soll; Kontostand = Summe der Salden ab Startmonat + Buchungen (Startsaldo, Auszahlung …).
 * Rechtlich (§ 2 Abs. 2 MiLoG): Plusstunden höchstens 50 % der vereinbarten Monatsarbeitszeit und binnen 12 Monaten
 * ausgleichen (Freizeit oder Auszahlung) – darüber wird gewarnt. Bei Minijobs zusätzlich Verdienstgrenze beachten.
 */

export const BOOKING_KIND = {
  startsaldo: 'Startsaldo (Übernahme)',
  auszahlung: 'Auszahlung (Abbau)',
  freizeitausgleich: 'Freizeitausgleich',
  korrektur: 'Korrektur',
} as const;
export type BookingKind = keyof typeof BOOKING_KIND;

const monthIdx = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const monthOf = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

export async function getStartMonth(sql: Sql): Promise<string> {
  const [s] = await sql<
    { start_month: string | null }[]
  >`select start_month from app.time_account_settings where id = 1`;
  if (s?.start_month) return s.start_month;
  const [f] = await sql<
    { m: string | null }[]
  >`select to_char(min(work_date), 'YYYY-MM') as m from app.time_entries`;
  return f?.m ?? todayBerlin().slice(0, 7);
}

export async function setStartMonth(sql: Sql, month: string, actor: string) {
  monthBounds(month);
  await sql`update app.time_account_settings set start_month = ${month}, updated_at = now() where id = 1`;
  await sql`insert into app.audit_log (actor, action, entity, details)
            values (${actor}, 'save', 'time_account_settings', ${sql.json({ start_month: month })})`;
}

/** Soll-Minuten aller Mitarbeitenden für einen Monat in einem Rutsch (Stunden-Verlauf je Mitarbeiter). */
async function sollAll(sql: Sql, month: string): Promise<Map<string, number | null>> {
  const { start, end } = monthBounds(month);
  const [emps, hist] = await Promise.all([
    sql<{ id: string; weekly_hours: string | null; entry_date: string; exit_date: string | null }[]>`
      select id, weekly_hours::text, entry_date::text, exit_date::text from app.employees
       where entry_date <= ${end} and (exit_date is null or exit_date >= ${start})`,
    sql<{ employee_id: string; valid_from: string; weekly_hours: string | null }[]>`
      select distinct on (employee_id, valid_from) employee_id, valid_from::text, weekly_hours::text
        from app.employee_hours order by employee_id, valid_from, recorded_at desc`,
  ]);
  const byEmp = new Map<string, { valid_from: string; weekly_hours: string | null }[]>();
  for (const h of hist) byEmp.set(h.employee_id, [...(byEmp.get(h.employee_id) ?? []), h]);
  const out = new Map<string, number | null>();
  for (const e of emps) {
    const from = e.entry_date > start ? e.entry_date : start;
    const to = e.exit_date && e.exit_date < end ? e.exit_date : end;
    if (from > to) {
      out.set(e.id, 0);
      continue;
    }
    const h = byEmp.get(e.id) ?? [];
    const segs: { from: string; to: string; hours: number | null }[] = [];
    if (!h.length) segs.push({ from, to, hours: e.weekly_hours != null ? Number(e.weekly_hours) : null });
    for (let i = 0; i < h.length; i++) {
      const next = h[i + 1]?.valid_from;
      const sf = i === 0 || h[i]!.valid_from < from ? from : h[i]!.valid_from;
      const st = next && addDays(next, -1) < to ? addDays(next, -1) : to;
      if (sf > st) continue;
      segs.push({ from: sf, to: st, hours: h[i]!.weekly_hours != null ? Number(h[i]!.weekly_hours) : null });
    }
    out.set(
      e.id,
      segs.every((s) => s.hours == null)
        ? null
        : segs.reduce((a, s) => a + sollMinutesFor(s.hours ?? 0, s.from, s.to), 0),
    );
  }
  return out;
}

export interface AccountRow {
  employee_id: string;
  personnel_no: string;
  name: string;
  soll: number | null;
  worked: number;
  paidAbsence: number;
  ist: number;
  saldo: number | null;
  bookings: number;
  balance: number | null;
  /** Kontostand über 50 % der Monats-Sollzeit (§ 2 Abs. 2 MiLoG) */
  warn: boolean;
}

/** Arbeitszeitkonto für einen Monat inkl. Kontostand (Summe ab Startmonat). Höchstens 24 Monate Rückrechnung. */
export async function timeAccount(
  sql: Sql,
  month: string,
  employeeId?: string,
): Promise<{ rows: AccountRow[]; start: string }> {
  monthBounds(month);
  const start0 = await getStartMonth(sql);
  // gewählter Monat vor dem Startmonat → nur dieser Monat (Kontostand = Saldo des Monats)
  const startIdx = Math.min(Math.max(monthIdx(start0), monthIdx(month) - 23), monthIdx(month));
  const start = monthOf(startIdx);
  const totals = new Map<string, number>();
  const bookingsAll = await sql<{ employee_id: string; month: string; minutes: number }[]>`
    select employee_id, month, minutes from app.time_account_bookings
     where month between ${start} and ${month} and ${employeeId ? sql`employee_id = ${employeeId}` : sql`true`}`;
  let current: AccountRow[] = [];
  for (let i = startIdx; i <= monthIdx(month); i++) {
    const m = monthOf(i);
    const [pay, soll] = await Promise.all([payrollMonth(sql, m, employeeId), sollAll(sql, m)]);
    const payBy = new Map(pay.map((p) => [p.employee_id, p]));
    const ids = new Set([...soll.keys(), ...payBy.keys()].filter((id) => !employeeId || id === employeeId));
    const rows: AccountRow[] = [];
    for (const id of ids) {
      const p = payBy.get(id);
      const s = soll.get(id) ?? null;
      const worked = p?.minutes.normal ?? 0;
      const paidAbsence = p ? p.minutes.urlaub + p.minutes.krank + p.minutes.sonstige : 0;
      const ist = worked + paidAbsence;
      const saldo = s == null ? null : ist - s;
      const bookings = bookingsAll
        .filter((b) => b.employee_id === id && b.month === m)
        .reduce((a, b) => a + b.minutes, 0);
      const prev = totals.get(id) ?? 0;
      const bal = prev + (saldo ?? 0) + bookings;
      totals.set(id, bal);
      rows.push({
        employee_id: id,
        personnel_no: p?.personnel_no ?? '',
        name: p?.name ?? '',
        soll: s,
        worked,
        paidAbsence,
        ist,
        saldo,
        bookings,
        balance: s == null && !bookings && !prev ? null : bal,
        warn: s != null && s > 0 && bal > s / 2,
      });
    }
    current = rows;
  }
  // Namen für Mitarbeitende ohne Zeiten im Monat
  const missing = current.filter((r) => !r.name).map((r) => r.employee_id);
  if (missing.length) {
    const names = await sql<{ id: string; personnel_no: string; name: string }[]>`
      select id, personnel_no, last_name || ', ' || first_name as name from app.employees where id in ${sql(missing)}`;
    for (const n of names) {
      const r = current.find((x) => x.employee_id === n.id)!;
      r.name = n.name;
      r.personnel_no = n.personnel_no;
    }
  }
  current.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return { rows: current, start };
}

export async function bookTimeAccount(
  sql: Sql,
  p: {
    id: string;
    employeeId: string;
    month: string;
    minutes: number;
    kind: BookingKind;
    note: string;
    actor: string;
  },
) {
  monthBounds(p.month);
  if (!(p.kind in BOOKING_KIND)) throw new BusinessError('Art der Buchung ungültig');
  if (!Number.isInteger(p.minutes) || p.minutes === 0)
    throw new BusinessError('Bitte Stunden angeben (nicht 0)');
  if (!p.note.trim()) throw new BusinessError('Bitte Begründung angeben');
  if ((p.kind === 'auszahlung' || p.kind === 'freizeitausgleich') && p.minutes > 0)
    throw new BusinessError(
      'Auszahlung/Freizeitausgleich bauen Plusstunden ab – bitte als Minus-Stunden eintragen',
    );
  await sql`insert into app.time_account_bookings (id, employee_id, month, minutes, kind, note, actor)
            values (${p.id}, ${p.employeeId}, ${p.month}, ${p.minutes}, ${p.kind}, ${p.note.trim()}, ${p.actor})
            on conflict (id) do nothing`;
}

export async function listBookings(sql: Sql, employeeId?: string) {
  return sql<
    {
      id: string;
      employee_id: string;
      name: string;
      month: string;
      minutes: number;
      kind: BookingKind;
      note: string;
      actor: string;
      created_at: Date;
    }[]
  >`
    select b.*, e.last_name || ', ' || e.first_name as name from app.time_account_bookings b
      join app.employees e on e.id = b.employee_id
     where ${employeeId ? sql`b.employee_id = ${employeeId}` : sql`true`}
     order by b.created_at desc limit 200`;
}
