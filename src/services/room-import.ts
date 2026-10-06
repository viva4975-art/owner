import { createHash } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { SheetError, readSheet } from '../domain/sheet/sheet.js';
import { BusinessError } from './errors.js';

/**
 * Raumbuch aus Excel/CSV übernehmen (z. B. Raumbuch des Auftraggebers aus der Ausschreibung).
 * Spalten werden über die Kopfzeile erkannt (die Kopfzeile darf unter Titelzeilen stehen).
 * Vorhandene Räume (gleiche Etage + Raum-Nr., ohne Nr. gleiche Etage + Bezeichnung) werden aktualisiert.
 */

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');

export type RoomField = 'floor' | 'room_no' | 'name' | 'type' | 'covering' | 'area' | 'interval' | 'notes';
export const ROOM_FIELDS: Record<RoomField, { label: string; aliases: string[] }> = {
  floor: {
    label: 'Etage',
    aliases: ['etage', 'geschoss', 'ebene', 'stockwerk', 'gebaeudeteil', 'bauteil', 'og', 'etagegeschoss'],
  },
  room_no: {
    label: 'Raum-Nr.',
    aliases: ['raumnr', 'raumnummer', 'nr', 'nummer', 'rnr', 'raumnrneu', 'raumid'],
  },
  name: {
    label: 'Raum',
    aliases: ['raum', 'raumbezeichnung', 'bezeichnung', 'nutzung', 'raumname', 'raumnutzung', 'name'],
  },
  type: {
    label: 'Raumart',
    aliases: ['raumart', 'raumtyp', 'art', 'kategorie', 'nutzungsart', 'raumgruppe'],
  },
  covering: { label: 'Bodenbelag', aliases: ['bodenbelag', 'belag', 'boden', 'bodenart', 'fussboden'] },
  area: {
    label: 'Fläche m²',
    aliases: [
      'flaeche',
      'flaechem',
      'flaechem2',
      'flaecheqm',
      'qm',
      'm',
      'm2',
      'nettoflaeche',
      'reinigungsflaeche',
      'nrf',
      'bodenflaeche',
      'flaecheinm',
      'flaecheinm2',
    ],
  },
  interval: {
    label: 'Intervall',
    aliases: [
      'intervall',
      'haeufigkeit',
      'reinigungsintervall',
      'turnus',
      'reinigungen',
      'reinigungenprojahr',
      'rhythmus',
      'reinigungshaeufigkeit',
      'frequenz',
    ],
  },
  notes: { label: 'Hinweise', aliases: ['hinweis', 'hinweise', 'bemerkung', 'bemerkungen', 'notiz'] },
};

/** Was „täglich“ bedeutet: Mo–Fr 260, Mo–Sa 312, Mo–So 365 Reinigungen im Jahr (beim Import wählbar). */
export const DAILY_OPTIONS = [
  [260, 'Mo–Fr (260 × im Jahr)'],
  [312, 'Mo–Sa (312 × im Jahr)'],
  [365, 'Mo–So (365 × im Jahr)'],
] as const;
export const dailyOf = (v: unknown): number =>
  DAILY_OPTIONS.some(([n]) => String(n) === String(v)) ? Number(v) : 260;

/** Reinigungsintervall aus Text → Reinigungen pro Jahr. */
export function parseInterval(raw: string, daily = 260): number | null {
  const t = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const numMatch = /(\d+(?:[.,]\d+)?)/.exec(t);
  const n = numMatch ? Number(numMatch[1]!.replace(',', '.')) : null;
  if (/^\d+([.,]\d+)?$/.test(t)) {
    // reine Zahl: bis 7 = pro Woche, sonst pro Jahr
    return n! <= 7 ? Math.round(n! * 52) : Math.round(n!);
  }
  if (
    /14\s*-?\s*taeg|14\s*-?\s*tag|14-täg|14 täg|vierzehnt|zweiwoech|zweiwöch|alle 2 wochen|alle zwei wochen/.test(
      t,
    )
  )
    return 26;
  if (/mo\s*[-–]\s*so|7\s*x?\s*(\/|pro|je|die)?\s*w/.test(t)) return 365;
  if (/mo\s*[-–]\s*sa|6\s*x?\s*(\/|pro|je|die)?\s*w/.test(t)) return 312;
  if (/arbeitst(ae|ä)glich/.test(t)) return 260;
  if (/t(ae|ä)glich|^tgl/.test(t)) return daily;
  if (/halbj/.test(t)) return 2 * (n ?? 1);
  if (/quartal|vierteljaehr|vierteljähr/.test(t)) return 4 * (n ?? 1);
  if (/woch|wtl|wö|\/ ?w\b|x ?w\b/.test(t)) return Math.round((n ?? 1) * 52);
  if (/monat|mtl/.test(t)) return Math.round((n ?? 1) * 12);
  if (/jahr|jaehrl|jährl|jhrl/.test(t)) return Math.round(n ?? 1);
  return null;
}

/** Feste ID (UUID v4-Format) aus einem Schlüssel. */
const uuidOf = (s: string) => {
  const h = createHash('md5').update(s).digest('hex').split('');
  h[12] = '4';
  h[16] = '89ab'[parseInt(h[16]!, 16) & 3]!;
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

export interface RoomImportRow {
  line: number;
  floor: string | null;
  roomNo: string | null;
  name: string;
  typeName: string;
  typeId: string | null;
  covering: string | null;
  areaCenti: bigint | null;
  visits: number | null;
  intervalText: string;
  intervalDefaulted: boolean;
  notes: string | null;
  existingId: string | null;
  errors: string[];
}

export interface RoomImportAnalysis {
  headerLine: number;
  columns: { field: RoomField; header: string }[];
  ignored: string[];
  rows: RoomImportRow[];
  newTypes: string[];
}

/** Fläche → m² × 100, exakt aus dem Text (mehr als 2 Nachkommastellen werden kaufmännisch gerundet). */
export function areaOf(v: string, kind: 'xlsx' | 'csv'): bigint | null {
  let t = v.replace(/m²|m2|qm/gi, '').replace(/\s/g, '');
  if (!t) return null;
  // CSV/Text im deutschen Format: „1.234,56“; Excel-Zahlen haben den Punkt als Dezimaltrenner
  if (kind === 'csv' || t.includes(',')) t = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(3, '0');
  const c = BigInt(m[1]!) * 100n + BigInt(frac.slice(0, 2)) + (frac[2]! >= '5' ? 1n : 0n);
  return c > 0n ? c : null;
}

export async function analyzeRooms(
  sql: Sql,
  siteId: string,
  bytes: Uint8Array,
  daily = 260,
): Promise<RoomImportAnalysis> {
  let rows: string[][];
  let kind: 'xlsx' | 'csv';
  try {
    ({ rows, kind } = readSheet(bytes));
  } catch (e) {
    if (e instanceof SheetError) throw new BusinessError(e.message);
    throw e;
  }
  // Kopfzeile: erste der ersten 15 Zeilen mit mindestens zwei bekannten Spalten (Fläche oder Raum dabei)
  let headerIdx = -1;
  let map = new Map<number, RoomField>();
  for (let i = 0; i < Math.min(rows.length, 15) && headerIdx < 0; i++) {
    const m = new Map<number, RoomField>();
    rows[i]!.forEach((h, idx) => {
      const n = norm(h);
      if (!n) return;
      for (const [f, d] of Object.entries(ROOM_FIELDS) as [RoomField, (typeof ROOM_FIELDS)[RoomField]][]) {
        if (d.aliases.includes(n) && ![...m.values()].includes(f)) {
          m.set(idx, f);
          break;
        }
      }
    });
    const fields = new Set(m.values());
    if (m.size >= 2 && (fields.has('area') || fields.has('name'))) {
      headerIdx = i;
      map = m;
    }
  }
  if (headerIdx < 0)
    throw new BusinessError(
      'Keine Kopfzeile gefunden. Erwartet z. B. die Spalten „Etage“, „Raum-Nr.“, „Raum“, „Raumart“, „Bodenbelag“, „Fläche“, „Intervall“.',
    );
  const fields = new Set(map.values());
  if (!fields.has('area')) throw new BusinessError('Spalte „Fläche“ (m²) fehlt');
  if (!fields.has('name') && !fields.has('room_no'))
    throw new BusinessError('Spalte „Raum“ oder „Raum-Nr.“ fehlt');
  const header = rows[headerIdx]!;

  const [types, existing] = await Promise.all([
    sql<{ id: string; name: string }[]>`select id, name from app.room_types`,
    sql<{ id: string; floor: string | null; room_no: string | null; name: string }[]>`
      select id, floor, room_no, name from app.rooms where site_id = ${siteId}`,
  ]);
  const typeByNorm = new Map(types.map((t) => [norm(t.name), t]));
  const keyOf = (floor: string | null, no: string | null, name: string) =>
    no ? `${norm(floor ?? '')}|nr|${norm(no)}` : `${norm(floor ?? '')}|name|${norm(name)}`;
  const existingByKey = new Map(existing.map((r) => [keyOf(r.floor, r.room_no, r.name), r.id]));
  const seen = new Set<string>();
  const newTypes = new Set<string>();

  const out: RoomImportRow[] = [];
  rows.slice(headerIdx + 1).forEach((cells, i) => {
    const get = (f: RoomField) => {
      for (const [idx, ff] of map) if (ff === f) return (cells[idx] ?? '').trim();
      return '';
    };
    const floor = get('floor') || null;
    const roomNo = get('room_no') || null;
    const typeRaw = get('type');
    const name = get('name') || [typeRaw, roomNo].filter(Boolean).join(' ') || '';
    const areaRaw = get('area');
    // Summenzeilen („Summe“, „Gesamt“) überspringen
    if (/^(summe|gesamt|total)/i.test(name) || /^(summe|gesamt|total)/i.test(floor ?? '')) return;
    if (!name && !areaRaw) return;
    const errors: string[] = [];
    if (!name) errors.push('Raum fehlt');
    const areaCenti = areaOf(areaRaw, kind);
    if (areaCenti == null) errors.push(areaRaw ? `Fläche „${areaRaw}“ ungültig` : 'Fläche fehlt');
    const intervalText = get('interval');
    let visits = parseInterval(intervalText, daily);
    const intervalDefaulted = !intervalText;
    if (!intervalText) visits = daily;
    else if (visits == null || visits < 1 || visits > 1000) {
      errors.push(`Intervall „${intervalText}“ nicht erkannt`);
      visits = null;
    }
    const typeName = typeRaw || 'Sonstiges';
    const t = typeByNorm.get(norm(typeName));
    if (!t) newTypes.add(typeName);
    const key = keyOf(floor, roomNo, name);
    if (seen.has(key)) errors.push('doppelt in der Datei (gleiche Etage und Raum-Nr./Bezeichnung)');
    seen.add(key);
    out.push({
      line: headerIdx + 2 + i,
      floor,
      roomNo,
      name,
      typeName,
      typeId: t?.id ?? null,
      covering: get('covering') || null,
      areaCenti,
      visits,
      intervalText: visits ? (intervalDefaulted ? '' : intervalText) : intervalText,
      intervalDefaulted,
      notes: get('notes') || null,
      existingId: existingByKey.get(key) ?? null,
      errors,
    });
  });
  if (!out.length) throw new BusinessError('Unter der Kopfzeile stehen keine Räume');
  return {
    headerLine: headerIdx + 1,
    columns: [...map].map(([idx, field]) => ({ field, header: header[idx] ?? '' })),
    ignored: header.filter((h, idx) => h && !map.has(idx)),
    rows: out,
    newTypes: [...newTypes],
  };
}

/**
 * Fehlerfreie Zeilen übernehmen. Feste IDs (Objekt + Datei + Zeile) → doppeltes Absenden legt nichts doppelt an.
 * Unbekannte Raumarten werden angelegt.
 */
export async function applyRooms(
  sql: Sql,
  siteId: string,
  fileSha: string,
  a: RoomImportAnalysis,
  opts: { update: boolean },
  actor: string,
) {
  let created = 0,
    updated = 0,
    skipped = 0;
  await sql.begin(async (tx) => {
    const typeIds = new Map<string, string>();
    for (const name of a.newTypes) {
      const id = uuidOf(`room_type:${norm(name)}`);
      await tx`
        insert into app.room_types (id, name, performance_m2_per_h, sort_order)
        values (${id}, ${name}, 200, (select coalesce(max(sort_order), 0) + 10 from app.room_types))
        on conflict do nothing`;
      const [t] = await tx<
        { id: string }[]
      >`select id from app.room_types where lower(name) = lower(${name})`;
      typeIds.set(name, t!.id);
    }
    let order = 0;
    for (const r of a.rows) {
      order += 10;
      if (r.errors.length) {
        skipped++;
        continue;
      }
      const row = {
        site_id: siteId,
        floor: r.floor,
        room_no: r.roomNo,
        name: r.name,
        room_type_id: r.typeId ?? typeIds.get(r.typeName)!,
        floor_covering: r.covering,
        area_centi: r.areaCenti!,
        visits_per_year: r.visits!,
        notes: r.notes,
        sort_order: order,
      };
      if (r.existingId) {
        if (!opts.update) {
          skipped++;
          continue;
        }
        await tx`update app.rooms set ${tx(row as Record<string, unknown>)} where id = ${r.existingId}`;
        updated++;
      } else {
        const id = uuidOf(`room:${siteId}:${fileSha}:${r.line}`);
        const res = await tx`
          insert into app.rooms ${tx({ id, active: true, ...row } as Record<string, unknown>)}
          on conflict (id) do nothing`;
        if (res.count) created++;
        else skipped++;
      }
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'room_import', 'site', ${siteId},
                     ${tx.json({ file: fileSha, created, updated, skipped, new_types: a.newTypes })})`;
  });
  return { created, updated, skipped };
}
