import type { Sql } from '../db/client.js';
import { isManagingDirector } from '../domain/hr/employer-cost.js';
import { surchargeCents } from '../domain/time/surcharges.js';
import { addDays } from '../domain/time/holidays.js';
import { getAccountingSettings } from './datev.js';
import { payrollMonth, SURCHARGES } from './payroll.js';

/*
 * Lohn der Nachkalkulation aus den Lohnarten (Ahmed 29.10.: „der Lohn soll von den Lohnarten genommen werden“):
 * je Mitarbeiter und Monat dieselben Werte wie Stundenliste & Lohnarten / Lohnexport („Ist, sonst Plan“) –
 * Normal-/Aushilfsstunden, Urlaub, Krank, Feiertagslohn × Stundenlohn bzw. Festgehalt − Abzug unbezahlt, dazu
 * Zuschläge (Nacht, Sonn-/Feiertag, Mehrarbeit). Darauf der Lohnzuschlag für Arbeitgeberanteile (Einstellungen →
 * DATEV/Nachkalkulation; Geschäftsführer ohne). Verteilt auf die Objekte nach den bezahlten Minuten dort.
 */

export interface LaborShare {
  employee_id: string;
  name: string;
  personnel_no: string;
  /** '' = ohne Objekt (z. B. Festgehalt ohne erfasste/geplante Zeit) */
  site_id: string;
  /** bezahlte Minuten an diesem Objekt (Arbeit, Feiertagslohn, bezahlte Abwesenheit) */
  minutes: number;
  wage_cents: bigint;
  wage_assumed: boolean;
  overhead_bp: number;
  /** Lohn laut Lohnarten (ohne Lohnzuschlag) */
  gross: bigint;
  /** Lohn + Lohnzuschlag */
  cost: bigint;
}

const months = (from: string, to: string) => {
  const out: string[] = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = addDays(`${m}-01`, 32).slice(0, 7)) out.push(m);
  return out;
};

/** Betrag nach Gewichten aufteilen (Rest-Cent an die größten Reste, Summe bleibt exakt). */
function split(total: bigint, weights: [string, number][]): Map<string, bigint> {
  const sum = weights.reduce((a, [, w]) => a + w, 0);
  const out = new Map<string, bigint>();
  if (!sum) return out;
  const parts = weights.map(([k, w]) => {
    const num = total * BigInt(w);
    return { k, base: num / BigInt(sum), rest: num % BigInt(sum) };
  });
  let left = total - parts.reduce((a, p) => a + p.base, 0n);
  parts.sort((a, b) => (b.rest > a.rest ? 1 : b.rest < a.rest ? -1 : 0));
  for (const p of parts) {
    const extra = left > 0n ? 1n : 0n;
    left -= extra;
    out.set(p.k, (out.get(p.k) ?? 0n) + p.base + extra);
  }
  return out;
}

// Startseiten-Ampel: kurz zwischengespeichert (sonst bei jedem Aufruf der Startseite alle Lohnarten neu);
// Nachkalkulation selbst rechnet immer frisch
const caches = new WeakMap<Sql, Map<string, { at: number; rows: Promise<LaborShare[]> }>>();
const CACHE_MS = 2 * 60_000;

export function laborFromPayroll(
  sql: Sql,
  from: string,
  to: string,
  opts: { cached?: boolean } = {},
): Promise<LaborShare[]> {
  if (!opts.cached) return computeLabor(sql, from, to);
  const cache = caches.get(sql) ?? new Map<string, { at: number; rows: Promise<LaborShare[]> }>();
  caches.set(sql, cache);
  const key = `${from}|${to}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  const rows = computeLabor(sql, from, to);
  cache.set(key, { at: Date.now(), rows });
  rows.catch(() => cache.delete(key));
  for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_MS) cache.delete(k);
  return rows;
}

async function computeLabor(sql: Sql, from: string, to: string): Promise<LaborShare[]> {
  const settings = await getAccountingSettings(sql);
  const [emps, [co], [mw]] = await Promise.all([
    sql<
      {
        id: string;
        full_name: string;
        employment_type: string | null;
        weekly_hours: number | null;
        tags: string[] | null;
      }[]
    >`select id, first_name || ' ' || last_name as full_name, employment_type::text, weekly_hours::float as weekly_hours, tags
        from app.employees`,
    sql<{ md: string | null }[]>`select managing_director as md from app.company limit 1`,
    sql<{ w: bigint | null }[]>`select min(hourly_wage_cents)::bigint as w from app.wage_levels where active`,
  ]);
  const empOf = new Map(emps.map((e) => [e.id, e]));
  const overheadOf = (id: string) => {
    const e = empOf.get(id);
    if (!e) return settings.overhead_parttime_bp;
    if (isManagingDirector(e.tags, { name: e.full_name, managingDirector: co?.md })) return 0;
    if (e.employment_type === 'minijob') return settings.overhead_minijob_bp;
    const hours = e.weekly_hours ?? (e.employment_type === 'vollzeit' ? 40 : 0);
    return hours > 30 ? settings.overhead_fulltime_bp : settings.overhead_parttime_bp;
  };
  const acc = new Map<string, LaborShare>();
  for (const month of months(from, to)) {
    for (const r of await payrollMonth(sql, month, undefined, { fillPlan: true })) {
      const wage = r.wage_cents ?? mw?.w ?? 0n;
      const m = r.minutes;
      let gross: bigint;
      if (r.salary) gross = r.salary.cents - r.unpaidDeductionCents;
      else {
        const paid = m.normal + m.aushilfslohn + m.urlaub + m.krank + m.feiertag_lfz;
        gross = (BigInt(paid) * wage * 2n + 60n) / 120n;
      }
      // Zuschläge wie im Lohnexport; ohne hinterlegten Lohn mit dem angenommenen Tariflohn
      for (const k of SURCHARGES)
        gross += r.wage_cents ? r.surchargeCents[k] : surchargeCents(m[k], wage, r.bp[k]);
      gross += r.wage_cents ? r.overtimeCents : 0n;
      const bp = overheadOf(r.employee_id);
      const cost = (gross * BigInt(10000 + bp) * 2n + 10000n) / 20000n;
      const weights = Object.entries(r.siteMinutes).filter(([, v]) => v > 0);
      if (!weights.length) weights.push(['', 1]);
      const g = split(gross, weights);
      const c = split(cost, weights);
      for (const [site, min] of weights) {
        const key = `${r.employee_id}|${site}`;
        const x = acc.get(key) ?? {
          employee_id: r.employee_id,
          name: r.name,
          personnel_no: r.personnel_no,
          site_id: site,
          minutes: 0,
          wage_cents: wage,
          wage_assumed: !r.salary && r.wage_cents === null,
          overhead_bp: bp,
          gross: 0n,
          cost: 0n,
        };
        x.minutes += r.siteMinutes[site] ? min : 0;
        x.gross += g.get(site) ?? 0n;
        x.cost += c.get(site) ?? 0n;
        acc.set(key, x);
      }
    }
  }
  return [...acc.values()];
}
