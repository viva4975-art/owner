/**
 * Objektordner je Objekt (Runde 23, Ahmed: „zu jedem Objekt einen Objektordner mit vorausgefüllten Daten … sollten
 * Infos fehlen, soll er danach fragen“).
 *
 * Grundlage ist Ahmeds Vorlagenpaket (ZIP „Objektordner-Komplettpaket“, einmal unter Einstellungen hochgeladen, liegt
 * write-once im Archiv). Je Objekt wird es ausgefüllt: Lücken „Objektleitung: ____“ bzw. Tabellenzellen neben einer
 * bekannten Beschriftung bekommen die Objektdaten. Dazu erzeugt die App PDFs aus ihren Daten: Objektstammblatt,
 * Leistungsverzeichnis (ohne Preise), Reinigungsplan aus dem Raumbuch und Revierplan aus dem Einsatzplan.
 * Was fehlt, steht als Frage auf der Seite (sites.folder_info bzw. Link zur passenden Stelle).
 */
import { createHash } from 'node:crypto';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Sql } from '../db/client.js';
import { CYCLE_LABEL, formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import type { BillingCycle } from '../domain/invoice/calc.js';
import { UNIT_LABELS } from '../domain/invoice/types.js';
import { renderTablePdf } from '../pdf/table.js';
import { BusinessError } from './errors.js';
import { freezeDateFields } from './word-templates.js';
import type { Deps } from './workflow.js';

export interface FolderInfo {
  bereichsleitung?: string;
  bereichsleitung_tel?: string;
  ersthelfer?: string;
  ansprechpartner?: string;
  ansprechpartner_tel?: string;
  putzraum?: string;
  zugang?: string;
  produkte?: string;
  besonderheiten?: string;
}

/** Angaben, die nur für den Objektordner gebraucht werden (alles andere kommt aus den Stammdaten). */
export const FOLDER_QUESTIONS: { key: keyof FolderInfo; label: string; hint: string; required: boolean }[] = [
  { key: 'bereichsleitung', label: 'Bereichsleitung', hint: 'Name der Bereichsleitung', required: true },
  { key: 'bereichsleitung_tel', label: 'Telefon Bereichsleitung', hint: 'z. B. 0176 …', required: true },
  { key: 'ersthelfer', label: 'Ersthelfer im Objekt', hint: 'Name (Notruf-Aushang)', required: true },
  {
    key: 'ansprechpartner',
    label: 'Ansprechpartner beim Kunden',
    hint: 'z. B. Hausmeister Maier',
    required: true,
  },
  { key: 'ansprechpartner_tel', label: 'Telefon Ansprechpartner', hint: '', required: true },
  { key: 'putzraum', label: 'Lage Putzraum', hint: 'z. B. UG, Raum 0.12', required: false },
  {
    key: 'zugang',
    label: 'Zugang / Schließung',
    hint: 'z. B. Schlüssel S-…, Alarmanlage Code beim Hausmeister',
    required: false,
  },
  {
    key: 'produkte',
    label: 'Eingesetzte Reinigungsmittel',
    hint: 'für Farbsystem/Dosierung und Hautschutzplan',
    required: false,
  },
  { key: 'besonderheiten', label: 'Besonderheiten', hint: 'z. B. Kita – nur nach 17 Uhr', required: false },
];

export interface FolderFacts {
  site: {
    id: string;
    site_no: string;
    name: string;
    street: string | null;
    postal_code: string | null;
    city: string | null;
  };
  customer: { name: string; customer_no: string };
  manager: { name: string; phone: string | null; email: string | null } | null;
  info: FolderInfo;
  contact: { name: string; phone: string | null } | null;
  rooms: number;
  services: number;
  plans: number;
  keys: number;
  /** Frühester Beginn der aktiven Leistungen (Leistungsbeginn). */
  start: string | null;
  missing: { label: string; href: string | null; key?: keyof FolderInfo }[];
}

export async function folderFacts(sql: Sql, siteId: string): Promise<FolderFacts> {
  const [s] = await sql<
    (FolderFacts['site'] & {
      customer_id: string;
      customer_name: string;
      customer_no: string;
      manager_user_id: string | null;
      folder_info: FolderInfo;
    })[]
  >`select s.id, s.site_no, s.name, s.street, s.postal_code, s.city, s.customer_id, s.manager_user_id, s.folder_info,
           c.name as customer_name, c.customer_no
      from app.sites s join app.customers c on c.id = s.customer_id where s.id = ${siteId}`;
  if (!s) throw new BusinessError('Objekt nicht gefunden');
  const [mgr] = s.manager_user_id
    ? await sql<{ name: string; phone: string | null; email: string | null }[]>`
        select name, phone, email from app.manager_contacts where user_id = ${s.manager_user_id}`
    : [];
  const [contact] = await sql<{ name: string; phone: string | null }[]>`
    select trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) as name, coalesce(mobile, phone) as phone
      from app.contacts where customer_id = ${s.customer_id} order by created_at limit 1`.catch(() => []);
  const [n] = await sql<
    { rooms: number; services: number; plans: number; keys: number; start: string | null }[]
  >`
    select (select to_char(min(valid_from), 'YYYY-MM-DD') from app.site_services
              where site_id = ${siteId} and active) as start,
           (select count(*) from app.rooms where site_id = ${siteId} and active)::int as rooms,
           (select count(*) from app.site_services where site_id = ${siteId} and active)::int as services,
           (select count(*) from app.shift_plans where site_id = ${siteId}
              and (valid_until is null or valid_until >= current_date))::int as plans,
           (select count(*) from app.keys where site_id = ${siteId})::int as keys`;
  const info = s.folder_info ?? {};
  const missing: FolderFacts['missing'] = [];
  if (!s.street || !s.city) missing.push({ label: 'Objektadresse', href: `/objekte/${siteId}/bearbeiten` });
  if (!mgr) missing.push({ label: 'Objektleitung zuordnen', href: `/objekte/${siteId}/bearbeiten` });
  else if (!mgr.phone) missing.push({ label: 'Telefon der Objektleitung', href: '/benutzer' });
  if (!n!.rooms)
    missing.push({ label: 'Raumbuch (für den Reinigungsplan)', href: `/objekte/${siteId}/raumbuch` });
  if (!n!.plans)
    missing.push({ label: 'Einsätze (für den Revierplan)', href: `/objekte/${siteId}/einsaetze` });
  if (!n!.services) missing.push({ label: 'Leistungen (für das LV)', href: `/objekte/${siteId}/leistungen` });
  for (const q of FOLDER_QUESTIONS) {
    if (!q.required || info[q.key]?.trim()) continue;
    if ((q.key === 'ansprechpartner' || q.key === 'ansprechpartner_tel') && contact?.name) {
      if (q.key === 'ansprechpartner' || contact.phone) continue;
    }
    missing.push({ label: q.label, href: null, key: q.key });
  }
  return {
    site: {
      id: s.id,
      site_no: s.site_no,
      name: s.name,
      street: s.street,
      postal_code: s.postal_code,
      city: s.city,
    },
    customer: { name: s.customer_name, customer_no: s.customer_no },
    manager: mgr ?? null,
    info,
    contact: contact?.name ? contact : null,
    rooms: n!.rooms,
    services: n!.services,
    plans: n!.plans,
    keys: n!.keys,
    start: n!.start,
    missing,
  };
}

export async function saveFolderInfo(sql: Sql, siteId: string, info: FolderInfo, actor: string) {
  const clean: FolderInfo = {};
  for (const q of FOLDER_QUESTIONS) {
    const v = info[q.key]?.trim();
    if (v) clean[q.key] = v.slice(0, 500);
  }
  await sql`update app.sites set folder_info = ${sql.json(clean as never)} where id = ${siteId}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, 'folder_info', 'site', ${siteId})`;
}

// ------------------------------------------------------------------ Word-Lücken füllen

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
const plain = (xml: string) => unesc(xml.replace(/<[^>]+>/g, '')).trim();
const normLabel = (t: string) =>
  t
    .toLowerCase()
    .replace(/[:*]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Werte je kanonischem Schlüssel. „<key>|tel“ = Telefon zur Person; in einer Tabellenzelle ohne eigene „Tel.“-Lücke
 * werden Name und Telefon zusammen eingesetzt.
 */
export function folderValues(f: FolderFacts): Record<string, string> {
  const addr = [f.site.street, [f.site.postal_code, f.site.city].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  const today = formatDateDe(todayBerlin());
  const v: Record<string, string> = {
    objekt: `${f.site.name} (${f.site.site_no})`,
    'objekt / objekt-nr.': `${f.site.name} / ${f.site.site_no}`,
    'objekt / adresse': addr ? `${f.site.name}, ${addr}` : f.site.name,
    'objekt-nr.': f.site.site_no,
    objektname: f.site.name,
    adresse: addr,
    kunde: `${f.customer.name} (${f.customer.customer_no})`,
    auftraggeber: f.customer.name,
    'angelegt am': today,
    erstellt: f.manager ? `${today} / ${f.manager.name}` : today,
  };
  if (f.start) v.leistungsbeginn = formatDateDe(f.start);
  if (f.manager) {
    v.objektleitung = f.manager.name;
    if (f.manager.phone) v['objektleitung|tel'] = f.manager.phone;
  }
  const i = f.info;
  if (i.bereichsleitung) v.bereichsleitung = i.bereichsleitung;
  if (i.bereichsleitung_tel) v['bereichsleitung|tel'] = i.bereichsleitung_tel;
  if (i.ersthelfer) v.ersthelfer = i.ersthelfer;
  const ap = i.ansprechpartner || f.contact?.name;
  const apTel = i.ansprechpartner_tel || f.contact?.phone;
  if (ap) v.ansprechpartner = ap;
  if (apTel) v['ansprechpartner|tel'] = apTel;
  if (i.putzraum) v.putzraum = i.putzraum;
  return v;
}

/** Beschriftung in den Vorlagen → kanonischer Schlüssel (Reihenfolge zählt). */
const LABEL_RULES: [RegExp, string][] = [
  [/^objekt\s*\/\s*objekt-?\s*(nr\.?|nummer)$/, 'objekt / objekt-nr.'],
  [/^objekt\s*\/\s*(adresse|anschrift)$/, 'objekt / adresse'],
  [/^(objekt\s*\/\s*liegenschaft|liegenschaft|objektname|objektbezeichnung)$/, 'objektname'],
  [/^objekt-?\s*(nr\.?|nummer)$/, 'objekt-nr.'],
  [/^objekt$/, 'objekt'],
  [/^((objekt)?adresse|anschrift)(\s+(des\s+)?objekts?)?$|^(anschrift|adresse) objekt$/, 'adresse'],
  [/^kunde$/, 'kunde'],
  [/^auftraggeber$/, 'auftraggeber'],
  [/^objektleitung(\s+viva-deluxe)?$|^objektleiter(in)?$/, 'objektleitung'],
  [/^bereichsleitung$|^bereichsleiter(in)?$/, 'bereichsleitung'],
  [/^ansprechpartner(in)?(\s+(beim\s+|des\s+)?kunden?)?$/, 'ansprechpartner'],
  [/^ersthelfer(in)?(\s+im\s+objekt)?$/, 'ersthelfer'],
  [/^angelegt am$|^erstellt am$/, 'angelegt am'],
  [/^erstellt am\s*\/\s*durch$/, 'erstellt'],
  [/^leistungsbeginn$|^beginn der reinigung$|^vertragsbeginn$/, 'leistungsbeginn'],
  [/^(lage\s+)?putzraum$/, 'putzraum'],
  [/^tel\.?$|^telefon$/, 'tel'],
];
export const canonLabel = (label: string) => {
  const k = normLabel(label);
  return LABEL_RULES.find(([re]) => re.test(k))?.[1] ?? '';
};

/** Wert zur Beschriftung; `withTel` = Telefon anhängen (keine eigene Tel.-Lücke daneben). */
const lookup = (values: Record<string, string>, key: string, prev: string, withTel: boolean) => {
  if (key === 'tel') return prev ? values[`${prev}|tel`] : undefined;
  const v = values[key];
  const tel = values[`${key}|tel`];
  if (!v) return undefined;
  return withTel && tel ? `${v}, ${tel}` : v;
};

/** Unterstrich-Läufe im XML-Abschnitt der Reihe nach mit den Werten füllen, übrige Läufe leeren. */
function replaceUnderscores(xml: string, ...vals: (string | undefined)[]): string {
  let n = 0;
  return xml.replace(
    /(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g,
    (m, open: string, text: string, close: string) => {
      if (!/_{3,}/.test(text)) return m;
      const t = text.replace(/_{3,}/g, (u) => {
        const val = vals[n++];
        return val === undefined ? (n > vals.length ? '' : u) : esc(val);
      });
      return `${open.includes('xml:space') ? open : open.replace('<w:t', '<w:t xml:space="preserve"')}${t}${close}`;
    },
  );
}

/** Leere Tabellenzelle mit Text füllen (Format des ersten Absatzes bleibt). */
function fillEmptyCell(cell: string, value: string): string {
  const i = cell.indexOf('</w:p>');
  if (i < 0) return cell;
  return `${cell.slice(0, i)}<w:r><w:t xml:space="preserve">${esc(value)}</w:t></w:r>${cell.slice(i)}`;
}

export function fillFolderXml(xml: string, values: Record<string, string>): { xml: string; filled: number } {
  let filled = 0;
  // 1) Tabellenzeilen: Beschriftung | Lücke (Unterstriche oder leer)
  let out = xml.replace(/<w:tr[ >][\s\S]*?<\/w:tr>/g, (row) => {
    const found = [...row.matchAll(/<w:tc>[\s\S]*?<\/w:tc>|<w:tc [\s\S]*?<\/w:tc>/g)];
    if (found.length < 2) return row;
    const cells = found.map((m) => m[0]);
    let prev = '';
    for (let i = 0; i + 1 < cells.length; i++) {
      const label = plain(cells[i]!);
      const next = plain(cells[i + 1]!);
      if (!label || label.length > 60 || /_{3,}/.test(label)) continue;
      const key = canonLabel(label);
      if (!key) continue;
      // „Name ____ Tel.: ____“ in einer Zelle → Name und Telefon getrennt
      const telGap = /^_{3,}\s*tel(\.|efon)?:?\s*_{3,}$/i.test(next);
      const val = lookup(values, key, prev, !telGap);
      if (key !== 'tel') prev = key;
      if (!val) continue;
      if (telGap) cells[i + 1] = replaceUnderscores(cells[i + 1]!, val, values[`${key}|tel`]);
      else if (/^_{3,}$/.test(next)) cells[i + 1] = replaceUnderscores(cells[i + 1]!, val);
      else if (next === '' && !/<w:drawing/.test(cells[i + 1]!))
        cells[i + 1] = fillEmptyCell(cells[i + 1]!, val);
      else continue;
      filled++;
    }
    // Zellen an ihrer Position ersetzen (gleich aussehende leere Zellen nicht verwechseln)
    let outRow = '';
    let pos = 0;
    found.forEach((m, i) => {
      outRow += row.slice(pos, m.index) + cells[i];
      pos = m.index! + m[0].length;
    });
    return outRow + row.slice(pos);
  });
  // 2) Absätze „Beschriftung: ____“ (Kontaktkarten: „Tel:“ in der nächsten Zeile gehört zur Person davor)
  let prev = '';
  out = out.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (p) => {
    const text = plain(p);
    const m = /^(.{2,40}?):\s*_{3,}\s*$/.exec(text);
    if (!m) {
      const k = /^(.{2,40}?):/.exec(text)?.[1];
      if (k) {
        const c = canonLabel(k);
        if (c !== 'tel') prev = c;
      }
      return p;
    }
    const key = canonLabel(m[1]!);
    const val = key ? lookup(values, key, prev, false) : undefined;
    if (key !== 'tel') prev = key;
    if (!val) return p;
    filled++;
    return replaceUnderscores(p, val);
  });
  return { xml: out, filled };
}

// ------------------------------------------------------------------ Vorlagenpaket

export async function savePackage(deps: Deps, bytes: Uint8Array, fileName: string, actor: string) {
  if (bytes.length > 100 * 1024 * 1024) throw new BusinessError('Datei zu groß (höchstens 100 MB)');
  let names: string[];
  try {
    names = Object.keys(unzipSync(bytes));
  } catch {
    throw new BusinessError('Keine ZIP-Datei');
  }
  if (!names.some((n) => /\.docx$/i.test(n))) throw new BusinessError('ZIP enthält keine Word-Dateien');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const path = `objektordner/${sha}.zip`;
  try {
    await deps.archive.put(path, bytes);
  } catch {
    /* gleiche Datei schon im Archiv (write-once) */
  }
  await deps.sql`
    insert into app.site_folder_package (id, storage_path, sha256, file_name, uploaded_by)
    values (1, ${path}, ${sha}, ${fileName.slice(0, 200)}, ${actor})
    on conflict (id) do update set storage_path = excluded.storage_path, sha256 = excluded.sha256,
      file_name = excluded.file_name, uploaded_by = excluded.uploaded_by, uploaded_at = now()`;
  return names.filter((n) => !/(^|\/)(__MACOSX|\._|\.DS_Store)/.test(n) && !n.endsWith('/')).length;
}

export async function packageInfo(sql: Sql) {
  const [p] = await sql<
    { file_name: string; uploaded_at: Date; uploaded_by: string; storage_path: string }[]
  >`
    select file_name, uploaded_at, uploaded_by, storage_path from app.site_folder_package where id = 1`;
  return p ?? null;
}

const DATE_GAP = '______________';

const safe = (s: string) =>
  s
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

/** Objektordner als ZIP: Vorlagen ausgefüllt + PDFs aus der App. */
export async function buildFolderZip(deps: Deps, siteId: string) {
  const { sql } = deps;
  const f = await folderFacts(sql, siteId);
  const values = folderValues(f);
  const out: Record<string, Uint8Array> = {};
  const pkg = await packageInfo(sql);
  let root = '';
  if (pkg) {
    const files = unzipSync(await deps.archive.get(pkg.storage_path));
    const names = Object.keys(files).filter(
      (n) => !/(^|\/)(__MACOSX|\._|\.DS_Store)/.test(n) && !n.endsWith('/'),
    );
    // gemeinsamen Oberordner („22_Objektordner-Komplettpaket/“) weglassen
    const first = names[0]?.split('/')[0] ?? '';
    if (first && names.every((n) => n.startsWith(`${first}/`))) root = `${first}/`;
    for (const n of names) {
      const rel = n.slice(root.length);
      let data = files[n]!;
      if (/\.docx$/i.test(n)) {
        try {
          const doc = unzipSync(data);
          for (const part of Object.keys(doc)) {
            if (!/^word\/(document|header\d*|footer\d*)\.xml$/.test(part)) continue;
            // Datumsfelder (DATE) zeigen sonst beim Öffnen immer „heute“ → Linie zum Ausfüllen
            doc[part] = strToU8(freezeDateFields(fillFolderXml(strFromU8(doc[part]!), values).xml, DATE_GAP));
          }
          data = zipSync(doc, { level: 6 });
        } catch {
          /* defekte Datei unverändert übernehmen */
        }
      }
      out[rel] = data;
    }
  }
  const tag = `${f.site.site_no} ${f.site.name}`;
  // Objektstammblatt
  const kv: [string, string][] = [
    ['Objekt', `${f.site.name} (${f.site.site_no})`],
    ['Adresse', values.adresse ?? ''],
    ['Kunde', values.kunde ?? ''],
    [
      'Objektleitung',
      f.manager ? `${f.manager.name}${f.manager.phone ? `, ${f.manager.phone}` : ''}` : '– fehlt –',
    ],
    [
      'Bereichsleitung',
      [f.info.bereichsleitung, f.info.bereichsleitung_tel].filter(Boolean).join(', ') || '– fehlt –',
    ],
    [
      'Ansprechpartner Kunde',
      [values.ansprechpartner, values['ansprechpartner|tel']].filter(Boolean).join(', ') || '– fehlt –',
    ],
    ['Ersthelfer im Objekt', f.info.ersthelfer ?? '– fehlt –'],
    ['Lage Putzraum', f.info.putzraum ?? ''],
    ['Zugang / Schließung', f.info.zugang ?? ''],
    ['Reinigungsmittel', f.info.produkte ?? ''],
    ['Besonderheiten', f.info.besonderheiten ?? ''],
    ['Schlüssel im Schlüsselbuch', String(f.keys)],
    ['Notruf / Polizei / Giftnotruf', '112 / 110 / 089 19240'],
  ];
  out['03_Objektunterlagen/Objektstammblatt.pdf'] = await renderTablePdf({
    title: `Objektstammblatt ${f.site.name}`,
    subtitle: `Objekt ${f.site.site_no} · Stand ${formatDateDe(todayBerlin())}`,
    columns: [
      { label: 'Angabe', width: 170 },
      { label: 'Wert', width: 330, wrap: true },
    ],
    rows: kv,
    fontSize: 9.5,
  });
  // Leistungsverzeichnis (ohne Preise – liegt im Objekt)
  const svc = await sql<
    {
      description: string;
      note: string | null;
      billing_cycle: BillingCycle;
      quantity_milli: bigint;
      unit_code: string;
      execution_notes: string | null;
    }[]
  >`select description, note, billing_cycle, quantity_milli, unit_code, execution_notes from app.site_services
     where site_id = ${siteId} and active order by sort_order, description`;
  out['04_LV-und-Revierplan/Leistungsverzeichnis.pdf'] = await renderTablePdf({
    title: `Leistungsverzeichnis ${f.site.name}`,
    subtitle: `Objekt ${f.site.site_no} · ohne Preise (Vertragsgrundlage liegt im Büro)`,
    columns: [
      { label: 'Leistung', width: 230, wrap: true },
      { label: 'Turnus', width: 90 },
      { label: 'Menge', width: 70, align: 'right' },
      { label: 'Hinweise', width: 160, wrap: true },
    ],
    rows: svc.length
      ? svc.map((x) => [
          [x.description, x.note].filter(Boolean).join(' – '),
          CYCLE_LABEL[x.billing_cycle] ?? x.billing_cycle,
          `${(Number(x.quantity_milli) / 1000).toLocaleString('de-DE')} ${UNIT_LABELS[x.unit_code] ?? x.unit_code}`,
          x.execution_notes ?? '',
        ])
      : [['Noch keine Leistungen am Objekt erfasst', '', '', '']],
    fontSize: 8.5,
  });
  // Reinigungsplan aus dem Raumbuch
  const rooms = await sql<
    {
      floor: string | null;
      room_no: string | null;
      name: string;
      type: string;
      floor_covering: string | null;
      area_centi: bigint;
      visits_per_year: number;
    }[]
  >`select r.floor, r.room_no, r.name, t.name as type, r.floor_covering, r.area_centi, r.visits_per_year
      from app.rooms r join app.room_types t on t.id = r.room_type_id
     where r.site_id = ${siteId} and r.active order by r.sort_order, r.floor, r.room_no, r.name`;
  const interval = (v: number) =>
    v >= 365
      ? 'täglich (Mo–So)'
      : v >= 312
        ? 'Mo–Sa'
        : v >= 260
          ? 'Mo–Fr'
          : v % 52 === 0
            ? `${v / 52}× wöchentl.`
            : v === 12
              ? 'monatlich'
              : `${v}× jährlich`;
  out['05_Reinigungsplaene/Reinigungsplan.pdf'] = await renderTablePdf({
    title: `Reinigungsplan ${f.site.name}`,
    subtitle: `Objekt ${f.site.site_no} · aus dem Raumbuch · Stand ${formatDateDe(todayBerlin())}`,
    landscape: true,
    columns: [
      { label: 'Etage', width: 70 },
      { label: 'Nr.', width: 60 },
      { label: 'Raum', width: 200, wrap: true },
      { label: 'Raumart', width: 130 },
      { label: 'Belag', width: 110 },
      { label: 'm²', width: 60, align: 'right' },
      { label: 'Intervall', width: 120 },
    ],
    rows: rooms.length
      ? rooms.map((r) => [
          r.floor ?? '',
          r.room_no ?? '',
          r.name,
          r.type,
          r.floor_covering ?? '',
          (Number(r.area_centi) / 100).toLocaleString('de-DE'),
          interval(r.visits_per_year),
        ])
      : [['', '', 'Raumbuch fehlt – bitte am Objekt erfassen', '', '', '', '']],
    fontSize: 8.5,
  });
  // Revierplan aus dem Einsatzplan
  const plans = await sql<
    { name: string | null; weekday: number; start: string; end: string; note: string | null }[]
  >`
    select e.last_name || ', ' || e.first_name as name, p.weekday, to_char(p.start_time, 'HH24:MI') as start,
           to_char(p.end_time, 'HH24:MI') as end, p.note
      from app.shift_plans p left join app.employees e on e.id = p.employee_id
     where p.site_id = ${siteId} and (p.valid_until is null or p.valid_until >= current_date)
     order by e.last_name nulls last, p.weekday, p.start_time`;
  const WD = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  out['04_LV-und-Revierplan/Revierplan.pdf'] = await renderTablePdf({
    title: `Revierplan ${f.site.name}`,
    subtitle: `Objekt ${f.site.site_no} · aus dem Einsatzplan · Reviere bitte im Grundriss einzeichnen`,
    columns: [
      { label: 'Mitarbeiter', width: 170 },
      { label: 'Tag', width: 50 },
      { label: 'Zeit', width: 90 },
      { label: 'Revier / Bereich', width: 230, wrap: true },
    ],
    rows: plans.length
      ? plans.map((p) => [p.name ?? '(offen)', WD[p.weekday] ?? '', `${p.start}–${p.end}`, p.note ?? ''])
      : [['Noch keine Einsätze geplant', '', '', '']],
    fontSize: 9,
  });
  const zip = zipSync(out, { level: 6 });
  return { zip, name: `Objektordner_${safe(tag)}.zip`, withPackage: !!pkg, facts: f };
}

// ------------------------------------------------------------------ Objektordner als ein PDF (Ahmed 09.10.)

const FOLDER_SECTIONS: [RegExp, string][] = [
  [/^01_/, 'Aushänge im Putzraum'],
  [/^02_/, 'Arbeitsanweisungen'],
  [/^03_/, 'Objektunterlagen und Formulare'],
  [/^05_/, 'Reinigungspläne'],
  [/^06_/, 'Nachweise im Objekt'],
];

/** „OBJEKTBEGEHUNGSPROTOKOLL“ → „Objektbegehungsprotokoll“ fürs Inhaltsverzeichnis. */
const niceTitle = (t: string) =>
  t === t.toUpperCase() && /[A-ZÄÖÜ]{4}/.test(t)
    ? t
        .toLowerCase()
        .replace(/(^|[\s(–-]\s*)(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase())
        .replace(/\b(Zur|Und|Im|Der|Die|Das|Für|Von|Mit)\b/g, (w) => w.toLowerCase())
    : t;

const titleFromFile = (n: string) =>
  (n.split('/').pop() ?? n)
    .replace(/\.(docx|pdf)$/i, '')
    .replace(/^VD-[A-Z]+-[\dA-Z-]*?V?\d*_/, '')
    .replace(/^[A-C]_/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\bue\b/g, 'ü')
    .trim();

/**
 * Objektordner als ein druckfertiges PDF: Deckblatt, Inhaltsverzeichnis, Objektstammblatt mit Kontakten, Leistungs-
 * verzeichnis (ohne Preise), Reinigungsplan, Revierplan, danach Ahmeds Vorlagen (Word-Dateien mit eingesetzten
 * Objektdaten, fertige PDF-Aushänge) und leere Nachweislisten zum Ausfüllen vor Ort.
 */
export async function buildFolderPdf(deps: Deps, siteId: string) {
  const { sql } = deps;
  const { FormDoc, FORM_Y } = await import('../pdf/form-doc.js');
  const { parseDocx, docxTitle, renderDocx } = await import('../pdf/docx-render.js');
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const f = await folderFacts(sql, siteId);
  const values = folderValues(f);
  const today = todayBerlin();
  const tag = `${f.site.site_no} ${f.site.name}`;
  const d = await FormDoc.create({
    title: `Objektordner ${tag}`,
    sideRef: `Objektordner ${tag}`,
    date: today,
    author: 'Viva-Deluxe Gebäudereinigung GmbH',
  });
  const toc: { section?: string; title: string; page: number }[] = [];
  const chapter = (title: string, section?: string) => {
    d.newPage();
    if (section && !toc.some((t) => t.section === section))
      toc.push({ section, title: section, page: d.pdf.getPageCount() });
    toc.push({ title, page: d.pdf.getPageCount() });
  };
  const addr = values.adresse ?? '';
  const mgr = f.manager ? [f.manager.name, f.manager.phone].filter(Boolean).join(', ') : '– bitte zuordnen –';
  const bl = [f.info.bereichsleitung, f.info.bereichsleitung_tel].filter(Boolean).join(', ') || '–';
  const ap = [values.ansprechpartner, values['ansprechpartner|tel']].filter(Boolean).join(', ') || '–';

  // Deckblatt
  d.y = FORM_Y.TOP + 70;
  d.text('OBJEKTORDNER', 48.5, d.y, {
    size: 10,
    bold: true,
    color: (await import('@cantoo/pdf-lib')).rgb(0.49, 0.08, 0.21),
  });
  d.y += 30;
  for (const l of d.wrap(f.site.name, 498, 26, true)) {
    d.text(l, 48.5, d.y, { size: 26, bold: true });
    d.y += 32;
  }
  d.text(`Objekt ${f.site.site_no}${addr ? ` · ${addr}` : ''}`, 48.5, d.y, { size: 11 });
  d.y += 18;
  d.text(`Kunde: ${f.customer.name} (${f.customer.customer_no})`, 48.5, d.y, { size: 11 });
  d.y += 34;
  d.kvBox([
    { k: 'Objektleitung', v: mgr, strong: true },
    { k: 'Bereichsleitung', v: bl },
    { k: 'Ansprechpartner Kunde', v: ap },
    { k: 'Ersthelfer im Objekt', v: f.info.ersthelfer ?? '–' },
    { k: 'Lage Putzraum', v: f.info.putzraum ?? '–' },
    { k: 'Notruf', v: '112 · Polizei 110 · Giftnotruf 089 19240', accent: true },
  ]);
  d.muted(
    `Stand ${formatDateDe(today)} – Dieser Ordner bleibt im Objekt (Putzraum). Aktuelle Fassung jederzeit in der App unter Objekt → Objektordner.`,
  );
  // Inhaltsverzeichnis (wird am Ende gefüllt)
  d.newPage();
  const tocPage = d.pdf.getPageCount() - 1;

  // 1. Objektstammblatt
  chapter('Objektstammblatt und Kontakte');
  d.title('Objektstammblatt', f.site.site_no);
  d.kvBox([
    { k: 'Objekt', v: `${f.site.name} (${f.site.site_no})`, strong: true },
    { k: 'Adresse', v: addr || '–' },
    { k: 'Kunde', v: `${f.customer.name} (${f.customer.customer_no})` },
    { k: 'Objektleitung', v: mgr },
    { k: 'Bereichsleitung', v: bl },
    { k: 'Ansprechpartner Kunde', v: ap },
    { k: 'Ersthelfer im Objekt', v: f.info.ersthelfer ?? '–' },
    { k: 'Lage Putzraum', v: f.info.putzraum ?? '–' },
    { k: 'Zugang / Schließung', v: f.info.zugang ?? '–' },
    { k: 'Reinigungsmittel', v: f.info.produkte ?? '–' },
    { k: 'Schlüssel', v: String(f.keys) },
  ]);
  if (f.info.besonderheiten) d.noteBox('Besonderheiten', [f.info.besonderheiten]);
  d.section('Notrufnummern');
  d.tiles([
    { label: 'NOTRUF / FEUERWEHR', value: '112', accent: true },
    { label: 'POLIZEI', value: '110' },
    { label: 'GIFTNOTRUF MÜNCHEN', value: '089 19240' },
    { label: 'BÜRO VIVA-DELUXE', value: '089 63855496' },
  ]);

  // 2. Leistungsverzeichnis
  const svc = await sql<
    {
      description: string;
      note: string | null;
      billing_cycle: BillingCycle;
      quantity_milli: bigint;
      unit_code: string;
      execution_notes: string | null;
    }[]
  >`select description, note, billing_cycle, quantity_milli, unit_code, execution_notes from app.site_services
     where site_id = ${siteId} and active order by sort_order, description`;
  chapter('Leistungsverzeichnis');
  d.title('Leistungsverzeichnis', f.site.site_no);
  d.muted('Ohne Preise – Vertragsgrundlage liegt im Büro.');
  d.table(
    [
      { label: 'Leistung', width: 210 },
      { label: 'Turnus', width: 80 },
      { label: 'Menge', width: 60, align: 'right' },
      { label: 'Ausführungshinweise', width: 148 },
    ],
    svc.length
      ? svc.map((x) => [
          [x.description, x.note].filter(Boolean).join('\n'),
          CYCLE_LABEL[x.billing_cycle] ?? x.billing_cycle,
          `${(Number(x.quantity_milli) / 1000).toLocaleString('de-DE')} ${UNIT_LABELS[x.unit_code] ?? ''}`.trim(),
          x.execution_notes ?? '',
        ])
      : [['Noch keine Leistungen am Objekt erfasst', '', '', '']],
  );

  // 3. Reinigungsplan
  const rooms = await sql<
    {
      floor: string | null;
      room_no: string | null;
      name: string;
      type: string;
      floor_covering: string | null;
      area_centi: bigint;
      visits_per_year: number;
    }[]
  >`select r.floor, r.room_no, r.name, t.name as type, r.floor_covering, r.area_centi, r.visits_per_year
      from app.rooms r join app.room_types t on t.id = r.room_type_id
     where r.site_id = ${siteId} and r.active order by r.sort_order, r.floor, r.room_no, r.name`;
  const interval = (v: number) =>
    v >= 365
      ? 'täglich'
      : v >= 312
        ? 'Mo–Sa'
        : v >= 260
          ? 'Mo–Fr'
          : v % 52 === 0
            ? `${v / 52}× wö.`
            : v === 12
              ? 'monatl.'
              : `${v}× jährl.`;
  chapter('Reinigungsplan (Raumbuch)');
  d.title('Reinigungsplan', f.site.site_no);
  d.table(
    [
      { label: 'Etage', width: 48 },
      { label: 'Nr.', width: 44 },
      { label: 'Raum', width: 140 },
      { label: 'Raumart', width: 90 },
      { label: 'Belag', width: 74 },
      { label: 'm²', width: 46, align: 'right' },
      { label: 'Intervall', width: 56 },
    ],
    rooms.length
      ? rooms.map((r) => [
          r.floor ?? '',
          r.room_no ?? '',
          r.name,
          r.type,
          r.floor_covering ?? '',
          (Number(r.area_centi) / 100).toLocaleString('de-DE'),
          interval(r.visits_per_year),
        ])
      : [['', '', 'Raumbuch fehlt – bitte am Objekt erfassen', '', '', '', '']],
    { size: 8 },
  );

  // 4. Revierplan
  const plans = await sql<
    { name: string | null; weekday: number; start: string; end: string; note: string | null }[]
  >`
    select e.first_name || ' ' || e.last_name as name, p.weekday, to_char(p.start_time, 'HH24:MI') as start,
           to_char(p.end_time, 'HH24:MI') as end, p.note
      from app.shift_plans p left join app.employees e on e.id = p.employee_id
     where p.site_id = ${siteId} and (p.valid_until is null or p.valid_until >= current_date)
     order by e.last_name nulls last, p.weekday, p.start_time`;
  const WD = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  chapter('Revierplan (Einsätze)');
  d.title('Revierplan', f.site.site_no);
  d.muted('Aus dem Einsatzplan. Reviere bitte im Grundriss einzeichnen.');
  d.table(
    [
      { label: 'Mitarbeiter/in', width: 160 },
      { label: 'Tag', width: 40 },
      { label: 'Zeit', width: 80 },
      { label: 'Revier / Bereich', width: 218 },
    ],
    plans.length
      ? plans.map((p) => [p.name ?? '(offen)', WD[p.weekday] ?? '', `${p.start}–${p.end}`, p.note ?? ''])
      : [['Noch keine Einsätze geplant', '', '', '']],
  );

  // 5. Vorlagen aus dem Paket
  const pkg = await packageInfo(sql);
  if (pkg) {
    const files = unzipSync(await deps.archive.get(pkg.storage_path));
    const names = Object.keys(files)
      .filter((n) => !/(^|\/)(__MACOSX|\._|\.DS_Store)/.test(n) && !n.endsWith('/'))
      .sort((a, b) => a.localeCompare(b, 'de'));
    const first = names[0]?.split('/')[0] ?? '';
    const root = first && names.every((n) => n.startsWith(`${first}/`)) ? `${first}/` : '';
    const mw = /m(ü|ue)nchner\s*wohnen/i.test(f.customer.name);
    for (const n of names) {
      const rel = n.slice(root.length);
      const section = FOLDER_SECTIONS.find(([re]) => re.test(rel))?.[1];
      if (!section) continue;
      if (/inhaltsverzeichnis|revierplan_muster|muster revierplan/i.test(rel)) continue;
      // Word-Quellen der fertigen PDF-Aushänge (sonst doppelt)
      if (/(^|\/)C_Word-Quellen\//i.test(rel)) continue;
      if (/muenchner-wohnen|münchner-wohnen/i.test(rel) && !mw) continue;
      try {
        if (/\.docx$/i.test(rel)) {
          const doc = unzipSync(files[n]!);
          const xml = doc['word/document.xml'];
          if (!xml) continue;
          const blocks = parseDocx(freezeDateFields(fillFolderXml(strFromU8(xml), values).xml, DATE_GAP));
          chapter(niceTitle(docxTitle(blocks) ?? titleFromFile(rel)), section);
          d.muted(`Objekt ${f.site.site_no} · ${f.site.name}`);
          renderDocx(d, blocks);
        } else if (/\.pdf$/i.test(rel)) {
          const src = await PDFDocument.load(files[n]!, { ignoreEncryption: true });
          const pages = await d.pdf.copyPages(src, src.getPageIndices());
          if (!pages.length) continue;
          if (!toc.some((t) => t.section === section))
            toc.push({ section, title: section, page: d.pdf.getPageCount() + 1 });
          toc.push({
            title: /aushaenge|aushänge/i.test(rel)
              ? 'Ordnung im Putzraum und Betriebsanweisungen'
              : titleFromFile(rel),
            page: d.pdf.getPageCount() + 1,
          });
          for (const p of pages) d.pdf.addPage(p);
          // nächster Inhalt beginnt auf einer eigenen Seite
          d.page = d.pdf.getPage(d.pdf.getPageCount() - 1);
        }
      } catch {
        /* nicht lesbare Datei überspringen */
      }
    }
  }

  // 6. Leere Nachweislisten
  const blank = (cols: { label: string; width: number }[], n: number) =>
    d.table(
      cols,
      Array.from({ length: n }, () => cols.map(() => ' ')),
      { size: 11 },
    );
  chapter('Anwesenheitsliste', 'Nachweise im Objekt');
  d.title('Anwesenheitsliste', f.site.site_no);
  blank(
    [
      { label: 'Datum', width: 70 },
      { label: 'Name', width: 150 },
      { label: 'Beginn', width: 55 },
      { label: 'Ende', width: 55 },
      { label: 'Pause', width: 50 },
      { label: 'Unterschrift', width: 118 },
    ],
    24,
  );
  chapter('Stundennachweis Regiearbeiten', 'Nachweise im Objekt');
  d.title('Stundennachweis Regie', f.site.site_no);
  blank(
    [
      { label: 'Datum', width: 62 },
      { label: 'Name', width: 110 },
      { label: 'Tätigkeit', width: 140 },
      { label: 'von', width: 40 },
      { label: 'bis', width: 40 },
      { label: 'Std.', width: 36 },
      { label: 'Abnahme Kunde', width: 70 },
    ],
    22,
  );

  // Inhaltsverzeichnis füllen
  d.page = d.pdf.getPage(tocPage);
  d.y = FORM_Y.TOP;
  d.title('Inhaltsverzeichnis', f.site.site_no);
  let nr = 0;
  for (const t of toc) {
    if (t.section && t.title === t.section) {
      d.y += 6;
      d.text(t.section, 48.5, d.y + 9, { size: 9.5, bold: true });
      d.y += 15;
      continue;
    }
    nr++;
    const label = d.fit(`${nr}.  ${t.title}`, 430, 9);
    d.text(label, 60, d.y + 9, { size: 9 });
    d.right(String(t.page), 546.5, d.y + 9, { size: 9 });
    d.line(60 + d.width(label, 9) + 6, 546.5 - d.width(String(t.page), 9) - 6, d.y + 9, undefined, 0.3);
    d.y += 14;
    if (d.y > FORM_Y.BOTTOM - 10) break;
  }
  return { pdf: await d.save(), name: `Objektordner_${safe(tag)}.pdf`, facts: f, withPackage: !!pkg };
}
