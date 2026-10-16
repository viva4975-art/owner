import type { Sql } from '../db/client.js';
import { GEO_LABEL, type GeoStatus } from '../domain/time/geo.js';

/**
 * Auffällige Zeiten (Ahmed 16.10.): Ist weicht stark vom Plan ab oder beim Stempeln war das Handy weit weg vom Objekt.
 * Angezeigt am PC (Zeiterfassung, Startseite) und in der App der Objektleitung (Verwaltung), bis jemand sie als geprüft
 * markiert (`app.time_entry_reviews`). Zeiten ohne Einsatz haben keinen Plan und werden nur über den Standort auffällig.
 */
export const ANOMALY_DAYS = 14;
/** stark = mindestens 30 Minuten und mindestens 25 % der Planzeit */
const MIN_DIFF = 30;
const MIN_SHARE = 0.25;

export type TimeAnomaly = {
  entryId: string;
  employeeId: string;
  name: string;
  personnelNo: string;
  siteId: string;
  siteName: string;
  siteNo: string;
  workDate: string;
  start: Date;
  end: Date;
  actualMin: number;
  planStart: string | null;
  planEnd: string | null;
  planMin: number | null;
  diffMin: number | null;
  geo: { which: 'Ein' | 'Aus'; status: GeoStatus; m: number | null }[];
  reasons: string[];
};

type Row = {
  id: string;
  employee_id: string;
  first_name: string;
  last_name: string;
  personnel_no: string;
  site_id: string;
  site_name: string;
  site_no: string;
  work_date: string;
  start_at: Date;
  end_at: Date;
  break_minutes: number;
  start_geo: GeoStatus | null;
  start_geo_m: number | null;
  end_geo: GeoStatus | null;
  end_geo_m: number | null;
  plan_start: string | null;
  plan_end: string | null;
  plan_break: number | null;
  xkind: string | null;
};

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

export function planDiff(actualMin: number, planMin: number) {
  const diff = actualMin - planMin;
  return Math.abs(diff) >= MIN_DIFF && Math.abs(diff) >= planMin * MIN_SHARE ? diff : null;
}

const fmtH = (min: number) =>
  `${Math.floor(Math.abs(min) / 60)}:${String(Math.abs(min) % 60).padStart(2, '0')}`;

/**
 * Auffällige, noch nicht geprüfte Zeiten der letzten 14 Tage (abgeschlossen, nicht abgelehnt).
 * `managerUserId`: nur Objekte dieser Objektleitung.
 */
export async function timeAnomalies(
  sql: Sql,
  opts: { managerUserId?: string | undefined; days?: number; includeReviewed?: boolean } = {},
): Promise<TimeAnomaly[]> {
  const days = opts.days ?? ANOMALY_DAYS;
  const mgr = opts.managerUserId ?? null;
  const rows = await sql<Row[]>`
    with e as (
      select t.id, t.employee_id, emp.first_name, emp.last_name, emp.personnel_no, t.site_id, s.name as site_name,
             s.site_no, t.work_date::text as work_date, t.start_at, t.end_at, t.break_minutes,
             t.start_geo, t.start_geo_m, t.end_geo, t.end_geo_m,
             coalesce(t.shift_plan_id,
                      (select p.id from app.shift_plans p
                        where p.employee_id = t.employee_id and p.site_id = t.site_id
                          and p.weekday = extract(isodow from t.work_date)::int
                          and p.valid_from <= t.work_date and (p.valid_until is null or p.valid_until >= t.work_date)
                        order by abs(extract(epoch from (p.start_time - (t.start_at at time zone 'Europe/Berlin')::time)))
                        limit 1)) as plan_id
        from app.time_entries t
        join app.employees emp on emp.id = t.employee_id
        join app.sites s on s.id = t.site_id
       where t.work_date >= (now() at time zone 'Europe/Berlin')::date - ${days}::int
         and t.end_at is not null and t.status not in ('laeuft', 'abgelehnt')
         and (${mgr}::uuid is null or s.manager_user_id = ${mgr}::uuid)
         and (${opts.includeReviewed ?? false} or not exists (select 1 from app.time_entry_reviews r where r.entry_id = t.id))
    )
    select e.*, to_char(coalesce(x.start_time, p.start_time), 'HH24:MI') as plan_start,
           to_char(coalesce(x.end_time, p.end_time), 'HH24:MI') as plan_end, p.break_minutes as plan_break,
           x.kind::text as xkind
      from e
      left join app.shift_plans p on p.id = e.plan_id
      left join app.shift_exceptions x on x.shift_plan_id = p.id and x.work_date = e.work_date::date
     order by e.work_date desc, e.start_at desc`;
  const out: TimeAnomaly[] = [];
  for (const r of rows) {
    const actualMin =
      Math.round((r.end_at.getTime() - r.start_at.getTime()) / 60000) - (r.break_minutes ?? 0);
    let planMin: number | null = null;
    if (r.plan_start && r.plan_end && r.xkind !== 'ausfall') {
      let span = minutesOf(r.plan_end) - minutesOf(r.plan_start);
      if (span <= 0) span += 24 * 60;
      planMin = span - (r.plan_break ?? 0);
    }
    const reasons: string[] = [];
    const diff = planMin != null && planMin > 0 ? planDiff(actualMin, planMin) : null;
    if (diff != null)
      reasons.push(`${diff > 0 ? '+' : '−'}${fmtH(diff)} Std. gegenüber Plan (${fmtH(planMin!)})`);
    const geo: TimeAnomaly['geo'] = [];
    if (r.start_geo === 'entfernt') geo.push({ which: 'Ein', status: r.start_geo, m: r.start_geo_m });
    if (r.end_geo === 'entfernt') geo.push({ which: 'Aus', status: r.end_geo, m: r.end_geo_m });
    for (const g of geo)
      reasons.push(
        `${g.which}stempeln ${GEO_LABEL[g.status]}${g.m != null ? ` (${g.m >= 1000 ? `${(g.m / 1000).toFixed(1).replace('.', ',')} km` : `${g.m} m`})` : ''}`,
      );
    if (!reasons.length) continue;
    out.push({
      entryId: r.id,
      employeeId: r.employee_id,
      name: `${r.first_name} ${r.last_name}`,
      personnelNo: r.personnel_no,
      siteId: r.site_id,
      siteName: r.site_name,
      siteNo: r.site_no,
      workDate: r.work_date,
      start: r.start_at,
      end: r.end_at,
      actualMin,
      planStart: r.plan_start,
      planEnd: r.plan_end,
      planMin,
      diffMin: diff,
      geo,
      reasons,
    });
  }
  return out;
}

/** Als geprüft markieren (einzeln oder mehrere); nur Zeiten, die der Benutzer sehen darf. */
export async function reviewAnomalies(
  sql: Sql,
  ids: string[],
  actor: string,
  opts: { managerUserId?: string | undefined; note?: string | undefined } = {},
) {
  if (!ids.length) return 0;
  const mgr = opts.managerUserId ?? null;
  const r = await sql`
    insert into app.time_entry_reviews (entry_id, note, reviewed_by)
    select t.id, ${opts.note ?? null}, ${actor} from app.time_entries t join app.sites s on s.id = t.site_id
     where t.id = any(${ids}::uuid[]) and (${mgr}::uuid is null or s.manager_user_id = ${mgr}::uuid)
    on conflict (entry_id) do nothing`;
  return r.count;
}
