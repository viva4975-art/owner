import { createHash } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { SheetError, readSheets } from '../domain/sheet/sheet.js';
import { isPdf, readPdfTable } from '../domain/sheet/pdf-table.js';
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

export type RoomField =
  | 'building'
  | 'floor'
  | 'room_no'
  | 'name'
  | 'type'
  | 'covering'
  | 'area'
  | 'interval'
  | 'days'
  | 'performance'
  | 'hours'
  | 'daycleaner'
  | 'notes';
export const ROOM_FIELDS: Record<RoomField, { label: string; aliases: string[] }> = {
  // Fortytools-Raumexport hat „Gebäudeteil“ und „Etage“ getrennt → zusammen als Etage („A · UG“)
  building: { label: 'Gebäudeteil', aliases: ['gebaeudeteil', 'bauteil', 'gebaeude', 'haus', 'trakt'] },
  floor: {
    label: 'Etage',
    aliases: ['etage', 'geschoss', 'ebene', 'stockwerk', 'og', 'etagegeschoss'],
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
      // Fortytools: „Größe in m²“
      'groesse',
      'groesseinm',
      'groesseinm2',
      'groesseinqm',
      'groessem2',
      'groesseqm',
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
      'rhythmus',
      'reinigungshaeufigkeit',
      'frequenz',
      'wieoft',
      'wiehaeufig',
    ],
  },
  // Ausschreibungs-Kalkulationen: Reinigungstage im Jahr gehen vor dem Turnus (W5 = 216 Schultage statt 260)
  days: {
    label: 'Reinigungstage/Jahr',
    aliases: [
      'reinigungstagejahr',
      'reinigungstage',
      'reinigungstageprojahr',
      'reinigungstageimjahr',
      'tageimjahr',
      'tageprojahr',
      'tagejahr',
      'reinigungenjahr',
      'reinigungenprojahr',
      'reinigungenimjahr',
      'anzahlreinigungen',
      'jahresreinigungen',
    ],
  },
  performance: {
    label: 'Leistung m²/h',
    aliases: [
      'qmleistungprostunde',
      'qmleistungstunde',
      'qmleistung',
      'leistungqmh',
      'leistungm2h',
      'leistungmh',
      'leistungswert',
      'leistungsmass',
      'flaechenleistung',
      'richtleistung',
      'qmh',
      'm2h',
      'mh',
      'qmstd',
    ],
  },
  hours: {
    label: 'Stunden/Jahr',
    aliases: [
      'stundenjahr',
      'jahresstunden',
      'stundenprojahr',
      'stdjahr',
      'stdprojahr',
      'reinigungsstundenjahr',
    ],
  },
  daycleaner: { label: 'Tageskraft', aliases: ['tageskraft', 'tageskraefte'] },
  notes: {
    label: 'Hinweise',
    aliases: ['hinweis', 'hinweise', 'bemerkung', 'bemerkungen', 'notiz', 'beschreibung'],
  },
};

/** Was „täglich“ in der Datei bedeutet: Mo–Fr 260, Mo–Sa 312, Mo–So 365 (beim Import wählbar). Ohne Angabe bleibt das Intervall leer. */
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
  // keine Reinigung (Turnus „0“, „keine Reinigung (macht HM)“)
  if (/^0+([.,]0+)?$/.test(t) || /^(keine|ohne|entf)/.test(t)) return 0;
  // Turnus-Kürzel aus Leistungsverzeichnissen: W1–W7 je Woche, M1–M4 je Monat, Q1 je Quartal, J1–J12 je Jahr
  const code = /^(w|m|q|j)\s?(\d{1,2})\b/.exec(t);
  if (code) {
    const k = Number(code[2]);
    if (code[1] === 'w' && k >= 1 && k <= 7) return k === 5 ? 260 : k * 52;
    if (code[1] === 'm' && k >= 1 && k <= 4) return k * 12;
    if (code[1] === 'q' && k >= 1 && k <= 3) return k * 4;
    if (code[1] === 'j' && k >= 1 && k <= 12) return k;
  }
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
  /** Raumart der Datei, wenn sie einer vorhandenen Nutzungsart zugeordnet wurde */
  typeRaw: string | null;
  covering: string | null;
  areaCenti: bigint | null;
  visits: number | null;
  intervalText: string;
  intervalDefaulted: boolean;
  /** Turnus-Kürzel/-Text aus der Datei (z. B. „W5“) */
  turnus: string | null;
  performance: number | null;
  /** Reinigungsstunden im Jahr (aus der Datei oder Fläche × Reinigungen ÷ Leistung) */
  hoursYear: number | null;
  notes: string | null;
  existingId: string | null;
  errors: string[];
}

export interface RoomImportAnalysis {
  /** verwendetes Tabellenblatt (Excel mit mehreren Blättern: das mit der besten Kopfzeile) */
  sheetName: string;
  sheetCount: number;
  headerLine: number;
  columns: { field: RoomField; header: string }[];
  ignored: string[];
  rows: RoomImportRow[];
  newTypes: string[];
  /** Summe Reinigungsstunden/Jahr der fehlerfreien Zeilen (null = nicht ermittelbar) */
  hoursYear: number | null;
  /** verschiedene Werte der Spalte „Gebäude“ (Reihenfolge der Datei) – mehrere = mehrere Objekte möglich */
  buildings: string[];
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

const numOf = (v: string, kind: 'xlsx' | 'csv') => {
  const t = v.replace(/\s/g, '');
  if (!t) return null;
  // „184.5“ / „38.33“ (Punkt mit 1–2 Nachkommastellen, kein Komma) = Dezimalzahl, nicht Tausenderpunkt
  const dotDecimal = !t.includes(',') && /^-?\d+\.\d{1,2}$/.test(t);
  const x = Number(
    !dotDecimal && (kind === 'csv' || t.includes(',')) ? t.replace(/\./g, '').replace(',', '.') : t,
  );
  return Number.isFinite(x) ? x : null;
};

/**
 * Raumart der Datei → vorhandene Nutzungsart über Stichwörter (Kalkulationen nennen Räume „Flur“, „WC“,
 * „Umkleideraum, Kabine 5“ …). Liefert den Namen der Standard-Nutzungsart oder null.
 */
const TYPE_WORDS: [string, RegExp][] = [
  ['Umkleide / Dusche', /umkleid|dusch|kabine|waschraum|garderob|gaderob/],
  ['Sanitär / WC', /\bwc|toilet|sanitaer|urinal|pissoir|behinderten.?wc|\bbad\b|beh\.?\s?w[cg]/],
  ['Teeküche / Küche', /kueche|teekueche|speise|mensa|essraum|spuel|kantine|cafeteria|pausenverkauf|kiosk/],
  ['Turnhalle', /turnhalle|sporthalle|gymnastik|hallenflaeche|spielfeld|kondition|fitness|kraftraum/],
  [
    'Klassenzimmer',
    /klass|unterricht|gruppen|fachraum|werk|musik|kunst|computer|lernwerk|hort|betreuung|biblio|medien|saal|mehrzweck|atelier|textil|lehrmittel|kita|krippe/,
  ],
  ['Besprechung', /besprech|konferenz|sitzung|seminar/],
  [
    'Büro',
    /buero|verwaltung|sekretariat|rektor|lehrer|leitung|arzt|sanitaetsraum|empfang|anmeldung|personal|beratung|sozial|management|trainer|schiedsrichter|platzwart|erste.?hilfe|aufenthalt/,
  ],
  ['Eingangsbereich', /eingang|foyer|windfang|aula|pausenhalle|vorraum|garderobe/],
  [
    'Flur / Treppenhaus',
    /flur|gang|treppe|durchgang|diele|aufzug|verkehr|podest|galerie|notausg|empore|tribu?e?h?ne|balkon|terras/,
  ],
  [
    'Lager / Technik',
    /lager|technik|nebenraum|abstell|archiv|putz|reinigung|keller|heiz|hausmeister|geraet|elektro|server|muell|schacht|lueftung|maschinen|anschluss|garage|platzpflege|regie|sprechanlage|kopier/,
  ],
];
export function guessRoomType(raw: string): string | null {
  const n = raw.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  return TYPE_WORDS.find(([, re]) => re.test(n))?.[0] ?? null;
}

/** Kopfzeile in den ersten 15 Zeilen eines Blatts suchen: bekannte Spalten, Fläche Pflicht. */
function findHeader(rows: string[][]) {
  let best: { idx: number; map: Map<number, RoomField> } | null = null;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
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
    const usable =
      m.size >= 2 &&
      fields.has('area') &&
      (fields.has('name') || fields.has('room_no') || fields.has('type'));
    if (usable && (!best || m.size > best.map.size)) best = { idx: i, map: m };
  }
  return best;
}

export async function analyzeRooms(
  sql: Sql,
  siteId: string,
  bytes: Uint8Array,
  daily = 260,
  opts: { building?: string } = {},
): Promise<RoomImportAnalysis> {
  let sheets: { name: string; rows: string[][] }[];
  let kind: 'xlsx' | 'csv';
  let fromPdf = false;
  try {
    if (isPdf(bytes)) {
      const rows = await readPdfTable(bytes);
      if (!rows.length)
        throw new BusinessError(
          'In der PDF ist kein Text zu finden (eingescannt?) – bitte das Raumbuch als Excel/CSV oder als PDF mit Text hochladen',
        );
      // Text aus PDF: deutsche Zahlen („12,76“) wie bei CSV
      sheets = [{ name: 'PDF', rows }];
      kind = 'csv';
      fromPdf = true;
    } else ({ sheets, kind } = readSheets(bytes));
  } catch (e) {
    if (e instanceof SheetError) throw new BusinessError(e.message);
    throw e;
  }
  // Excel mit vielen Blättern (z. B. Ausschreibungs-Kalkulation): das Blatt mit der besten Kopfzeile nehmen,
  // bei Gleichstand das mit den meisten Zeilen
  let pick: { sheet: (typeof sheets)[number]; idx: number; map: Map<number, RoomField> } | null = null;
  for (const sh of sheets) {
    const h = findHeader(sh.rows);
    if (!h) continue;
    if (
      !pick ||
      h.map.size > pick.map.size ||
      (h.map.size === pick.map.size && sh.rows.length > pick.sheet.rows.length)
    )
      pick = { sheet: sh, ...h };
  }
  if (!pick) {
    const anyName = sheets.some((sh) => findHeaderLoose(sh.rows));
    throw new BusinessError(
      anyName
        ? 'Spalte „Fläche“ (m²) fehlt'
        : 'Keine Kopfzeile gefunden. Erwartet z. B. die Spalten „Etage“, „Raum-Nr.“, „Raum“, „Raumart“, „Bodenbelag“, „Fläche“, „Turnus“ oder „Reinigungstage/Jahr“ – Vorlage unter Raumbuch → Importieren.',
    );
  }
  const rows = pick.sheet.rows;
  const headerIdx = pick.idx;
  const map = pick.map;
  const fields = new Set(map.values());
  const header = rows[headerIdx]!;
  // „Gebäudeteil/Bauteil/Trakt“ (Fortytools: A, B, C … derselben Schule) = Teil EINES Objekts → nur in die Etage;
  // nur „Gebäude/Haus/Liegenschaft“ können verschiedene Objekte sein (Kalkulation mit mehreren Schulen)
  const bldIdx = [...map].find(([, f]) => f === 'building')?.[0];
  const bldIsPart = bldIdx != null && /teil|trakt/.test(norm(header[bldIdx] ?? ''));

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
  // ohne eigene Spalte „Raum“ ist die Raumart der Raumname (Kalkulation: „Flur“, „Umkleideraum, Kabine 5“)
  const typeIsName = !fields.has('name') && fields.has('type');

  const out: RoomImportRow[] = [];
  const buildings: string[] = [];
  rows.slice(headerIdx + 1).forEach((cells, i) => {
    const get = (f: RoomField) => {
      for (const [idx, ff] of map) if (ff === f) return (cells[idx] ?? '').trim();
      return '';
    };
    const bld = get('building');
    if (bld && !bldIsPart && !/^(summe|gesamt|total)/i.test(bld) && !buildings.includes(bld))
      buildings.push(bld);
    // nur ein Gebäude (= ein Objekt): andere Zeilen auslassen, Gebäude nicht mehr in die Etage schreiben
    if (opts.building != null && !bldIsPart && bld !== opts.building) return;
    const floor =
      (opts.building != null && !bldIsPart
        ? get('floor')
        : [bld, get('floor')].filter(Boolean).join(' · ')) || null;
    const noRaw = get('room_no');
    // „keine NR“, „ohne“, „-“ = keine Raumnummer
    const roomNo = noRaw && !/^(keine|ohne|o\.?\s?nr|n\.?\s?a\.?|-+|\?)/i.test(noRaw) ? noRaw : null;
    const typeRaw = get('type');
    let name = get('name') || (typeIsName ? typeRaw : [typeRaw, roomNo].filter(Boolean).join(' ')) || '';
    const areaRaw = get('area');
    // Summenzeilen („Summe“, „Gesamt“) überspringen
    if (/^(summe|gesamt|total)/i.test(name) || /^(summe|gesamt|total)/i.test(floor ?? '')) return;
    if (!name && !areaRaw) return;
    // PDF (Revierplan, gedruckte Liste): Zeilen ohne Zahl in der Fläche sind Titel, Zwischenüberschriften, Fußzeilen
    if (fromPdf && !/^\s*\d[\d.,\s]*(m²|m2|qm)?\s*$/i.test(areaRaw)) return;
    const errors: string[] = [];
    if (!name) errors.push('Raum fehlt');
    const areaCenti = areaOf(areaRaw, kind);
    if (areaCenti == null)
      errors.push(
        /^0+([.,]0*)?$/.test(areaRaw.replace(/\s|m²|m2|qm/gi, ''))
          ? 'Fläche 0 m² – Raum wird nicht übernommen'
          : areaRaw
            ? `Fläche „${areaRaw}“ ungültig`
            : 'Fläche fehlt',
      );
    const intervalText = get('interval');
    const daysRaw = get('days');
    const days = numOf(daysRaw, kind);
    let visits: number | null;
    let intervalDefaulted = false;
    // Reinigungstage genau übernehmen, auch mit Nachkommastellen (184,5) – auf 2 Stellen
    if (daysRaw && days != null && days >= 0 && days <= 1000) visits = Math.round(days * 100) / 100;
    else if (daysRaw) {
      errors.push(`Reinigungstage „${daysRaw}“ ungültig`);
      visits = null;
    } else if (!intervalText) {
      // nicht angegeben → leer lassen, nichts annehmen (Ahmed: „die Tage müssen drin stehen“)
      visits = null;
      intervalDefaulted = true;
    } else {
      visits = parseInterval(intervalText, daily);
      if (visits == null || visits < 0 || visits > 1000) {
        errors.push(`Intervall „${intervalText}“ nicht erkannt`);
        visits = null;
      }
    }
    // Nutzungsart: gleicher Name → vorhandene; sonst Stichwort (WC → Sanitär / WC); sonst neu anlegen
    let typeName = typeRaw || 'Sonstiges';
    let t = typeByNorm.get(norm(typeName));
    // ohne Spalte „Raumart“ (z. B. Revierplan): Nutzungsart aus dem Raumnamen erraten
    const guessSrc = typeRaw || (!fields.has('type') ? name : '');
    if ((!t || !typeRaw) && guessSrc) {
      const g = guessRoomType(guessSrc);
      const gt = g ? typeByNorm.get(norm(g)) : undefined;
      if (gt) {
        t = gt;
        typeName = gt.name;
      }
    }
    // Kalkulation (Raumart = Raumname): Unbekanntes nicht als eigene Nutzungsart anlegen, sondern „Sonstiges“
    if (!t && typeIsName) {
      typeName = 'Sonstiges';
      t = typeByNorm.get(norm(typeName));
    }
    if (!t) newTypes.add(typeName);
    const perfRaw = numOf(get('performance'), kind);
    const performance = perfRaw && perfRaw >= 1 && perfRaw <= 5000 ? Math.round(perfRaw) : null;
    const hoursRaw = numOf(get('hours'), kind);
    const hoursYear =
      hoursRaw != null && hoursRaw >= 0
        ? hoursRaw
        : visits === 0
          ? 0
          : performance && areaCenti != null && visits != null
            ? ((Number(areaCenti) / 100) * visits) / performance
            : null;
    // gleicher Raum mehrfach (z. B. mehrere „WC“ im EG ohne Nummer, gleiche Nummer für zwei Flächen):
    // erst Nummer + Bezeichnung, dann durchzählen statt Fehler
    let key = keyOf(floor, roomNo, name);
    if (seen.has(key) && name) {
      const base = name;
      const keyFor = (n: string) =>
        roomNo ? `${keyOf(floor, roomNo, base)}|${norm(n)}` : keyOf(floor, null, n);
      key = keyFor(base);
      if (!roomNo || seen.has(key)) {
        let n = 2;
        while (seen.has(keyFor(`${base} (${n})`))) n++;
        name = `${base} (${n})`;
        key = keyFor(name);
      }
    }
    if (seen.has(key)) errors.push('doppelt in der Datei (gleiche Etage und Raum-Nr./Bezeichnung)');
    seen.add(key);
    const dc = get('daycleaner');
    const notes = [get('notes'), dc && !/^(nein|0|-)$/i.test(dc) ? `Tageskraft: ${dc}` : '']
      .filter(Boolean)
      .join(' · ');
    const turnus = (intervalText || '').slice(0, 40) || null;
    out.push({
      line: headerIdx + 2 + i,
      floor,
      roomNo,
      name,
      typeName,
      typeId: t?.id ?? null,
      typeRaw: typeRaw && norm(typeRaw) !== norm(typeName) ? typeRaw : null,
      covering: get('covering') || null,
      areaCenti,
      visits,
      intervalText: intervalDefaulted ? '' : visits != null ? intervalText || daysRaw : intervalText,
      intervalDefaulted,
      turnus,
      performance,
      hoursYear,
      notes: notes || null,
      existingId: existingByKey.get(key) ?? null,
      errors,
    });
  });
  if (!out.length && opts.building == null) throw new BusinessError('Unter der Kopfzeile stehen keine Räume');
  const ok = out.filter((r) => !r.errors.length);
  const withHours = ok.filter((r) => r.hoursYear != null);
  return {
    sheetName: pick.sheet.name,
    sheetCount: sheets.length,
    headerLine: headerIdx + 1,
    columns: [...map].map(([idx, field]) => ({ field, header: header[idx] ?? '' })),
    ignored: header.filter((h, idx) => h && !map.has(idx)),
    rows: out,
    newTypes: [...newTypes],
    buildings,
    hoursYear:
      withHours.length && withHours.length >= ok.length * 0.8
        ? withHours.reduce((a, r) => a + (r.hoursYear ?? 0), 0)
        : null,
  };
}

/** Blatt hat eine Raum-Kopfzeile, nur ohne Fläche (für eine genaue Fehlermeldung). */
function findHeaderLoose(rows: string[][]) {
  return rows.slice(0, 15).some((r) => {
    const n = new Set(r.map(norm));
    return (
      ROOM_FIELDS.name.aliases.some((a) => n.has(a)) || ROOM_FIELDS.room_no.aliases.some((a) => n.has(a))
    );
  });
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
        visits_per_year: r.visits,
        turnus: r.turnus,
        ...(r.performance ? { performance_override: r.performance } : {}),
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

/**
 * Mehrere Gebäude in einer Datei (Ausschreibung mit mehreren Liegenschaften): Vorschlag Gebäude → Objekt desselben
 * Kunden über gemeinsame Wörter im Namen (mind. 4 Buchstaben, Ortsteil zählt); ohne Treffer beim ersten Gebäude das
 * aktuelle Objekt, sonst „nicht übernehmen“.
 */
export async function suggestBuildingSites(sql: Sql, siteId: string, buildings: string[]) {
  const sites = await sql<
    { id: string; name: string; site_no: string; street: string | null; city: string | null }[]
  >`
    select s.id, s.name, s.site_no, s.street, s.city from app.sites s
     where s.customer_id = (select customer_id from app.sites where id = ${siteId}) and (s.active or s.id = ${siteId})
     order by s.name`;
  const words = (t: string) =>
    new Set(
      t
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4),
    );
  // Punkte je Gebäude × Objekt; vergeben nach höchster Punktzahl, jedes Objekt nur einmal (zwei „Grundschule …“
  // sollen nicht beide im selben Objekt landen)
  const pairs: { b: string; id: string; score: number }[] = [];
  for (const b of buildings) {
    const bw = words(b);
    for (const st of sites) {
      // Treffer im Objektnamen zählen mehr als Straße/Ort (mehrere Objekte liegen oft im selben Ort)
      const nw = words(st.name);
      const aw = words(`${st.street ?? ''} ${st.city ?? ''}`);
      const score = [...bw].reduce((a, w) => a + (nw.has(w) ? 10 : aw.has(w) ? 1 : 0), 0);
      if (score) pairs.push({ b, id: st.id, score });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  const suggestion = new Map<string, string>(buildings.map((b) => [b, '']));
  const used = new Set<string>();
  for (const p of pairs) {
    if (suggestion.get(p.b) || used.has(p.id)) continue;
    // gleich gute Alternative für dasselbe Gebäude → keine Vorauswahl
    if (pairs.some((q) => q.b === p.b && q.id !== p.id && q.score === p.score && !used.has(q.id))) continue;
    suggestion.set(p.b, p.id);
    used.add(p.id);
  }
  if (buildings.length && ![...suggestion.values()].some(Boolean)) suggestion.set(buildings[0]!, siteId);
  return { sites, suggestion };
}
