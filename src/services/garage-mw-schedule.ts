import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { uuidOf } from './fortytools-export-import.js';
import { type MwKey, ensureMwServicesFor, ensureMwTgObjects, matches } from './garage-mw.js';
import { MW_TG_2026, MW_TG_2026_DUPLEX, MW_TG_2026_SQM, type MwTgAppt } from './garage-mw-2026.js';

/** Herbstrunde: 3. Kehrsaugen + 2. Reinigung Duplex + Grube (wie Fortytools 10/2025). */
const AUTUMN_KEYS: MwKey[] = ['kehr3', 'duplex2', 'grube'];
/** September wurde noch in Fortytools abgerechnet (Ahmed 17.10.) – verrichtet wird erst ab Oktober. */
const BILL_FROM = '2026-10-01';

export interface MwScheduleResult {
  appointments: number;
  executions: number;
  skipped: string[];
}

/**
 * Termine 2026 von Münchner Wohnen eintragen (Disposition → Tiefgaragenreinigung), Flächen/Duplex am TG-Objekt
 * ergänzen und die Herbsttermine ab Oktober als verrichtete Leistungen vormerken (→ Entwürfe → „Aus Einzelleistungen
 * erstellen“). Feste IDs → mehrfach ausführen legt nichts doppelt an. Was in Fortytools für Herbst 2026 schon
 * abgerechnet ist, wird nicht vorgemerkt.
 */
export async function applyMwSchedule2026(sql: Sql, actor = 'automatisch'): Promise<MwScheduleResult> {
  const today = todayBerlin();
  await ensureMwTgObjects(sql);
  const sites = await sql<{ site_no: string; site_id: string; tg_id: string | null }[]>`
    select s.site_no, s.id as site_id,
           (select o.id from app.tg_objects o where o.site_id = s.id order by o.active desc, o.created_at limit 1) as tg_id
      from app.sites s where s.site_no in ${sql([...new Set(MW_TG_2026.map((a) => a.siteNo))])}`;
  const bySite = new Map(sites.map((x) => [x.site_no, x]));
  const res: MwScheduleResult = { appointments: 0, executions: 0, skipped: [] };

  // Flächen und Duplex aus den Terminlisten (nur ergänzen, nie überschreiben)
  for (const [no, sqm] of Object.entries(MW_TG_2026_SQM)) {
    const x = bySite.get(no);
    if (x?.tg_id) await sql`update app.tg_objects set sqm = coalesce(sqm, ${sqm}) where id = ${x.tg_id}`;
  }
  for (const [no, d] of Object.entries(MW_TG_2026_DUPLEX)) {
    const x = bySite.get(no);
    if (x?.tg_id)
      await sql`update app.tg_objects set spaces_duplex = coalesce(spaces_duplex, ${d}) where id = ${x.tg_id}`;
  }

  // in Fortytools schon für Herbst 2026 abgerechnet?
  const billed = new Set(
    (
      await sql<{ site_id: string }[]>`
        select distinct l.site_id from app.legacy_invoice_lines l
         where l.site_id in ${sql(sites.map((x) => x.site_id).concat('00000000-0000-0000-0000-000000000000'))}
           and l.quantity_milli > 0 and l.title ~* 'saugen|duplex|grube'
           and coalesce(l.period_start, l.period_end) >= '2026-09-01'`
    ).map((r) => r.site_id),
  );

  const ensured = new Set<string>();
  for (const a of MW_TG_2026) {
    const x = bySite.get(a.siteNo);
    if (!x?.tg_id) {
      res.skipped.push(`${a.siteNo}: Objekt nicht gefunden`);
      continue;
    }
    const first = a.days[0]!.date;
    const last = a.days[a.days.length - 1]!.date;
    const apptId = uuidOf(`tg-mw-2026:${a.round}:${a.siteNo}:${first}`);
    const done = last < today;
    const r = await sql`
      insert into app.tg_appointments (id, object_id, days, first_day, last_day, kind, note, confirmed, done, created_by)
      values (${apptId}, ${x.tg_id}, ${sql.json(a.days)}, ${first}, ${last}, ${a.kind}, ${noteOf(a)},
              true, ${done}, ${actor})
      on conflict (id) do nothing returning id`;
    res.appointments += r.length;

    if (a.round !== 'herbst' || first < BILL_FROM) continue;
    if (billed.has(x.site_id)) {
      res.skipped.push(`${a.siteNo}: Herbst 2026 schon in Fortytools abgerechnet`);
      continue;
    }
    if (!ensured.has(x.tg_id)) {
      await ensureMwServicesFor(sql, x.tg_id, actor);
      ensured.add(x.tg_id);
    }
    const svcs = await sql<
      {
        id: string;
        description: string;
        quantity_milli: bigint;
        unit_price_cents: bigint;
        valid_from: string;
      }[]
    >`select id, description, quantity_milli, unit_price_cents, valid_from::text as valid_from
        from app.site_services where site_id = ${x.site_id} and active and quantity_milli > 0
         and (valid_to is null or valid_to >= ${last}) order by valid_from desc`;
    let any = false;
    for (const key of AUTUMN_KEYS) {
      const sv = svcs.find((s) => matches(key, s.description) && s.valid_from <= first);
      if (!sv) continue;
      any = true;
      const e = await sql`
        insert into app.service_executions (id, service_id, site_id, date_from, date_to, quantity_milli,
                                            unit_price_cents, note, created_by)
        values (${uuidOf(`tg-mw-2026-exec:${apptId}:${key}`)}, ${sv.id}, ${x.site_id}, ${first}, ${last},
                ${sv.quantity_milli}, ${sv.unit_price_cents}, 'Tiefgaragenreinigung Herbst 2026', ${actor})
        on conflict (id) do nothing returning id`;
      res.executions += e.length;
    }
    if (!any)
      res.skipped.push(`${a.siteNo}: keine Fläche/Leistung – Fläche unter Tiefgaragenreinigung eintragen`);
  }
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'mw_tg_2026', 'tg_objects', null, ${sql.json({ ...res })})`;
  return res;
}

const noteOf = (a: MwTgAppt) =>
  [a.round === 'fruehjahr' ? 'Frühjahr 2026 (in Fortytools abgerechnet)' : 'Herbst 2026', a.note]
    .filter(Boolean)
    .join(' · ');

/** Einmal beim Start (Protokoll `mw_tg_2026`). */
export async function ensureMwSchedule2026(sql: Sql) {
  const [done] = await sql`select 1 from app.audit_log where action = 'mw_tg_2026' limit 1`;
  return done ? null : applyMwSchedule2026(sql);
}
