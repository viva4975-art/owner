import { GEO_LABEL, type GeoStatus } from '../domain/time/geo.js';
import { readFile } from 'node:fs/promises';
import { rgb } from '@cantoo/pdf-lib';
import type { Sql } from '../db/client.js';
import { formatDateDe } from '../domain/invoice/calc.js';
import { FORM_COLORS, FORM_X, FORM_Y, FormDoc } from '../pdf/form-doc.js';
import { BusinessError } from './errors.js';
import { QM_SCALE, type QmItem, roomMeta, weightedScore } from './qm.js';
import { filePath, type FileRow, type UploadConfig } from './uploads.js';
import type { Deps } from './workflow.js';

/*
 * Qualitätskontrolle – Auswertungsbericht und Statistik (Ahmed 11.10., Vorlage Neumann & Neumann):
 * Ergebnis, Ampel (unter Schwellwert / bis Zielbereich / im Zielbereich), Qualitätsverlauf des Objekts, Leistungsgruppen
 * (= Nutzungsarten des Raumbuchs), Leistungsbereiche (Obenarbeiten, Sanitär …, am Kontrollgegenstand), Top 10
 * Verbesserungspotentiale, durchgeführte Prüfungen, geprüfte Einheiten mit Zeit und Mängelliste mit Fotos.
 * Mangel = Bewertung unter dem Schwellwert (Standard 80 %, Einstellungen → Kontrollgegenstände).
 */

/** Gewichtung je Kontrollgegenstand (Einstellungen → Kontrollgegenstände) */
export const WEIGHT_LABEL: Record<number, string> = {
  1: 'gering',
  2: 'normal',
  3: 'wichtig',
  4: 'sehr wichtig',
  5: 'kritisch',
};

export interface QmSettings {
  threshold_low: number;
  threshold_target: number;
}

export async function qmSettings(sql: Sql): Promise<QmSettings> {
  const [s] = await sql<
    QmSettings[]
  >`select threshold_low, threshold_target from app.qm_settings where id = 1`;
  return s ?? { threshold_low: 80, threshold_target: 88 };
}

export async function saveQmSettings(sql: Sql, low: number, target: number) {
  if (!Number.isInteger(low) || !Number.isInteger(target) || low < 1 || target > 100 || target <= low)
    throw new BusinessError('Schwellwert muss kleiner als der Zielbereich sein (1–100 %)');
  await sql`
    insert into app.qm_settings (id, threshold_low, threshold_target) values (1, ${low}, ${target})
    on conflict (id) do update set threshold_low = excluded.threshold_low, threshold_target = excluded.threshold_target`;
}

// ---------------------------------------------------------------- Löschen

/**
 * Qualitätskontrolle löschen (Ahmed 11.10.): Entwurf jeder mit Zugriff aufs Objekt; abgeschlossene nur Admin.
 * Stand vorher ins Protokoll, offene Nachbesserungs-Aufgaben entfallen, Fotos/PDF bleiben write-once im Archiv,
 * Tickets bleiben (ohne Verweis).
 */
export async function deleteQualityCheck(sql: Sql, id: string, o: { admin: boolean; actor: string }) {
  await sql.begin(async (tx) => {
    const [q] = await tx<{ number: string; status: string; site_id: string; score_percent: number | null }[]>`
      select number, status::text, site_id, score_percent from app.quality_checks where id = ${id} for update`;
    if (!q) throw new BusinessError('Qualitätskontrolle nicht gefunden');
    if (q.status !== 'entwurf' && !o.admin)
      throw new BusinessError('Abgeschlossene Qualitätskontrollen kann nur ein Admin löschen');
    const items = await tx<{ area: string; rating: string; task_id: string | null }[]>`
      select area, rating::text, task_id from app.quality_check_items where check_id = ${id}`;
    const [{ n }] =
      (await tx`select count(*)::int as n from app.quality_check_ratings where check_id = ${id}`) as unknown as [
        { n: number },
      ];
    const tasks = items.map((i) => i.task_id).filter((t): t is string => !!t);
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${o.actor}, 'delete', 'quality_check', ${id},
                     ${tx.json({ ...q, ratings: n, items: items.map((i) => ({ area: i.area, rating: i.rating })) })})`;
    await tx`delete from app.file_links where entity_type = 'quality_check' and entity_id = ${id}`;
    await tx`select set_config('app.purge', 'on', true)`;
    await tx`delete from app.quality_checks where id = ${id}`;
    await tx`select set_config('app.purge', '', true)`;
    if (tasks.length) await tx`delete from app.tasks where id in ${tx(tasks)} and status = 'open'`;
  });
}

// ---------------------------------------------------------------- Bericht

export interface ReportDefect {
  item: string;
  description: string | null;
  note: string | null;
  label: string;
  pct: number;
  weight: number;
  photos: string[];
}
export interface ReportRoom {
  id: string;
  label: string;
  meta: string;
  group: string;
  score: number | null;
  defects: ReportDefect[];
  first: Date | null;
  last: Date | null;
}
export interface ReportRow {
  name: string;
  units: number;
  defects: number;
  score: number | null;
  prev: number | null;
}
export interface AuditReport {
  check: {
    id: string;
    number: string;
    check_date: string;
    status: string;
    inspector: string;
    attendee: string | null;
    summary: string | null;
    site_id: string;
    site_name: string;
    site_no: string;
    site_address: string;
    customer_name: string;
    signed_by_name: string | null;
    signature_path: string | null;
    closed_at: Date | null;
  };
  settings: QmSettings;
  score: number | null;
  prevScore: number | null;
  rooms: ReportRoom[];
  ampel: { low: number; mid: number; high: number };
  history: { id: string; number: string; date: string; score: number; inspector: string; units: number }[];
  groups: ReportRow[];
  areas: ReportRow[];
  top: TopItem[];
  defectCount: number;
}

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

interface RatingRow {
  check_id: string;
  room_id: string;
  item_id: string;
  item: string;
  kind: QmItem['kind'];
  description: string | null;
  area_group: string | null;
  value: number | null;
  percent: number | null;
  weight: number;
  skipped: boolean;
  note: string | null;
  photo_ids: string[];
  rated_at: Date;
}

async function ratingsOf(sql: Sql, checkIds: string[]) {
  if (!checkIds.length) return [] as RatingRow[];
  return sql<RatingRow[]>`
    select r.check_id, r.room_id, r.item_id, i.name as item, i.kind, i.description, i.area_group, r.value, r.percent,
           r.weight, r.skipped, r.note, r.photo_ids, r.rated_at
      from app.quality_check_ratings r join app.qm_items i on i.id = r.item_id
     where r.check_id in ${sql(checkIds)}`;
}

export interface TopItem {
  item: string;
  description: string | null;
  weight: number;
  count: number;
  score: number;
}

/**
 * Top 10 Verbesserungspotentiale: nach Gewicht des Abzugs sortiert – (100 % − Qualität) × Gewichtung × Anzahl
 * Bewertungen. Ein schlecht gereinigter Boden (Gewicht 4) steht damit vor einer vergessenen Steckdose (Gewicht 1).
 */
function topItems(ratings: RatingRow[]): TopItem[] {
  const by = new Map<string, { item: string; description: string | null; weight: number; pct: number[] }>();
  for (const r of ratings) {
    if (r.skipped || r.percent == null) continue;
    const e = by.get(r.item_id) ?? { item: r.item, description: r.description, weight: r.weight, pct: [] };
    e.pct.push(r.percent);
    e.weight = Math.max(e.weight, r.weight);
    by.set(r.item_id, e);
  }
  return [...by.values()]
    .map((e) => ({
      item: e.item,
      description: e.description,
      weight: e.weight,
      count: e.pct.length,
      score: avg(e.pct)!,
    }))
    .filter((e) => e.score < 100)
    .sort(
      (a, b) =>
        (100 - b.score) * b.weight * b.count - (100 - a.score) * a.weight * a.count || a.score - b.score,
    )
    .slice(0, 10);
}

/** Werte je Leistungsgruppe/-bereich eines Audits (für „Änderung zum letzten Audit“) */
function breakdown(
  ratings: RatingRow[],
  roomGroup: Map<string, string>,
  low: number,
  by: 'group' | 'area',
): Map<string, ReportRow> {
  const m = new Map<string, { units: Set<string>; rs: RatingRow[]; defects: number }>();
  for (const r of ratings) {
    if (r.skipped || r.percent == null) continue;
    const key =
      by === 'group' ? (roomGroup.get(r.room_id) ?? 'Ohne Nutzungsart') : r.area_group || 'Allgemein';
    const e = m.get(key) ?? { units: new Set<string>(), rs: [] as RatingRow[], defects: 0 };
    e.units.add(r.room_id);
    e.rs.push(r);
    if (r.percent < low) e.defects++;
    m.set(key, e);
  }
  const out = new Map<string, ReportRow>();
  for (const [name, e] of m) {
    // Leistungsgruppe: Ø der Räume (je Raum gewichtet, wie das Gesamtergebnis); Leistungsbereich: gewichteter Ø
    let score: number | null;
    if (by === 'group') {
      const perRoom = new Map<string, RatingRow[]>();
      for (const r of e.rs) perRoom.set(r.room_id, [...(perRoom.get(r.room_id) ?? []), r]);
      score = avg([...perRoom.values()].map((v) => weightedScore(v)!));
    } else score = weightedScore(e.rs);
    out.set(name, { name, units: e.units.size, defects: e.defects, score, prev: null });
  }
  return out;
}

export async function auditReport(sql: Sql, id: string): Promise<AuditReport> {
  const [q] = await sql<AuditReport['check'][]>`
    select q.id, q.number, q.check_date::text as check_date, q.status::text as status, q.inspector, q.attendee, q.summary,
           q.site_id, s.name as site_name, s.site_no,
           concat_ws(', ', s.street, concat_ws(' ', s.postal_code, s.city)) as site_address,
           c.name as customer_name, q.signed_by_name, q.signature_path, q.closed_at
      from app.quality_checks q join app.sites s on s.id = q.site_id join app.customers c on c.id = s.customer_id
     where q.id = ${id}`;
  if (!q) throw new BusinessError('Qualitätskontrolle nicht gefunden');
  const settings = await qmSettings(sql);
  const low = settings.threshold_low;
  const rooms = await sql<
    {
      id: string;
      name: string;
      floor: string | null;
      room_no: string | null;
      floor_covering: string | null;
      area_centi: bigint;
      room_type: string;
    }[]
  >`
    select r.id, r.name, r.floor, r.room_no, r.floor_covering, r.area_centi, t.name as room_type
      from app.rooms r join app.room_types t on t.id = r.room_type_id where r.site_id = ${q.site_id}
     order by r.floor nulls first, r.sort_order, r.room_no nulls last, r.name`;
  const roomGroup = new Map(rooms.map((r) => [r.id, r.room_type]));
  // alle Audits des Objekts (Verlauf, Vorgänger)
  const all = await sql<
    {
      id: string;
      number: string;
      date: string;
      score: number | null;
      status: string;
      inspector: string;
      created_at: Date;
    }[]
  >`
    select id, number, check_date::text as date, score_percent as score, status::text, inspector, created_at
      from app.quality_checks where site_id = ${q.site_id}
     order by check_date, created_at`;
  const idx = all.findIndex((a) => a.id === id);
  const prev = all
    .slice(0, idx)
    .filter((a) => a.status === 'abgeschlossen')
    .at(-1);
  const ratings = await ratingsOf(sql, [id, ...(prev ? [prev.id] : [])]);
  const cur = ratings.filter((r) => r.check_id === id);
  const old = ratings.filter((r) => r.check_id === prev?.id);

  let reportRooms: ReportRoom[];
  if (cur.length) {
    reportRooms = rooms
      .map((r) => {
        const rs = cur.filter((x) => x.room_id === r.id);
        const times = rs.map((x) => x.rated_at.getTime());
        return {
          id: r.id,
          label: [r.room_no, r.name].filter(Boolean).join(' '),
          meta: roomMeta(r),
          group: r.room_type,
          score: weightedScore(rs),
          defects: rs
            .filter((x) => !x.skipped && x.percent != null && x.percent < low)
            .map((x) => ({
              item: x.item,
              description: x.description,
              note: x.note,
              label: QM_SCALE[x.kind].find((o) => o.v === x.value)?.label ?? String(x.value),
              pct: x.percent!,
              weight: x.weight,
              photos: x.photo_ids,
            })),
          first: times.length ? new Date(Math.min(...times)) : null,
          last: times.length ? new Date(Math.max(...times)) : null,
        };
      })
      .filter((r) => r.score != null);
  } else {
    // ältere Kontrollen ohne Noten: Bereich in Ordnung = 100 %, Mangel = 0 %
    const items = await sql<
      {
        room_id: string | null;
        area: string;
        rating: string;
        defects: string[];
        note: string | null;
        position: number;
      }[]
    >`select room_id, area, rating::text, defects, note, position from app.quality_check_items
       where check_id = ${id} and rating <> 'nicht_geprueft' order by position`;
    reportRooms = items.map((i) => ({
      id: i.room_id ?? `pos-${i.position}`,
      label: i.area,
      meta: '',
      group: (i.room_id && roomGroup.get(i.room_id)) || 'Bereich',
      score: i.rating === 'ok' ? 100 : 0,
      defects:
        i.rating === 'mangel'
          ? [
              {
                item: i.defects.join(', ') || 'Mangel',
                description: null,
                note: i.note,
                label: 'Mangel',
                pct: 0,
                weight: 2,
                photos: [],
              },
            ]
          : [],
      first: null,
      last: null,
    }));
  }
  const score =
    q.status === 'abgeschlossen'
      ? (all[idx]?.score ?? avg(reportRooms.map((r) => r.score!)))
      : avg(reportRooms.map((r) => r.score!));
  const target = settings.threshold_target;
  const ampel = {
    low: reportRooms.filter((r) => r.score! < low).length,
    mid: reportRooms.filter((r) => r.score! >= low && r.score! < target).length,
    high: reportRooms.filter((r) => r.score! >= target).length,
  };

  let groups: ReportRow[];
  let areas: ReportRow[];
  if (cur.length) {
    const g = breakdown(cur, roomGroup, low, 'group');
    const gp = breakdown(old, roomGroup, low, 'group');
    const a = breakdown(cur, roomGroup, low, 'area');
    const ap = breakdown(old, roomGroup, low, 'area');
    groups = [...g.values()].map((x) => ({ ...x, prev: gp.get(x.name)?.score ?? null }));
    areas = [...a.values()].map((x) => ({ ...x, prev: ap.get(x.name)?.score ?? null }));
  } else {
    const m = new Map<string, ReportRoom[]>();
    for (const r of reportRooms) m.set(r.group, [...(m.get(r.group) ?? []), r]);
    groups = [...m].map(([name, rs]) => ({
      name,
      units: rs.length,
      defects: rs.reduce((s, r) => s + r.defects.length, 0),
      score: avg(rs.map((r) => r.score!)),
      prev: null,
    }));
    areas = [];
  }
  groups.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  areas.sort((a, b) => a.name.localeCompare(b.name, 'de'));

  const top = topItems(cur);

  const unitsOf = async (ids: string[]) => {
    if (!ids.length) return new Map<string, number>();
    const rows = await sql<{ check_id: string; n: number }[]>`
      select check_id, count(distinct room_id)::int as n from app.quality_check_ratings
       where check_id in ${sql(ids)} and not skipped group by check_id`;
    const items = await sql<{ check_id: string; n: number }[]>`
      select check_id, count(*)::int as n from app.quality_check_items
       where check_id in ${sql(ids)} and rating <> 'nicht_geprueft' group by check_id`;
    const m = new Map(items.map((r) => [r.check_id, r.n]));
    for (const r of rows) m.set(r.check_id, r.n);
    return m;
  };
  const hist = all.filter((a) => a.status === 'abgeschlossen' || a.id === id).slice(-12);
  const units = await unitsOf(hist.map((h) => h.id));
  const history = hist.map((h) => ({
    id: h.id,
    number: h.number,
    date: h.date,
    score: h.id === id ? (score ?? 0) : (h.score ?? 0),
    inspector: h.inspector,
    units: h.id === id ? reportRooms.length : (units.get(h.id) ?? 0),
  }));

  return {
    check: q,
    settings,
    score,
    prevScore: prev?.score ?? null,
    rooms: reportRooms,
    ampel,
    history,
    groups,
    areas,
    top,
    defectCount: reportRooms.reduce((s, r) => s + r.defects.length, 0),
  };
}

// ---------------------------------------------------------------- Statistik über mehrere Audits

export interface QmStatistics {
  settings: QmSettings;
  checks: number;
  units: number;
  defects: number;
  score: number | null;
  months: { month: string; score: number; checks: number }[];
  sites: {
    site_id: string;
    site_no: string;
    site_name: string;
    customer_name: string;
    checks: number;
    last_date: string;
    last: number;
    avg: number;
    trend: number | null;
  }[];
  areas: ReportRow[];
  groups: ReportRow[];
  top: TopItem[];
}

export async function qmStatistics(
  sql: Sql,
  f: {
    from: string;
    to: string;
    customerId?: string | null;
    siteId?: string | null;
    siteIds: string[] | null;
  },
): Promise<QmStatistics> {
  const settings = await qmSettings(sql);
  const checks = await sql<
    {
      id: string;
      site_id: string;
      site_no: string;
      site_name: string;
      customer_name: string;
      date: string;
      score: number;
      checked_count: number;
      defect_count: number;
    }[]
  >`
    select q.id, q.site_id, s.site_no, s.name as site_name, c.name as customer_name, q.check_date::text as date,
           q.score_percent as score, q.checked_count, q.defect_count
      from app.quality_checks q join app.sites s on s.id = q.site_id join app.customers c on c.id = s.customer_id
     where q.status = 'abgeschlossen' and q.check_date between ${f.from} and ${f.to}
       and ${f.customerId ? sql`s.customer_id = ${f.customerId}` : sql`true`}
       and ${f.siteId ? sql`q.site_id = ${f.siteId}` : sql`true`}
       and ${f.siteIds ? (f.siteIds.length ? sql`q.site_id in ${sql(f.siteIds)}` : sql`false`) : sql`true`}
     order by q.check_date, q.created_at`;
  const ratings = await ratingsOf(
    sql,
    checks.map((c) => c.id),
  );
  const roomGroup = new Map(
    (
      await sql<{ id: string; t: string }[]>`
        select r.id, t.name as t from app.rooms r join app.room_types t on t.id = r.room_type_id
         where r.id in (select distinct room_id from app.quality_check_ratings where check_id = any(${checks.map((c) => c.id)}::uuid[]))`
    ).map((r) => [r.id, r.t]),
  );
  const low = settings.threshold_low;
  const units = new Set(ratings.filter((r) => !r.skipped).map((r) => `${r.check_id}:${r.room_id}`));
  const ratedChecks = new Set(ratings.map((r) => r.check_id));
  const unitCount =
    units.size + checks.filter((c) => !ratedChecks.has(c.id)).reduce((s, c) => s + (c.checked_count ?? 0), 0);
  const defects =
    ratings.filter((r) => !r.skipped && r.percent != null && r.percent < low).length +
    checks.filter((c) => !ratedChecks.has(c.id)).reduce((s, c) => s + (c.defect_count ?? 0), 0);

  const mm = new Map<string, number[]>();
  for (const c of checks) mm.set(c.date.slice(0, 7), [...(mm.get(c.date.slice(0, 7)) ?? []), c.score]);
  const months = [...mm].map(([month, s]) => ({ month, score: avg(s)!, checks: s.length }));

  const sm = new Map<string, (typeof checks)[number][]>();
  for (const c of checks) sm.set(c.site_id, [...(sm.get(c.site_id) ?? []), c]);
  const sites = [...sm.values()]
    .map((cs) => {
      const last = cs.at(-1)!;
      const before = cs.at(-2);
      return {
        site_id: last.site_id,
        site_no: last.site_no,
        site_name: last.site_name,
        customer_name: last.customer_name,
        checks: cs.length,
        last_date: last.date,
        last: last.score,
        avg: avg(cs.map((c) => c.score))!,
        trend: before ? last.score - before.score : null,
      };
    })
    .sort((a, b) => a.avg - b.avg);

  const areas = [...breakdown(ratings, roomGroup, low, 'area').values()].sort(
    (a, b) => (a.score ?? 0) - (b.score ?? 0),
  );
  const groups = [...breakdown(ratings, roomGroup, low, 'group').values()].sort(
    (a, b) => (a.score ?? 0) - (b.score ?? 0),
  );
  const top = topItems(ratings);
  return {
    settings,
    checks: checks.length,
    units: unitCount,
    defects,
    score: avg(checks.map((c) => c.score)),
    months,
    sites,
    areas,
    groups,
    top,
  };
}

// ---------------------------------------------------------------- PDF

const RED = rgb(0.74, 0.16, 0.16);
const AMBER = rgb(0.86, 0.6, 0.1);
const GREEN = rgb(0.2, 0.55, 0.32);
const LIGHT = rgb(0.93, 0.92, 0.93);
const { L, R } = FORM_X;
const { H } = FORM_Y;
const { BORDEAUX, MUT } = FORM_COLORS;

const pctText = (n: number | null) => (n == null ? '–' : `${n} %`);
const deltaText = (cur: number | null, prev: number | null) =>
  cur == null || prev == null ? '–' : `${cur - prev > 0 ? '+' : ''}${cur - prev} %-Pkt.`;
const colorOf = (s: number, st: QmSettings) =>
  s < st.threshold_low ? RED : s < st.threshold_target ? AMBER : GREEN;

/** Liniendiagramm Qualitätsverlauf mit Schwellwert und Zielbereich */
function lineChart(d: FormDoc, pts: { label: string; v: number }[], st: QmSettings, h = 130) {
  d.ensure(h + 30);
  const x0 = L + 26;
  const x1 = R - 6;
  const y0 = d.y + 6;
  const y1 = y0 + h;
  const yOf = (v: number) => y1 - (v / 100) * h;
  // Zielbereich
  d.rect(x0, yOf(100), x1 - x0, yOf(st.threshold_target) - yOf(100), rgb(0.93, 0.97, 0.94));
  for (const v of [0, 25, 50, 75, 100]) {
    d.line(x0, x1, yOf(v), LIGHT, 0.4);
    d.right(`${v}`, x0 - 4, yOf(v) + 2.5, { size: 6.5, color: MUT });
  }
  d.line(x0, x1, yOf(st.threshold_low), RED, 0.8);
  d.text(`Schwellwert ${st.threshold_low} %`, x0 + 4, yOf(st.threshold_low) - 3, { size: 6.5, color: RED });
  d.text(`Zielbereich ab ${st.threshold_target} %`, x0 + 4, yOf(100) + 9, { size: 6.5, color: GREEN });
  if (!pts.length) {
    d.y = y1 + 22;
    return;
  }
  const step = pts.length > 1 ? (x1 - x0 - 40) / (pts.length - 1) : 0;
  const xs = pts.map((_, i) => x0 + 20 + i * step);
  for (let i = 1; i < pts.length; i++)
    d.page.drawLine({
      start: { x: xs[i - 1]!, y: H - yOf(pts[i - 1]!.v) },
      end: { x: xs[i]!, y: H - yOf(pts[i]!.v) },
      thickness: 1.4,
      color: BORDEAUX,
    });
  pts.forEach((p, i) => {
    d.page.drawCircle({ x: xs[i]!, y: H - yOf(p.v), size: 2.6, color: colorOf(p.v, st) });
    const t = `${p.v} %`;
    d.text(t, xs[i]! - d.width(t, 6.8, true) / 2, yOf(p.v) - 6, { size: 6.8, bold: true });
    d.text(p.label, xs[i]! - d.width(p.label, 6.2) / 2, y1 + 10, { size: 6.2, color: MUT });
  });
  d.y = y1 + 22;
}

/** Waagerechte Balken je Zeile (Qualität) mit Schwellwert-Linie */
function barChart(d: FormDoc, rows: { name: string; v: number | null }[], st: QmSettings) {
  const bh = 11;
  const gap = 5;
  const lw = 150;
  const x0 = L + lw;
  const x1 = R - 34;
  const h = rows.length * (bh + gap) + 10;
  d.ensure(h + 10);
  const top = d.y;
  rows.forEach((r, i) => {
    const y = top + i * (bh + gap);
    d.text(d.fit(r.name, lw - 10, 7.5), L, y + 8.5, { size: 7.5 });
    d.rect(x0, y, x1 - x0, bh, LIGHT);
    if (r.v != null) {
      d.rect(x0, y, ((x1 - x0) * r.v) / 100, bh, colorOf(r.v, st));
      d.text(`${r.v} %`, x1 + 4, y + 8.5, { size: 7.5, bold: true });
    }
  });
  const lx = x0 + ((x1 - x0) * st.threshold_low) / 100;
  d.page.drawLine({
    start: { x: lx, y: H - top + 3 },
    end: { x: lx, y: H - (top + rows.length * (bh + gap)) },
    thickness: 0.8,
    color: RED,
    dashArray: [2, 2],
  });
  d.y = top + h;
}

/** Ampel: Anzahl Einheiten unter Schwellwert / bis Ziel / im Ziel als geteilter Balken */
function ampelBar(d: FormDoc, a: AuditReport['ampel'], st: QmSettings) {
  const total = a.low + a.mid + a.high;
  d.ensure(56);
  const parts: [number, ReturnType<typeof rgb>, string][] = [
    [a.low, RED, `unter ${st.threshold_low} %`],
    [a.mid, AMBER, `${st.threshold_low} bis ${st.threshold_target - 1} %`],
    [a.high, GREEN, `ab ${st.threshold_target} %`],
  ];
  let x = L;
  const w = R - L;
  if (!total) d.rect(L, d.y, w, 16, LIGHT);
  for (const [n, c] of parts) {
    if (!n) continue;
    const pw = (w * n) / total;
    d.rect(x, d.y, pw, 16, c);
    if (pw > 18)
      d.text(String(n), x + pw / 2 - d.width(String(n), 8, true) / 2, d.y + 11.5, {
        size: 8,
        bold: true,
        color: rgb(1, 1, 1),
      });
    x += pw;
  }
  d.y += 26;
  let lx = L;
  for (const [n, c, t] of parts) {
    d.rect(lx, d.y - 7, 8, 8, c);
    const s = `${t}: ${n} ${n === 1 ? 'Einheit' : 'Einheiten'}`;
    d.text(s, lx + 12, d.y, { size: 7.5 });
    lx += d.width(s, 7.5) + 30;
  }
  d.y += 14;
}

const timeDe = (t: Date | null) =>
  t ? t.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }) : '';

export async function renderAuditReportPdf(deps: Deps, cfg: UploadConfig, id: string): Promise<Uint8Array> {
  const r = await auditReport(deps.sql, id);
  const q = r.check;
  const st = r.settings;
  const d = await FormDoc.create({
    title: `Auswertungsbericht ${q.number}`,
    sideRef: `Auswertungsbericht Qualitätskontrolle ${q.number}`,
    date: q.check_date,
    author: 'Viva-Deluxe Gebäudereinigung GmbH',
    plain: true,
    ...(q.status === 'entwurf' ? { watermark: 'ENTWURF' } : {}),
  });
  d.title('Auswertungsbericht Qualitätskontrolle', q.number);
  d.infoGrid([
    ['Kunde', q.customer_name],
    ['Objekt', `${q.site_name} (${q.site_no})`],
    ['Adresse', q.site_address],
    ['Prüfdatum', formatDateDe(q.check_date)],
    ['Prüfer', q.inspector],
    ['Anwesend', q.attendee ?? '–'],
  ]);
  d.tiles([
    { label: 'Ergebnis', value: pctText(r.score), sub: `Ziel ab ${st.threshold_target} %`, accent: true },
    { label: 'Geprüfte Einheiten', value: String(r.rooms.length) },
    { label: 'Mängel', value: String(r.defectCount), sub: `Bewertung unter ${st.threshold_low} %` },
    { label: 'Änderung', value: deltaText(r.score, r.prevScore), sub: 'zum letzten Audit' },
  ]);
  if (q.summary) {
    d.section('Kommentar');
    d.para(q.summary);
  }
  d.section('Ampel – Einheiten nach Qualität');
  ampelBar(d, r.ampel, st);
  d.section('Qualitätsverlauf des Objekts');
  lineChart(
    d,
    r.history.map((h) => ({ label: formatDateDe(h.date).slice(0, 6) + h.date.slice(2, 4), v: h.score })),
    st,
  );

  const rowTable = (rows: ReportRow[], first: string) => {
    d.table(
      [
        { label: first, width: 190 },
        { label: 'Einheiten', width: 70, align: 'right' },
        { label: 'Mängel', width: 70, align: 'right' },
        { label: 'Qualität', width: 80, align: 'right' },
        { label: 'Änderung', width: 88, align: 'right' },
      ],
      rows.map((g) => [
        g.name,
        String(g.units),
        String(g.defects),
        pctText(g.score),
        deltaText(g.score, g.prev),
      ]),
    );
    barChart(
      d,
      rows.map((g) => ({ name: g.name, v: g.score })),
      st,
    );
  };
  if (r.groups.length) {
    d.ensure(90 + r.groups.length * 34);
    d.section('Leistungsgruppen (Nutzungsarten)');
    rowTable(r.groups, 'Leistungsgruppe');
  }
  if (r.areas.length) {
    d.ensure(90 + r.areas.length * 34);
    d.section('Leistungsbereiche');
    rowTable(r.areas, 'Leistungsbereich');
  }
  if (r.top.length) {
    d.ensure(80);
    d.section('Top 10 Verbesserungspotentiale');
    d.table(
      [
        { label: 'Kontrollgegenstand', width: 130 },
        { label: 'Tätigkeit', width: 196 },
        { label: 'Gewicht', width: 56 },
        { label: 'Bewertungen', width: 60, align: 'right' },
        { label: 'Qualität', width: 56, align: 'right' },
      ],
      r.top.map((t) => [
        t.item,
        t.description ?? '',
        WEIGHT_LABEL[t.weight] ?? '',
        String(t.count),
        pctText(t.score),
      ]),
    );
  }
  d.section('Durchgeführte Prüfungen');
  d.table(
    [
      { label: 'Datum', width: 80 },
      { label: 'Nummer', width: 100 },
      { label: 'Prüfer', width: 170 },
      { label: 'Einheiten', width: 74, align: 'right' },
      { label: 'Ergebnis', width: 74, align: 'right' },
    ],
    [...r.history]
      .reverse()
      .map((h) => [formatDateDe(h.date), h.number, h.inspector, String(h.units), pctText(h.score)]),
  );

  d.section('Geprüfte Einheiten');
  d.table(
    [
      { label: 'Einheit', width: 150 },
      { label: 'Etage | Belag | Fläche', width: 130 },
      { label: 'Leistungsgruppe', width: 100 },
      { label: 'Zeit', width: 40 },
      { label: 'Mängel', width: 38, align: 'right' },
      { label: 'Qualität', width: 40, align: 'right' },
    ],
    r.rooms.map((x) => [
      x.label,
      x.meta,
      x.group,
      timeDe(x.first),
      String(x.defects.length),
      pctText(x.score),
    ]),
    { size: 8 },
  );

  const withDefects = r.rooms.filter((x) => x.defects.length);
  if (withDefects.length) {
    d.section('Mängelliste');
    const files = new Map<string, FileRow>();
    const ids = [...new Set(withDefects.flatMap((x) => x.defects.flatMap((y) => y.photos)))];
    if (ids.length)
      for (const f of await deps.sql<
        FileRow[]
      >`select * from app.files where id in ${deps.sql(ids)} and status = 'complete'`)
        files.set(f.id, f);
    // Aufnahme-Kennzeichen je Foto (Zeitpunkt, Standort gegenüber dem Objekt)
    const tags = new Map<string, string>();
    if (ids.length)
      for (const t of await deps.sql<
        { file_id: string; taken: string; geo: GeoStatus; geo_m: number | null }[]
      >`select file_id, to_char(taken_at at time zone 'Europe/Berlin', 'DD.MM. HH24:MI') as taken, geo, geo_m
          from app.qm_photo_tags where file_id in ${deps.sql(ids)}`)
        tags.set(
          t.file_id,
          `${t.taken} · ${GEO_LABEL[t.geo]}${t.geo_m != null && t.geo !== 'am_objekt' ? ` (${t.geo_m} m)` : ''}`,
        );
    let photoBudget = 60;
    for (const room of withDefects) {
      d.heading(`${room.label}${room.meta ? ` · ${room.meta}` : ''} – ${pctText(room.score)}`, 9.5);
      d.table(
        [
          { label: 'Kontrollgegenstand', width: 120 },
          { label: 'Beschreibung', width: 150 },
          { label: 'Bemerkung', width: 120 },
          { label: 'Gewicht', width: 50 },
          { label: 'Bewertung', width: 58, align: 'right' },
        ],
        room.defects.map((x) => [
          x.item,
          x.description ?? '',
          x.note ?? '',
          WEIGHT_LABEL[x.weight] ?? '',
          `${x.label} (${x.pct} %)`,
        ]),
        { size: 8 },
      );
      // Fotos klein darunter (nur JPG/PNG)
      const photos = room.defects
        .flatMap((x) => x.photos)
        .map((p) => files.get(p))
        .filter((f): f is FileRow => !!f);
      let px = L;
      const ph = 70;
      for (const f of photos) {
        if (photoBudget <= 0) break;
        const isJpg = /jpe?g/i.test(f.content_type);
        const isPng = /png/i.test(f.content_type);
        if (!isJpg && !isPng) continue;
        let img;
        try {
          const bytes = new Uint8Array(await readFile(filePath(cfg, f)));
          img = isJpg ? await d.pdf.embedJpg(bytes) : await d.pdf.embedPng(bytes);
        } catch {
          continue;
        }
        photoBudget--;
        const w = (img.width / img.height) * ph;
        if (px + w > R) {
          px = L;
          d.y += ph + 6;
        }
        if (d.y + ph > d.bottom) {
          d.newPage();
          px = L;
        }
        d.page.drawImage(img, { x: px, y: H - d.y - ph, width: w, height: ph });
        const tag = tags.get(f.id);
        if (tag)
          d.text(d.fit(tag, Math.max(w, 90), 6), px, d.y + ph + 7, { size: 6, color: rgb(0.4, 0.4, 0.4) });
        px += Math.max(w, tag ? 90 : 0) + 6;
      }
      if (px > L) d.y += ph + 18;
    }
  }

  if (q.signed_by_name && q.signature_path) {
    const png = await d.embedPng(await deps.archive.get(q.signature_path)).catch(() => null);
    d.signatures('Prüfer (Viva-Deluxe)', 'Kunde', {
      leftText: q.inspector,
      png,
      rightText: q.signed_by_name,
    });
  } else {
    d.muted(
      `Bewertung je Einheit: gewichteter Durchschnitt der Kontrollgegenstände (Gewicht 1 gering … 5 kritisch); Ergebnis: Durchschnitt der Einheiten. Mängel = Bewertung unter ${st.threshold_low} %.`,
    );
  }
  return d.save();
}

/** Statistik-PDF (Auswertungen über mehrere Audits) */
export async function renderQmStatisticsPdf(
  s: QmStatistics,
  f: { from: string; to: string; scope: string },
): Promise<Uint8Array> {
  const d = await FormDoc.create({
    title: 'Qualitätsstatistik',
    sideRef: `Qualitätsstatistik ${formatDateDe(f.from)} – ${formatDateDe(f.to)}`,
    date: f.to,
    author: 'Viva-Deluxe Gebäudereinigung GmbH',
    plain: true,
  });
  d.title('Qualitätsstatistik', `${formatDateDe(f.from)} – ${formatDateDe(f.to)}`);
  d.infoGrid([
    ['Auswahl', f.scope],
    ['Zeitraum', `${formatDateDe(f.from)} – ${formatDateDe(f.to)}`],
    ['Schwellwert / Ziel', `${s.settings.threshold_low} % / ${s.settings.threshold_target} %`],
  ]);
  d.tiles([
    { label: 'Ø Ergebnis', value: pctText(s.score), accent: true },
    { label: 'Audits', value: String(s.checks) },
    { label: 'Geprüfte Einheiten', value: String(s.units) },
    { label: 'Mängel', value: String(s.defects) },
  ]);
  d.section('Qualitätsverlauf (Ø je Monat)');
  lineChart(
    d,
    s.months.map((m) => ({ label: `${m.month.slice(5)}/${m.month.slice(2, 4)}`, v: m.score })),
    s.settings,
  );
  if (s.sites.length) {
    d.section('Objekte');
    d.table(
      [
        { label: 'Objekt', width: 180 },
        { label: 'Kunde', width: 120 },
        { label: 'Audits', width: 46, align: 'right' },
        { label: 'Letztes', width: 52, align: 'right' },
        { label: 'Ø', width: 46, align: 'right' },
        { label: 'Trend', width: 54, align: 'right' },
      ],
      s.sites.map((x) => [
        `${x.site_name} (${x.site_no})`,
        x.customer_name,
        String(x.checks),
        pctText(x.last),
        pctText(x.avg),
        x.trend == null ? '–' : `${x.trend > 0 ? '+' : ''}${x.trend}`,
      ]),
      { size: 8 },
    );
  }
  if (s.areas.length) {
    d.section('Leistungsbereiche');
    barChart(
      d,
      s.areas.map((a) => ({ name: a.name, v: a.score })),
      s.settings,
    );
  }
  if (s.groups.length) {
    d.section('Leistungsgruppen (Nutzungsarten)');
    barChart(
      d,
      s.groups.map((a) => ({ name: a.name, v: a.score })),
      s.settings,
    );
  }
  if (s.top.length) {
    d.section('Top 10 Verbesserungspotentiale');
    d.table(
      [
        { label: 'Kontrollgegenstand', width: 130 },
        { label: 'Tätigkeit', width: 196 },
        { label: 'Gewicht', width: 56 },
        { label: 'Bewertungen', width: 60, align: 'right' },
        { label: 'Qualität', width: 56, align: 'right' },
      ],
      s.top.map((t) => [
        t.item,
        t.description ?? '',
        WEIGHT_LABEL[t.weight] ?? '',
        String(t.count),
        pctText(t.score),
      ]),
    );
  }
  return d.save();
}
