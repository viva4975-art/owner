import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, workingDays, isoWeekday, holidayName } from '../domain/time/holidays.js';
import { SCHOOL_DATA_UNTIL, schoolFreePeriods } from '../domain/time/school-holidays.js';
import { leaveBalance, requestAbsence } from './absences.js';
import { uuidOf } from './fortytools-export-import.js';

/*
 * Schulen (Ahmed 11.10.): Objekt als „Schule – in den Schulferien geschlossen“ markieren. Für alle Mitarbeitenden,
 * die künftig an solchen Objekten eingeplant sind, trägt die App die Schulferien (+ Buß- und Bettag) ein:
 *  - so viel Urlaub, wie die Person im Jahr noch hat (Resturlaub), anteilig auf die Ferien des Jahres verteilt,
 *  - den Rest als „Unbezahlt frei“.
 * Je Ferienzeitraum liegt der Urlaub in der Mitte, so bleiben unbezahlte Stücke kurz (> 1 Monat ohne Entgelt
 * → Abmeldung bei der Sozialversicherung, § 7 Abs. 3 SGB IV – wird als Hinweis gemeldet).
 * Übersprungen (mit Grund): Person arbeitet im Zeitraum auch an einem Objekt, das keine Schule ist; es gibt im
 * Zeitraum schon eine Abwesenheit. Feste IDs → erneut ausführen legt nichts doppelt an.
 * Jahre mit noch unvollständigen Ferienterminen: Urlaub nur anteilig (bekannte Ferientage ÷ Ferientage des letzten
 * vollständigen Jahres), damit für spätere Ferien noch Urlaub bleibt.
 */

export interface SchoolLeaveItem {
  employee_id: string;
  name: string;
  period: string;
  from: string;
  to: string;
  vacation: number;
  unpaid: number;
  longUnpaid: boolean;
}
export interface SchoolLeaveSkip {
  employee_id: string;
  name: string;
  period: string;
  reason: string;
}
export interface SchoolLeaveResult {
  planned: SchoolLeaveItem[];
  skipped: SchoolLeaveSkip[];
  done: number; // schon automatisch eingetragene Zeiträume
}

const workdayList = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (isoWeekday(d) <= 5 && !holidayName(d)) out.push(d);
  return out;
};
const calDays = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000) + 1;

/** Schulfreie Arbeitstage eines Jahres laut Ferienliste (für die Hochrechnung unvollständiger Jahre). */
function schoolWorkdaysOfYear(year: number) {
  let n = 0;
  for (const p of schoolFreePeriods()) {
    const s = p.from > `${year}-01-01` ? p.from : `${year}-01-01`;
    const t = p.to < `${year}-12-31` ? p.to : `${year}-12-31`;
    if (s <= t) n += workingDays(s, t);
  }
  return n;
}
const yearComplete = (y: number) => SCHOOL_DATA_UNTIL >= `${y}-12-31`;

/** Anteil des Jahresurlaubs, der auf die bekannten Ferien eines Jahres verteilt werden darf (1 = alles). */
export function knownShare(year: number) {
  if (yearComplete(year)) return 1;
  const known = schoolWorkdaysOfYear(year);
  let ref = 0;
  for (let y = year - 1; y >= year - 3 && !ref; y--) if (yearComplete(y)) ref = schoolWorkdaysOfYear(y);
  return ref > 0 ? Math.min(1, known / ref) : 1;
}

/** Verteilt `budget` ganze Tage anteilig auf Zeiträume mit `w` Arbeitstagen (größte Reste zuerst). */
export function distribute(budget: number, w: number[]): number[] {
  const total = w.reduce((a, b) => a + b, 0);
  if (budget >= total) return [...w];
  if (budget <= 0 || total === 0) return w.map(() => 0);
  const raw = w.map((x) => (budget * x) / total);
  const out = raw.map(Math.floor);
  let left = budget - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    if (out[i]! < w[i]!) {
      out[i]!++;
      left--;
    }
  }
  return out;
}

/** Urlaub in die Mitte des Zeitraums, davor/danach unbezahlt. Liefert Abschnitte mit Arbeitstagen. */
export function splitPeriod(from: string, to: string, vacation: number) {
  const wd = workdayList(from, to);
  const parts: { kind: 'urlaub' | 'unbezahlt'; from: string; to: string; days: number }[] = [];
  if (!wd.length) return parts;
  const v = Math.min(vacation, wd.length);
  if (v === wd.length) return [{ kind: 'urlaub' as const, from, to, days: v }];
  if (v === 0) return [{ kind: 'unbezahlt' as const, from, to, days: wd.length }];
  const i0 = Math.floor((wd.length - v) / 2);
  const vs = wd[i0]!;
  const ve = wd[i0 + v - 1]!;
  if (i0 > 0) parts.push({ kind: 'unbezahlt', from, to: addDays(vs, -1), days: i0 });
  parts.push({ kind: 'urlaub', from: vs, to: ve, days: v });
  if (i0 + v < wd.length)
    parts.push({ kind: 'unbezahlt', from: addDays(ve, 1), to, days: wd.length - i0 - v });
  return parts;
}

export async function schoolLeave(
  sql: Sql,
  opts: { siteId?: string; apply: boolean; actor: string; today?: string },
): Promise<SchoolLeaveResult> {
  const today = opts.today ?? todayBerlin();
  const start = addDays(today, 1);
  const res: SchoolLeaveResult = { planned: [], skipped: [], done: 0 };
  const periods = schoolFreePeriods().filter((p) => p.to >= start);
  if (!periods.length) return res;
  const emps = await sql<{ id: string; name: string; entry_date: string; exit_date: string | null }[]>`
    select distinct e.id, e.first_name || ' ' || e.last_name as name, e.entry_date::text, e.exit_date::text
      from app.shift_plans p join app.sites s on s.id = p.site_id join app.employees e on e.id = p.employee_id
     where s.school_closure and s.active and e.status = 'aktiv'
       and (p.valid_until is null or p.valid_until >= ${start}::date)
       and ${opts.siteId ? sql`p.site_id = ${opts.siteId}` : sql`true`}
     order by 2`;
  for (const e of emps) {
    const plans = await sql<
      { school: boolean; valid_from: string; valid_until: string | null; site: string }[]
    >`
      select s.school_closure as school, p.valid_from::text, p.valid_until::text, s.name as site
        from app.shift_plans p join app.sites s on s.id = p.site_id
       where p.employee_id = ${e.id} and (p.valid_until is null or p.valid_until >= ${start}::date)`;
    const abs = await sql<{ start_date: string; end_date: string; auto_school: boolean }[]>`
      select start_date::text, end_date::text, auto_school from app.absences
       where employee_id = ${e.id} and status in ('beantragt', 'genehmigt') and end_date >= ${start}::date`;
    // Abschnitte (Zeitraum ∩ Beschäftigung ∩ Schul-Einsatz), je Kalenderjahr getrennt
    const chunks: { period: string; from: string; to: string; year: number; wd: number }[] = [];
    for (const p of periods) {
      let s = p.from > start ? p.from : start;
      let t = p.to;
      if (e.entry_date > s) s = e.entry_date;
      if (e.exit_date && e.exit_date < t) t = e.exit_date;
      const act = plans.filter((x) => x.valid_from <= t && (!x.valid_until || x.valid_until >= s));
      const school = act.filter((x) => x.school);
      if (!school.length || s > t) continue;
      const other = act.filter((x) => !x.school);
      if (other.length) {
        res.skipped.push({
          employee_id: e.id,
          name: e.name,
          period: p.name,
          reason: `arbeitet auch an ${[...new Set(other.map((o) => o.site))].join(', ')} – bitte von Hand eintragen`,
        });
        continue;
      }
      const from0 = school.reduce((m, x) => (x.valid_from < m ? x.valid_from : m), '9999-12-31');
      const to0 = school.some((x) => !x.valid_until)
        ? t
        : school.reduce((m, x) => (x.valid_until! > m ? x.valid_until! : m), '0000-01-01');
      if (from0 > s) s = from0;
      if (to0 < t) t = to0;
      if (s > t) continue;
      const over = abs.filter((a) => a.start_date <= t && a.end_date >= s);
      if (over.length) {
        if (over.every((a) => a.auto_school)) res.done++;
        else
          res.skipped.push({
            employee_id: e.id,
            name: e.name,
            period: p.name,
            reason: 'im Zeitraum ist schon eine Abwesenheit eingetragen',
          });
        continue;
      }
      for (let y = Number(s.slice(0, 4)); y <= Number(t.slice(0, 4)); y++) {
        const cs = s > `${y}-01-01` ? s : `${y}-01-01`;
        const ct = t < `${y}-12-31` ? t : `${y}-12-31`;
        const wd = workingDays(cs, ct);
        if (wd > 0) chunks.push({ period: p.name, from: cs, to: ct, year: y, wd });
      }
    }
    const plannedVac = new Map<number, number>();
    for (const y of [...new Set(chunks.map((c) => c.year))]) {
      const list = chunks.filter((c) => c.year === y);
      const bal = await leaveBalance(sql, e.id, y);
      // Vorschau: im Vorjahr verplanter Urlaub ist noch nicht gebucht – der Übertrag wäre sonst zu hoch
      const cut = opts.apply ? 0 : Math.min(bal.carried, plannedVac.get(y - 1) ?? 0);
      const rest = Math.max(0, bal.rest - cut);
      // Übertrag aus dem Vorjahr nur bis 31.03. nutzbar (§ 7 Abs. 3 BUrlG) → zuerst in die Ferien bis März
      const carry = Math.min(rest, Math.max(0, bal.carried - bal.carriedExpired - cut));
      let carryLeft = Math.floor(carry);
      const q1 = list.map((c) => {
        if (c.from > `${y}-03-31`) return 0;
        const n = Math.min(carryLeft, workingDays(c.from, c.to < `${y}-03-31` ? c.to : `${y}-03-31`));
        carryLeft -= n;
        return n;
      });
      const main = distribute(
        Math.floor((rest - carry) * knownShare(y)),
        list.map((c, i) => c.wd - q1[i]!),
      );
      const vac = main.map((m, i) => m + q1[i]!);
      plannedVac.set(
        y,
        vac.reduce((a, b) => a + b, 0),
      );
      for (const [i, c] of list.entries()) {
        const parts = splitPeriod(c.from, c.to, vac[i]!);
        const longUnpaid = parts.some((x) => x.kind === 'unbezahlt' && calDays(x.from, x.to) > 31);
        res.planned.push({
          employee_id: e.id,
          name: e.name,
          period: c.period,
          from: c.from,
          to: c.to,
          vacation: vac[i]!,
          unpaid: c.wd - vac[i]!,
          longUnpaid,
        });
        if (!opts.apply) continue;
        for (const x of parts)
          await requestAbsence(sql, {
            id: uuidOf(`schulferien:${e.id}:${c.from}:${x.kind}:${x.from}`),
            employeeId: e.id,
            kind: x.kind,
            start: x.from,
            end: x.to,
            halfDay: false,
            note: `${c.period} (Schule, automatisch)`,
            actor: opts.actor,
            approved: true,
            allowNoLeave: true,
            autoSchool: true,
          });
      }
    }
  }
  if (opts.apply && res.planned.length)
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${opts.actor}, 'school_leave', 'site', ${opts.siteId ?? null},
                      ${sql.json({ eingetragen: res.planned.length, uebersprungen: res.skipped.length })})`;
  return res;
}
