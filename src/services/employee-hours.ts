import { sollMinutesFor } from '../domain/time/soll.js';
import type { Sql, Tx } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import { BusinessError } from './errors.js';

/*
 * Wochenstunden mit Verlauf (Ahmed 07.10.: „kann sich ändern, alte und neue sehen“). Jede Änderung ist ein Eintrag
 * „gültig ab“ in app.employee_hours (nur anhängen; für denselben Tag gilt der zuletzt erfasste Eintrag).
 * employees.weekly_hours ist immer der heute gültige Wert – Änderungen in der Zukunft übernimmt applyDueHours().
 */
export interface HoursRow {
  id: string;
  valid_from: string;
  weekly_hours: string | null;
  note: string | null;
  recorded_by: string;
  recorded_at: Date;
}

/** Verlauf, neueste zuerst; je Stichtag nur der zuletzt erfasste Eintrag. */
export async function hoursHistory(sql: Sql | Tx, employeeId: string) {
  return sql<HoursRow[]>`
    select distinct on (valid_from) id, valid_from::text, weekly_hours::text, note, recorded_by, recorded_at
      from app.employee_hours where employee_id = ${employeeId}
     order by valid_from desc, recorded_at desc`;
}

/** Gültige Wochenstunden je Abschnitt im Zeitraum [from, to]. */
export async function hoursPeriods(sql: Sql, employeeId: string, from: string, to: string) {
  const hist = (await hoursHistory(sql, employeeId)).slice().reverse(); // aufsteigend
  const out: { from: string; to: string; hours: number | null }[] = [];
  if (!hist.length) {
    const [e] = await sql<
      { h: string | null }[]
    >`select weekly_hours::text as h from app.employees where id = ${employeeId}`;
    return [{ from, to, hours: e?.h != null ? Number(e.h) : null }];
  }
  for (let i = 0; i < hist.length; i++) {
    const s = hist[i]!.valid_from;
    const next = hist[i + 1]?.valid_from;
    const segFrom = i === 0 || s < from ? from : s; // vor dem ersten Eintrag gilt der erste
    const segTo = next && addDays(next, -1) < to ? addDays(next, -1) : to;
    if (segFrom > segTo) continue;
    out.push({
      from: segFrom,
      to: segTo,
      hours: hist[i]!.weekly_hours != null ? Number(hist[i]!.weekly_hours) : null,
    });
  }
  return out;
}

/** Soll-Minuten = je Abschnitt Wochenstunden × 4,33 je Monat (anteilig). null, wenn nirgends Stunden hinterlegt sind. */
export async function sollMinutes(sql: Sql, employeeId: string, from: string, to: string) {
  if (from > to) return 0;
  const segs = await hoursPeriods(sql, employeeId, from, to);
  if (segs.every((s) => s.hours == null)) return null;
  return segs.reduce((a, s) => a + sollMinutesFor(s.hours ?? 0, s.from, s.to), 0);
}

/**
 * Änderung der Wochenstunden festhalten (in derselben Transaktion wie das Speichern des Mitarbeiters).
 * Gültig ab heute oder in der Vergangenheit → employees.weekly_hours wird gesetzt; in der Zukunft → erst ab dem Tag.
 */
export async function recordHoursChange(
  tx: Sql | Tx,
  employeeId: string,
  hours: number | null,
  validFrom: string,
  actor: string,
  note: string | null = null,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) throw new BusinessError('„Gültig ab“ ist kein Datum');
  await tx`insert into app.employee_hours (employee_id, valid_from, weekly_hours, note, recorded_by)
          values (${employeeId}, ${validFrom}, ${hours}, ${note}, ${actor})`;
  await applyDueHours(tx, employeeId);
}

/** employees.weekly_hours auf den heute gültigen Wert setzen (beim Start, stündlich und nach jeder Änderung). */
export async function applyDueHours(sql: Sql | Tx, employeeId?: string) {
  const today = todayBerlin();
  const r = await sql`
    with cur as (
      select distinct on (employee_id) employee_id, weekly_hours
        from app.employee_hours
       where valid_from <= ${today} and ${employeeId ? sql`employee_id = ${employeeId}` : sql`true`}
       order by employee_id, valid_from desc, recorded_at desc)
    update app.employees e set weekly_hours = cur.weekly_hours, version = e.version + 1, updated_at = now()
      from cur where cur.employee_id = e.id and e.weekly_hours is distinct from cur.weekly_hours
    returning e.id`;
  return r.length;
}
