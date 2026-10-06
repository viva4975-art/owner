import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { renderLetterPdf } from '../pdf/render.js';
import { assertVersion } from './crm.js';
import { BusinessError } from './errors.js';
import { buildBuyerSnapshot, getSeller } from './masterdata.js';
import { assertSignaturePng } from './orders.js';
import { nextYearNumber } from './purchasing.js';
import type { Deps } from './workflow.js';

/*
 * Objektbetreuung: Raumbuch mit Leistungswerten (→ Stundenvorgabe), Qualitätskontrollen, Zählerstände.
 *
 * Stundenvorgabe je Raum: Fläche (m²) ÷ Leistungswert (m²/h) × Reinigungen pro Jahr.
 * Fläche als m² × 100 (ganze Zahl), Reinigungen pro Jahr als ganze Zahl (5×/Woche = 260) → keine Rundungsdrift;
 * gerundet wird erst bei der Anzeige.
 */

// ---------------------------------------------------------------------------
// Raumbuch
// ---------------------------------------------------------------------------

export interface RoomType {
  id: string;
  name: string;
  performance_m2_per_h: number;
  sort_order: number;
  active: boolean;
  version: number;
}

export interface Room {
  id: string;
  site_id: string;
  room_no: string | null;
  name: string;
  floor: string | null;
  room_type_id: string;
  floor_covering: string | null;
  area_centi: bigint;
  visits_per_year: number;
  performance_override: number | null;
  notes: string | null;
  active: boolean;
  sort_order: number;
  version: number;
}

export type RoomRow = Room & { type_name: string; performance: number };

/** Übliche Intervalle (Reinigungen pro Jahr). */
export const FREQUENCIES: [number, string][] = [
  [365, 'täglich (Mo–So)'],
  [312, '6× pro Woche'],
  [260, '5× pro Woche'],
  [208, '4× pro Woche'],
  [156, '3× pro Woche'],
  [104, '2× pro Woche'],
  [52, '1× pro Woche'],
  [26, '14-täglich'],
  [12, '1× pro Monat'],
  [4, '1× pro Quartal'],
  [2, '2× pro Jahr'],
  [1, '1× pro Jahr'],
];
export const frequencyLabel = (v: number) => FREQUENCIES.find(([k]) => k === v)?.[1] ?? `${v}× pro Jahr`;

export async function listRoomTypes(sql: Sql, all = false) {
  return sql<RoomType[]>`
    select * from app.room_types where ${all ? sql`true` : sql`active`} order by sort_order, name`;
}

export async function saveRoomType(
  sql: Sql,
  id: string,
  p: { name: string; active: boolean; expectedVersion: number | null },
) {
  if (!p.name.trim()) throw new BusinessError('Bitte Bezeichnung angeben');
  const [cur] = await sql<{ version: number }[]>`select version from app.room_types where id = ${id}`;
  assertVersion(cur?.version, p.expectedVersion, 'Die Raumart');
  try {
    // Leistungswert (m²/h) wird nicht mehr gepflegt – Spalte bleibt mit Standardwert für Altdaten
    await sql`
      insert into app.room_types (id, name, performance_m2_per_h, sort_order, active)
      values (${id}, ${p.name.trim()}, 200,
              (select coalesce(max(sort_order), 0) + 10 from app.room_types), ${p.active})
      on conflict (id) do update set name = excluded.name, active = excluded.active`;
  } catch (e) {
    if ((e as { code?: string }).code === '23505')
      throw new BusinessError(`Raumart „${p.name.trim()}“ gibt es schon`);
    throw e;
  }
}

export async function listRooms(sql: Sql, siteId: string, includeInactive = false) {
  return sql<RoomRow[]>`
    select r.*, t.name as type_name, coalesce(r.performance_override, t.performance_m2_per_h) as performance
      from app.rooms r join app.room_types t on t.id = r.room_type_id
     where r.site_id = ${siteId} and ${includeInactive ? sql`true` : sql`r.active`}
     order by r.floor nulls first, r.sort_order, r.room_no nulls last, r.name`;
}

export async function getRoom(sql: Sql, id: string) {
  const [r] = await sql<Room[]>`select * from app.rooms where id = ${id}`;
  return r;
}

export interface RoomInput {
  siteId: string;
  roomNo: string | null;
  name: string;
  floor: string | null;
  roomTypeId: string;
  floorCovering: string | null;
  areaCenti: bigint;
  visitsPerYear: number;
  notes: string | null;
  active: boolean;
  expectedVersion: number | null;
}

export async function saveRoom(sql: Sql, id: string, p: RoomInput) {
  if (!p.name.trim()) throw new BusinessError('Bitte Raumbezeichnung angeben');
  if (p.areaCenti <= 0n) throw new BusinessError('Fläche muss größer 0 sein');
  if (!Number.isInteger(p.visitsPerYear) || p.visitsPerYear < 1 || p.visitsPerYear > 1000) {
    throw new BusinessError('Reinigungsintervall ungültig');
  }
  const cur = await getRoom(sql, id);
  if (cur && cur.site_id !== p.siteId) throw new BusinessError('Raum gehört zu einem anderen Objekt');
  assertVersion(cur?.version, p.expectedVersion, 'Der Raum');
  const row = {
    site_id: p.siteId,
    room_no: p.roomNo,
    name: p.name.trim(),
    floor: p.floor,
    room_type_id: p.roomTypeId,
    floor_covering: p.floorCovering,
    area_centi: p.areaCenti,
    visits_per_year: p.visitsPerYear,
    notes: p.notes,
    active: p.active,
  };
  await sql`
    insert into app.rooms ${sql({ id, ...row } as Record<string, unknown>)}
    on conflict (id) do update set ${sql(row as Record<string, unknown>)}`;
}

export type HourTargetMode = 'woche' | 'monat' | 'jahr';
export const WEEKDAYS_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** Stundenvorgabe von Hand: je Wochentag (Mo–So), je Monat oder je Jahr (Minuten). */
export interface SiteHourTarget {
  site_id: string;
  mode: HourTargetMode;
  day_minutes: number[];
  month_minutes: number | null;
  year_minutes: number | null;
  note: string | null;
  version: number;
  updated_by: string;
  updated_at: Date;
}

export async function getSiteHourTarget(sql: Sql, siteId: string) {
  const [t] = await sql<SiteHourTarget[]>`select * from app.site_hour_targets where site_id = ${siteId}`;
  return t;
}

/** Vorgabe in Stunden je Woche/Monat/Jahr umrechnen (Woche = Jahr ÷ 52, Monat = Jahr ÷ 12). */
export function hoursOf(t: Pick<SiteHourTarget, 'mode' | 'day_minutes' | 'month_minutes' | 'year_minutes'>) {
  const perYear =
    t.mode === 'woche'
      ? (t.day_minutes.reduce((a, b) => a + b, 0) * 52) / 60
      : t.mode === 'monat'
        ? ((t.month_minutes ?? 0) * 12) / 60
        : (t.year_minutes ?? 0) / 60;
  return { perYear, perMonth: perYear / 12, perWeek: perYear / 52 };
}

export interface HourTargetInput {
  mode: HourTargetMode;
  dayMinutes: number[];
  monthMinutes: number | null;
  yearMinutes: number | null;
  note: string | null;
  expectedVersion: number | null;
}

export async function saveSiteHourTarget(sql: Sql, siteId: string, p: HourTargetInput, actor: string) {
  if (!['woche', 'monat', 'jahr'].includes(p.mode)) throw new BusinessError('Bitte Art der Vorgabe wählen');
  const days = p.mode === 'woche' ? p.dayMinutes : [0, 0, 0, 0, 0, 0, 0];
  if (days.length !== 7 || days.some((m) => !Number.isInteger(m) || m < 0 || m > 1440))
    throw new BusinessError('Stunden je Wochentag: 0:00 bis 24:00');
  const month = p.mode === 'monat' ? p.monthMinutes : null;
  const year = p.mode === 'jahr' ? p.yearMinutes : null;
  if (p.mode === 'monat' && (month == null || month < 0 || month > 744 * 60))
    throw new BusinessError('Stunden je Monat bitte angeben (0–744)');
  if (p.mode === 'jahr' && (year == null || year < 0 || year > 8784 * 60))
    throw new BusinessError('Stunden je Jahr bitte angeben (0–8784)');
  await sql.begin(async (tx) => {
    const [cur] = await tx<{ version: number }[]>`
      select version from app.site_hour_targets where site_id = ${siteId} for update`;
    assertVersion(cur?.version, p.expectedVersion, 'Die Stundenvorgabe');
    const row = {
      mode: p.mode,
      day_minutes: days,
      month_minutes: month,
      year_minutes: year,
      note: p.note,
      updated_by: actor,
      updated_at: new Date(),
    };
    await tx`
      insert into app.site_hour_targets ${tx({ site_id: siteId, ...row } as Record<string, unknown>)}
      on conflict (site_id) do update set ${tx(row as Record<string, unknown>)}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'hour_target', 'site', ${siteId}, ${tx.json(row as never)})`;
  });
}

export interface HourTarget {
  /** Vorgabe von Hand (undefined = noch keine) */
  target: SiteHourTarget | undefined;
  hoursPerWeek: number;
  hoursPerMonth: number;
  hoursPerYear: number;
  /** Fläche der aktiven Räume (m² × 100) */
  areaCenti: bigint;
  rooms: number;
  /** aktuell im Einsatzplan hinterlegte Stunden pro Woche (netto) */
  plannedPerWeek: number;
  /** monatliche Pauschalen (netto, Cent) – nur fürs Büro anzeigen */
  monthlyFlatCents: bigint;
  /** Stundenvorgabe laut Leistungen (Std. je Monat, wie Fortytools) */
  servicesHoursPerMonth: number;
}

export async function hourTarget(sql: Sql, siteId: string): Promise<HourTarget> {
  const today = todayBerlin();
  const [target, [area], [plan], [flat], [sh]] = await Promise.all([
    getSiteHourTarget(sql, siteId),
    sql<{ area: bigint; n: number }[]>`
      select coalesce(sum(area_centi), 0)::bigint as area, count(*)::int as n from app.rooms
       where site_id = ${siteId} and active`,
    sql<{ minutes: number }[]>`
      select coalesce(sum(extract(epoch from (end_time - start_time)) / 60 - break_minutes), 0)::float8 as minutes
        from app.shift_plans
       where site_id = ${siteId} and valid_from <= ${today} and (valid_until is null or valid_until >= ${today})`,
    sql<{ cents: bigint }[]>`
      select coalesce(sum(round(quantity_milli * unit_price_cents / 1000.0)), 0)::bigint as cents
        from app.site_services
       where site_id = ${siteId} and kind = 'monthly_flat' and active
         and valid_from <= ${today} and (valid_to is null or valid_to >= ${today})`,
    sql<{ milli: bigint }[]>`
      select coalesce(sum(hours_target_milli), 0)::bigint as milli from app.site_services
       where site_id = ${siteId} and active and valid_from <= ${today} and (valid_to is null or valid_to >= ${today})`,
  ]);
  const h = target ? hoursOf(target) : { perYear: 0, perMonth: 0, perWeek: 0 };
  return {
    target,
    hoursPerWeek: h.perWeek,
    hoursPerMonth: h.perMonth,
    hoursPerYear: h.perYear,
    areaCenti: area?.area ?? 0n,
    rooms: area?.n ?? 0,
    plannedPerWeek: (plan?.minutes ?? 0) / 60,
    monthlyFlatCents: flat?.cents ?? 0n,
    servicesHoursPerMonth: Number(sh?.milli ?? 0n) / 1000,
  };
}

// ---------------------------------------------------------------------------
// Qualitätskontrolle
// ---------------------------------------------------------------------------

export type QcRating = 'ok' | 'mangel' | 'nicht_geprueft';
export const QC_RATING: Record<QcRating, string> = {
  ok: 'in Ordnung',
  mangel: 'Mangel',
  nicht_geprueft: 'nicht geprüft',
};
export const DEFECT_CATEGORIES = [
  'Boden',
  'Oberflächen / Mobiliar',
  'Sanitärobjekte',
  'Spiegel / Glas',
  'Abfall',
  'Verbrauchsmaterial',
  'Spinnweben / Ecken',
  'Geruch',
];
/** Bewertung ab … % */
export const QC_GOOD = 90;
export const QC_FAIR = 75;

export interface QualityCheck {
  id: string;
  number: string;
  site_id: string;
  check_date: string;
  inspector: string;
  attendee: string | null;
  summary: string | null;
  status: 'entwurf' | 'abgeschlossen';
  score_percent: number | null;
  checked_count: number | null;
  defect_count: number | null;
  signed_by_name: string | null;
  signature_path: string | null;
  pdf_path: string | null;
  pdf_sha256: string | null;
  closed_at: Date | null;
  version: number;
}
export type QualityCheckRow = QualityCheck & {
  site_name: string;
  site_no: string;
  customer_id: string;
  customer_name: string;
};
export interface QcItem {
  id: string;
  check_id: string;
  position: number;
  room_id: string | null;
  area: string;
  rating: QcRating;
  defects: string[];
  note: string | null;
  task_id: string | null;
}

const qcSelect = (sql: Sql) => sql`
  select q.*, s.name as site_name, s.site_no, s.customer_id, c.name as customer_name
    from app.quality_checks q join app.sites s on s.id = q.site_id join app.customers c on c.id = s.customer_id`;

export async function listQualityChecks(sql: Sql, f: { siteId?: string; siteIds?: string[] } = {}) {
  return sql<QualityCheckRow[]>`
    ${qcSelect(sql)}
     where ${f.siteId ? sql`q.site_id = ${f.siteId}` : sql`true`}
       and ${f.siteIds ? (f.siteIds.length ? sql`q.site_id in ${sql(f.siteIds)}` : sql`false`) : sql`true`}
     order by q.check_date desc, q.number desc`;
}

export async function getQualityCheck(sql: Sql, id: string) {
  const [q] = await sql<QualityCheckRow[]>`${qcSelect(sql)} where q.id = ${id}`;
  if (!q) return undefined;
  const items = await sql<
    QcItem[]
  >`select * from app.quality_check_items where check_id = ${id} order by position`;
  return { check: q, items };
}

const DEFAULT_AREAS = ['Eingangsbereich', 'Flure / Treppenhaus', 'Sanitär / WC', 'Büros', 'Teeküche'];

/** Neue Kontrolle anlegen: Bereiche aus dem Raumbuch (sonst Standardbereiche). Idempotent über die ID. */
export async function createQualityCheck(
  sql: Sql,
  id: string,
  p: { siteId: string; checkDate: string; inspector: string; attendee: string | null },
  actor: string,
) {
  if (!p.inspector.trim()) throw new BusinessError('Bitte Prüfer angeben');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.checkDate)) throw new BusinessError('Datum ungültig');
  await sql.begin(async (tx) => {
    const [exists] = await tx`select 1 from app.quality_checks where id = ${id}`;
    if (exists) return;
    const number = await nextYearNumber(tx, 'quality_check', 'QK-', p.checkDate.slice(0, 4), 4);
    await tx`
      insert into app.quality_checks (id, number, site_id, check_date, inspector, attendee, created_by)
      values (${id}, ${number}, ${p.siteId}, ${p.checkDate}, ${p.inspector.trim()}, ${p.attendee}, ${actor})`;
    const rooms = await tx<{ id: string; label: string }[]>`
      select r.id, concat_ws(' · ', nullif(r.floor, ''), concat_ws(' ', r.room_no, r.name)) as label
        from app.rooms r where r.site_id = ${p.siteId} and r.active
       order by r.floor nulls first, r.sort_order, r.room_no nulls last, r.name`;
    const areas = rooms.length
      ? rooms.map((r) => ({ key: r.id, room: r.id as string | null, area: r.label }))
      : DEFAULT_AREAS.map((a) => ({ key: a, room: null as string | null, area: a }));
    let pos = 1;
    for (const a of areas) {
      await tx`
        insert into app.quality_check_items (id, check_id, position, room_id, area)
        values (md5(${'qc-item:' + id + ':' + a.key})::uuid, ${id}, ${pos++}, ${a.room}, ${a.area})`;
    }
  });
}

export interface QcSaveInput {
  attendee: string | null;
  summary: string | null;
  items: { id: string; rating: QcRating; defects: string[]; note: string | null }[];
  extraArea: string | null;
  expectedVersion: number | null;
}

export async function saveQualityCheck(sql: Sql, id: string, p: QcSaveInput) {
  await sql.begin(async (tx) => {
    const [q] = await tx<{ status: string; version: number }[]>`
      select status, version from app.quality_checks where id = ${id} for update`;
    if (!q) throw new BusinessError('Qualitätskontrolle nicht gefunden');
    if (q.status !== 'entwurf') throw new BusinessError('Abgeschlossene Kontrollen sind unveränderbar');
    assertVersion(q.version, p.expectedVersion, 'Die Qualitätskontrolle');
    await tx`update app.quality_checks set attendee = ${p.attendee}, summary = ${p.summary} where id = ${id}`;
    for (const it of p.items) {
      const defects = it.rating === 'mangel' ? it.defects.filter((d) => d.trim()) : [];
      await tx`
        update app.quality_check_items set rating = ${it.rating}, defects = ${defects}, note = ${it.note}
         where id = ${it.id} and check_id = ${id}`;
    }
    if (p.extraArea?.trim()) {
      await tx`
        insert into app.quality_check_items (id, check_id, position, area)
        values (${randomUUID()}, ${id},
                (select coalesce(max(position), 0) + 1 from app.quality_check_items where check_id = ${id}),
                ${p.extraArea.trim()})`;
    }
  });
}

/** Prozentwert: geprüfte Bereiche ohne Mangel ÷ geprüfte Bereiche, kaufmännisch gerundet. */
export function qcScore(items: { rating: QcRating }[]) {
  const checked = items.filter((i) => i.rating !== 'nicht_geprueft').length;
  const defects = items.filter((i) => i.rating === 'mangel').length;
  const score = checked ? Math.floor(((checked - defects) * 200 + checked) / (2 * checked)) : 0;
  return { checked, defects, score };
}

/**
 * Abschließen: Ergebnis einfrieren, für jeden Mangel eine Nachbesserungs-Aufgabe (feste ID → nur einmal),
 * optional Unterschrift des Kunden, PDF write-once ins Archiv.
 */
export async function closeQualityCheck(
  deps: Deps,
  id: string,
  p: { signature: { name: string; png: Uint8Array } | null },
  actor: string,
) {
  const { sql } = deps;
  const data = await getQualityCheck(sql, id);
  if (!data) throw new BusinessError('Qualitätskontrolle nicht gefunden');
  if (data.check.status !== 'entwurf') return;
  const { checked, defects, score } = qcScore(data.items);
  if (!checked) throw new BusinessError('Bitte mindestens einen Bereich bewerten');
  let sig: { path: string; sha256: string; name: string } | null = null;
  if (p.signature) {
    if (!p.signature.name.trim()) throw new BusinessError('Bitte Namen des Unterzeichners angeben');
    assertSignaturePng(p.signature.png);
    const path = `qualitaet/${data.check.check_date.slice(0, 4)}/${data.check.number}/unterschrift-${randomUUID()}.png`;
    const { sha256 } = await deps.archive.put(path, p.signature.png);
    sig = { path, sha256, name: p.signature.name.trim() };
  }
  const due = addDays(todayBerlin(), 3);
  const closed = await sql.begin(async (tx) => {
    const res = await tx`
      update app.quality_checks
         set status = 'abgeschlossen', score_percent = ${score}, checked_count = ${checked}, defect_count = ${defects},
             signed_by_name = ${sig?.name ?? null}, signature_path = ${sig?.path ?? null},
             signature_sha256 = ${sig?.sha256 ?? null}, closed_at = now()
       where id = ${id} and status = 'entwurf' returning id`;
    if (!res.length) return false;
    const [mgr] = await tx<{ login: string | null }[]>`
      select a.login from app.sites s left join app.user_accounts a on a.id = s.manager_user_id
       where s.id = ${data.check.site_id}`;
    for (const it of data.items.filter((i) => i.rating === 'mangel')) {
      const [t] = await tx<{ id: string }[]>`
        insert into app.tasks (id, title, description, due_date, assignee, entity_type, entity_id, created_by)
        values (md5('qc-task:' || ${it.id})::uuid,
                ${`Nachbesserung: ${it.area} (${data.check.number})`.slice(0, 200)},
                ${[it.defects.join(', '), it.note].filter(Boolean).join(' – ') || null},
                ${due}, ${mgr?.login ?? null}, 'site', ${data.check.site_id}, ${actor})
        on conflict (id) do nothing returning id`;
      const taskId =
        t?.id ?? (await tx<{ id: string }[]>`select md5('qc-task:' || ${it.id})::uuid as id`)[0]!.id;
      await tx`update app.quality_check_items set task_id = ${taskId} where id = ${it.id} and task_id is null`;
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'close', 'quality_check', ${id},
                     ${tx.json({ score, checked, defects, signed_by: sig?.name ?? null })})`;
    return true;
  });
  if (closed) await archiveQcPdf(deps, id);
}

function addDays(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function renderQualityCheckPdf(deps: Deps, id: string): Promise<Uint8Array> {
  const data = await getQualityCheck(deps.sql, id);
  if (!data) throw new BusinessError('Qualitätskontrolle nicht gefunden');
  const { check: q, items } = data;
  const seller = await getSeller(deps.sql);
  const buyer = await buildBuyerSnapshot(deps.sql, q.customer_id, q.site_id);
  const png = q.signature_path ? await deps.archive.get(q.signature_path) : null;
  const live = q.status === 'entwurf' ? qcScore(items) : null;
  const score = live ? live.score : q.score_percent!;
  const checked = live ? live.checked : q.checked_count!;
  const defects = live ? live.defects : q.defect_count!;
  return renderLetterPdf({
    title: `Qualitätskontrolle ${q.number}`,
    date: q.check_date,
    info: [
      ['Datum', formatDateDe(q.check_date)],
      ['Objekt', `${q.site_name} (${q.site_no})`.slice(0, 34)],
      ['Prüfer', q.inspector.slice(0, 34)],
      ...(q.attendee ? ([['Anwesend', q.attendee.slice(0, 34)]] as [string, string][]) : []),
    ],
    seller,
    buyer,
    greeting: null,
    intro: `Ergebnis: ${score} % in Ordnung (${checked} Bereiche geprüft, ${defects} mit Mangel).${
      q.summary ? `\n${q.summary}` : ''
    }`,
    columns: [
      { label: 'Pos', x: 62.3, align: 'left' },
      { label: 'Bereich', x: 90, align: 'left' },
      { label: 'Ergebnis', x: 538.8 },
    ],
    rows: items.flatMap((i) => [
      [String(i.position), i.area.slice(0, 62), QC_RATING[i.rating]],
      ...(i.rating === 'mangel' && (i.defects.length || i.note)
        ? [['', `   ${[i.defects.join(', '), i.note].filter(Boolean).join(' – ')}`.slice(0, 70), '']]
        : []),
    ]),
    sums: [],
    total: null,
    paragraphs: defects
      ? ['Für jeden Mangel wurde eine Nachbesserung beauftragt (Frist 3 Tage).']
      : ['Keine Mängel festgestellt.'],
    signature:
      q.status === 'abgeschlossen' && q.signed_by_name
        ? {
            label: 'Kontrolle gemeinsam durchgeführt:',
            png,
            name: q.signed_by_name,
            at:
              q.closed_at!.toLocaleString('de-DE', {
                timeZone: 'Europe/Berlin',
                dateStyle: 'medium',
                timeStyle: 'short',
              }) + ' Uhr',
          }
        : null,
    ...(q.status === 'entwurf' ? { watermark: 'ENTWURF' } : {}),
  });
}

async function archiveQcPdf(deps: Deps, id: string) {
  const [q] = await deps.sql<{ number: string; check_date: string; pdf_path: string | null }[]>`
    select number, check_date, pdf_path from app.quality_checks where id = ${id}`;
  if (!q || q.pdf_path) return;
  const pdf = await renderQualityCheckPdf(deps, id);
  const path = `qualitaet/${q.check_date.slice(0, 4)}/${q.number}/Qualitaetskontrolle_${q.number}.pdf`;
  const { sha256 } = await deps.archive.put(path, pdf);
  await deps.sql`update app.quality_checks set pdf_path = ${path}, pdf_sha256 = ${sha256} where id = ${id} and pdf_path is null`;
}

export async function qualityCheckPdf(deps: Deps, id: string): Promise<Uint8Array> {
  const [q] = await deps.sql<
    { pdf_path: string | null }[]
  >`select pdf_path from app.quality_checks where id = ${id}`;
  if (!q) throw new BusinessError('Qualitätskontrolle nicht gefunden');
  return q.pdf_path ? deps.archive.get(q.pdf_path) : renderQualityCheckPdf(deps, id);
}

/** Verlauf je Objekt (für Kennzahl/Diagramm). */
export async function qcHistory(sql: Sql, siteId: string) {
  return sql<{ check_date: string; score_percent: number; number: string }[]>`
    select check_date, score_percent, number from app.quality_checks
     where site_id = ${siteId} and status = 'abgeschlossen' order by check_date desc limit 12`;
}

// ---------------------------------------------------------------------------
// Zählerstände
// ---------------------------------------------------------------------------

export type MeterKind = 'strom' | 'wasser' | 'gas' | 'waerme' | 'sonstiges';
export const METER_KIND: Record<MeterKind, string> = {
  strom: 'Strom',
  wasser: 'Wasser',
  gas: 'Gas',
  waerme: 'Wärme',
  sonstiges: 'Sonstiges',
};
export const METER_UNIT: Record<MeterKind, string> = {
  strom: 'kWh',
  wasser: 'm³',
  gas: 'm³',
  waerme: 'kWh',
  sonstiges: '',
};

export interface Meter {
  id: string;
  site_id: string;
  kind: MeterKind;
  meter_no: string;
  location: string | null;
  unit: string;
  active: boolean;
  version: number;
}
export type MeterRow = Meter & {
  site_name: string;
  site_no: string;
  last_read_on: string | null;
  last_value_milli: bigint | null;
};
export interface MeterReading {
  id: string;
  meter_id: string;
  read_on: string;
  value_milli: bigint;
  is_replacement: boolean;
  note: string | null;
  recorded_by: string;
  recorded_at: Date;
}

export async function listMeters(sql: Sql, f: { siteId?: string; siteIds?: string[] } = {}) {
  return sql<MeterRow[]>`
    select m.*, s.name as site_name, s.site_no, lr.read_on as last_read_on, lr.value_milli as last_value_milli
      from app.meters m join app.sites s on s.id = m.site_id
      left join lateral (select read_on, value_milli from app.meter_readings r where r.meter_id = m.id
                          order by read_on desc, recorded_at desc limit 1) lr on true
     where ${f.siteId ? sql`m.site_id = ${f.siteId}` : sql`true`}
       and ${f.siteIds ? (f.siteIds.length ? sql`m.site_id in ${sql(f.siteIds)}` : sql`false`) : sql`true`}
     order by s.name, m.kind, m.meter_no`;
}

export async function getMeter(sql: Sql, id: string) {
  const [m] = await sql<Meter[]>`select * from app.meters where id = ${id}`;
  return m;
}

export async function saveMeter(
  sql: Sql,
  id: string,
  p: {
    siteId: string;
    kind: MeterKind;
    meterNo: string;
    location: string | null;
    unit: string | null;
    active: boolean;
    expectedVersion: number | null;
  },
) {
  if (!p.meterNo.trim()) throw new BusinessError('Bitte Zählernummer angeben');
  if (!(p.kind in METER_KIND)) throw new BusinessError('Zählerart ungültig');
  const cur = await getMeter(sql, id);
  if (cur && cur.site_id !== p.siteId) throw new BusinessError('Zähler gehört zu einem anderen Objekt');
  assertVersion(cur?.version, p.expectedVersion, 'Der Zähler');
  const row = {
    site_id: p.siteId,
    kind: p.kind,
    meter_no: p.meterNo.trim(),
    location: p.location,
    unit: p.unit?.trim() || METER_UNIT[p.kind] || 'Einheit',
    active: p.active,
  };
  try {
    await sql`
      insert into app.meters ${sql({ id, ...row } as Record<string, unknown>)}
      on conflict (id) do update set ${sql(row as Record<string, unknown>)}`;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      throw new BusinessError(`Zählernummer ${row.meter_no} gibt es in diesem Objekt schon`);
    }
    throw e;
  }
}

/** Ablesung erfassen (feste ID → doppeltes Absenden legt nichts doppelt an). */
export async function addReading(
  sql: Sql,
  id: string,
  p: { meterId: string; readOn: string; valueMilli: bigint; isReplacement: boolean; note: string | null },
  actor: string,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.readOn)) throw new BusinessError('Datum ungültig');
  if (p.readOn > todayBerlin()) throw new BusinessError('Ablesedatum liegt in der Zukunft');
  if (p.valueMilli < 0n) throw new BusinessError('Zählerstand darf nicht negativ sein');
  try {
    await sql`
      insert into app.meter_readings (id, meter_id, read_on, value_milli, is_replacement, note, recorded_by)
      values (${id}, ${p.meterId}, ${p.readOn}, ${p.valueMilli}, ${p.isReplacement}, ${p.note}, ${actor})
      on conflict (id) do nothing`;
  } catch (e) {
    if ((e as { code?: string }).code === '23514') throw new BusinessError((e as Error).message);
    throw e;
  }
}

/** Ablesungen mit Verbrauch seit der vorigen Ablesung (bei Zählertausch kein Verbrauch). */
export async function readingsWithConsumption(sql: Sql, meterId: string) {
  const rows = await sql<MeterReading[]>`
    select * from app.meter_readings where meter_id = ${meterId} order by read_on, recorded_at`;
  const out: (MeterReading & { consumption_milli: bigint | null; days: number | null })[] = [];
  let prev: MeterReading | null = null;
  for (const r of rows) {
    const ok = prev && !r.is_replacement;
    out.push({
      ...r,
      consumption_milli: ok ? r.value_milli - prev!.value_milli : null,
      days: ok ? Math.round((Date.parse(r.read_on) - Date.parse(prev!.read_on)) / 86_400_000) : null,
    });
    prev = r;
  }
  return out.reverse();
}
