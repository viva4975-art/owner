import { createHash } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { readSheet, SheetError } from '../domain/sheet/sheet.js';
import { BusinessError } from './errors.js';
import type { Deps } from './workflow.js';

/*
 * Urlaubskonten und Krankheitstage aus Fortytools (Excel/CSV „urlaubskonten_2026_2026-10-08.xlsx“,
 * „krankheitstage_2026_2026-10-08.xlsx“). Übernommen wird der Stand zum Stichtag je Mitarbeiter und Jahr
 * (`app.leave_openings`); Urlaubskonto und Krankheitsauswertung zählen eigene Abwesenheiten erst ab dem Folgetag.
 * Zuordnung nur über die Personalnummer. Erneut importieren überschreibt den Stand (Protokoll im audit_log).
 */

export type LeaveSheetKind = 'urlaub' | 'krank';

export interface LeaveSheetRow {
  line: number;
  name: string;
  personnel_no: string;
  carried?: number | null;
  entitlement?: number | null;
  taken?: number | null;
  available?: number | null;
  sick?: number | null;
}

export interface LeaveSheet {
  kind: LeaveSheetKind;
  rows: LeaveSheetRow[];
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');

/** „1,5“ / „1.5“ / „-17“ → Zahl mit höchstens einer Nachkommastelle (halbe Tage), leer → null */
export function daysOf(v: string | undefined): number | null {
  const t = (v ?? '').trim().replace(',', '.');
  if (!t) return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) return NaN;
  return Math.round(Number(t) * 10) / 10;
}

export function parseLeaveSheet(bytes: Uint8Array): LeaveSheet {
  let rows: string[][];
  try {
    rows = readSheet(bytes).rows;
  } catch (e) {
    if (e instanceof SheetError) throw new BusinessError(e.message);
    throw e;
  }
  const hi = rows.findIndex((r) => r.some((c) => norm(c) === 'personalnummer'));
  if (hi < 0) throw new BusinessError('Spalte „Personalnummer“ nicht gefunden');
  const head = rows[hi]!.map(norm);
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const cNo = col('personalnummer');
  const cName = col('mitarbeiter', 'name');
  const cCarried = col('resturlaubvorjahr');
  const cEnt = col('anspruchaktuell', 'anspruch');
  const cTaken = col('genommeneurlaubstage', 'genommen');
  const cAvail = col('verfugbareurlaubstage', 'verfugbar');
  const cSick = col('erfasst', 'krankheitstage', 'tage');
  const kind: LeaveSheetKind | null = cEnt >= 0 || cTaken >= 0 ? 'urlaub' : cSick >= 0 ? 'krank' : null;
  if (!kind)
    throw new BusinessError(
      'Unbekannte Datei – erwartet Urlaubskonten (Anspruch, Genommene Urlaubstage) oder Krankheitstage (Erfasst)',
    );
  const out: LeaveSheetRow[] = [];
  rows.slice(hi + 1).forEach((r, i) => {
    const no = (r[cNo] ?? '').trim();
    const name = cName >= 0 ? (r[cName] ?? '').trim() : '';
    if (!no && !name) return;
    const v = (c: number) => (c >= 0 ? daysOf(r[c]) : null);
    out.push(
      kind === 'urlaub'
        ? {
            line: hi + i + 2,
            name,
            personnel_no: no,
            carried: v(cCarried),
            entitlement: v(cEnt),
            taken: v(cTaken),
            available: v(cAvail),
          }
        : { line: hi + i + 2, name, personnel_no: no, sick: v(cSick) },
    );
  });
  return { kind, rows: out };
}

/** „urlaubskonten_2026_2026-10-08.xlsx“ → Jahr 2026, Stand 08.10.2026 */
export function yearAndDateOf(fileName: string): { year: number | null; asOf: string | null } {
  const d = /(\d{4})-(\d{2})-(\d{2})/.exec(fileName);
  const y = /_(\d{4})_/.exec(fileName);
  return {
    year: y ? Number(y[1]) : d ? Number(d[1]) : null,
    asOf: d ? `${d[1]}-${d[2]}-${d[3]}` : null,
  };
}

const stagePath = (sha: string) => `importe/${sha.slice(0, 2)}/${sha}.urlaub`;

export async function stageLeaveSheet(deps: Deps, bytes: Uint8Array) {
  if (bytes.length > 10 * 1024 * 1024) throw new BusinessError('Datei zu groß (höchstens 10 MB)');
  const s = parseLeaveSheet(bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');
  await deps.archive.put(stagePath(sha), bytes);
  return { sha, kind: s.kind };
}

export async function stagedLeaveSheet(deps: Deps, sha: string) {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new BusinessError('Datei ungültig');
  let bytes: Uint8Array;
  try {
    bytes = await deps.archive.get(stagePath(sha));
  } catch {
    throw new BusinessError('Datei nicht mehr vorhanden – bitte erneut hochladen');
  }
  return parseLeaveSheet(bytes);
}

export interface LeavePlanRow extends LeaveSheetRow {
  employee_id: string | null;
  employee_name: string | null;
  error: string | null;
  /** bisher gespeicherter Stand */
  existing: boolean;
}

export async function planLeaveImport(sql: Sql, s: LeaveSheet): Promise<LeavePlanRow[]> {
  const emps = await sql<{ id: string; personnel_no: string; name: string }[]>`
    select id, personnel_no, last_name || ', ' || first_name as name from app.employees`;
  const byNo = new Map(emps.map((e) => [e.personnel_no.replace(/^0+/, ''), e]));
  const existing = new Set(
    (await sql<{ employee_id: string }[]>`select employee_id from app.leave_openings`).map(
      (x) => x.employee_id,
    ),
  );
  const seen = new Set<string>();
  return s.rows.map((r) => {
    const e = byNo.get(r.personnel_no.replace(/^0+/, ''));
    const nums = [r.carried, r.entitlement, r.taken, r.available, r.sick];
    let error: string | null = null;
    if (!r.personnel_no) error = 'Personalnummer fehlt';
    else if (!e) error = `Personalnummer ${r.personnel_no} nicht in der App`;
    else if (nums.some((n) => n != null && Number.isNaN(n))) error = 'keine Zahl';
    else if (seen.has(e.id)) error = 'doppelt in der Datei';
    if (e) seen.add(e.id);
    return {
      ...r,
      employee_id: e?.id ?? null,
      employee_name: e?.name ?? null,
      error,
      existing: !!e && existing.has(e.id),
    };
  });
}

export async function applyLeaveImport(
  sql: Sql,
  s: LeaveSheet,
  p: { year: number; asOf: string; actor: string; source: string },
): Promise<{ saved: number; skipped: number }> {
  if (!Number.isInteger(p.year) || p.year < 2000 || p.year > 2100) throw new BusinessError('Jahr ungültig');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.asOf) || Number(p.asOf.slice(0, 4)) !== p.year)
    throw new BusinessError('Stichtag muss im gewählten Jahr liegen');
  const plan = await planLeaveImport(sql, s);
  let saved = 0;
  let skipped = 0;
  await sql.begin(async (tx) => {
    for (const r of plan) {
      if (r.error || !r.employee_id) {
        skipped++;
        continue;
      }
      if (s.kind === 'urlaub')
        await tx`
          insert into app.leave_openings (employee_id, year, as_of, carried_days, entitlement_days, taken_days,
                                          available_days, source, updated_by)
          values (${r.employee_id}, ${p.year}, ${p.asOf}, ${r.carried ?? null}, ${r.entitlement ?? null},
                  ${r.taken ?? null}, ${r.available ?? null}, ${p.source}, ${p.actor})
          on conflict (employee_id, year) do update set as_of = excluded.as_of,
            carried_days = excluded.carried_days, entitlement_days = excluded.entitlement_days,
            taken_days = excluded.taken_days, available_days = excluded.available_days,
            source = excluded.source, updated_by = excluded.updated_by, updated_at = now()`;
      else
        await tx`
          insert into app.leave_openings (employee_id, year, as_of, sick_as_of, sick_days, source, updated_by)
          values (${r.employee_id}, ${p.year}, ${p.asOf}, ${p.asOf}, ${r.sick ?? 0}, ${p.source}, ${p.actor})
          on conflict (employee_id, year) do update set sick_as_of = excluded.sick_as_of,
            sick_days = excluded.sick_days, updated_by = excluded.updated_by, updated_at = now()`;
      saved++;
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${p.actor}, 'import', 'leave_openings', null,
                     ${tx.json({ kind: s.kind, year: p.year, as_of: p.asOf, saved, skipped, source: p.source })})`;
  });
  return { saved, skipped };
}

export interface LeaveOpening {
  as_of: string;
  carried: number | null;
  entitlement: number | null;
  taken: number | null;
  available: number | null;
  sick_as_of: string | null;
  sick: number | null;
}

export async function leaveOpening(sql: Sql, employeeId: string, year: number): Promise<LeaveOpening | null> {
  const [o] = await sql<
    {
      as_of: string;
      carried_days: string | null;
      entitlement_days: string | null;
      taken_days: string | null;
      available_days: string | null;
      sick_as_of: string | null;
      sick_days: string | null;
    }[]
  >`select as_of::text, carried_days::text, entitlement_days::text, taken_days::text, available_days::text,
           sick_as_of::text, sick_days::text
      from app.leave_openings where employee_id = ${employeeId} and year = ${year}`;
  if (!o) return null;
  const n = (x: string | null) => (x == null ? null : Number(x));
  return {
    as_of: o.as_of,
    carried: n(o.carried_days),
    entitlement: n(o.entitlement_days),
    taken: n(o.taken_days),
    available: n(o.available_days),
    sick_as_of: o.sick_as_of,
    sick: n(o.sick_days),
  };
}
