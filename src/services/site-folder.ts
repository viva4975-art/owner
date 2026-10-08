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
  const [n] = await sql<{ rooms: number; services: number; plans: number; keys: number }[]>`
    select (select count(*) from app.rooms where site_id = ${siteId} and active)::int as rooms,
           (select count(*) from app.site_services where site_id = ${siteId} and active)::int as services,
           (select count(*) from app.shift_plans where site_id = ${siteId}
              and (valid_until is null or valid_until >= current_date))::int as plans,
           (select count(*) from app.keys where site_id = ${siteId})::int as keys`;
  const info = s.folder_info ?? {};
  const missing: FolderFacts['missing'] = [];
  if (!s.street || !s.city) missing.push({ label: 'Objektadresse', href: `/objekte/${siteId}/bearbeiten` });
  if (!mgr) missing.push({ label: 'Objektleitung zuordnen', href: `/objekte/${siteId}/bearbeiten` });
  else if (!mgr.phone) missing.push({ label: 'Telefon der Objektleitung', href: '/einstellungen/benutzer' });
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

/** Beschriftung → Wert. „Tel“ bezieht sich auf die Beschriftung davor (Kontaktkarten). */
export function folderValues(f: FolderFacts): Record<string, string> {
  const addr = [f.site.street, [f.site.postal_code, f.site.city].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  const v: Record<string, string> = {
    objekt: `${f.site.name} (${f.site.site_no})`,
    'objekt / objekt-nr.': `${f.site.name} / ${f.site.site_no}`,
    'objekt-nr.': f.site.site_no,
    objektnummer: f.site.site_no,
    objektname: f.site.name,
    adresse: addr,
    anschrift: addr,
    objektadresse: addr,
    kunde: `${f.customer.name} (${f.customer.customer_no})`,
    auftraggeber: f.customer.name,
    'angelegt am': formatDateDe(todayBerlin()),
  };
  if (f.manager) {
    v.objektleitung = f.manager.name;
    if (f.manager.phone) v['objektleitung|tel'] = f.manager.phone;
  }
  const i = f.info;
  if (i.bereichsleitung) v.bereichsleitung = i.bereichsleitung;
  if (i.bereichsleitung_tel) v['bereichsleitung|tel'] = i.bereichsleitung_tel;
  if (i.ersthelfer) {
    v['ersthelfer im objekt'] = i.ersthelfer;
    v.ersthelfer = i.ersthelfer;
  }
  const ap = i.ansprechpartner || f.contact?.name;
  const apTel = i.ansprechpartner_tel || f.contact?.phone;
  if (ap) v['ansprechpartner kunde'] = apTel ? `${ap}, ${apTel}` : ap;
  if (i.putzraum) v.putzraum = i.putzraum;
  return v;
}

const lookup = (values: Record<string, string>, label: string, prev: string) => {
  const k = normLabel(label);
  if ((k === 'tel' || k === 'telefon' || k === 'tel.') && prev) return values[`${prev}|tel`];
  return values[k];
};

/** Unterstriche im XML-Abschnitt durch den Wert ersetzen (erste Fundstelle, weitere Unterstrich-Läufe leeren). */
function replaceUnderscores(xml: string, value: string): string {
  let done = false;
  return xml.replace(
    /(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g,
    (m, open: string, text: string, close: string) => {
      if (!/_{3,}/.test(text)) return m;
      const t = done ? text.replace(/_{3,}/g, '') : text.replace(/_{3,}/, esc(value)).replace(/_{3,}/g, '');
      done = true;
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
    const cells = [...row.matchAll(/<w:tc>[\s\S]*?<\/w:tc>|<w:tc [\s\S]*?<\/w:tc>/g)].map((m) => m[0]);
    if (cells.length < 2) return row;
    let r = row;
    let prev = '';
    for (let i = 0; i + 1 < cells.length; i++) {
      const label = plain(cells[i]!);
      const next = plain(cells[i + 1]!);
      const k = normLabel(label);
      const val = lookup(values, label, prev);
      if (k && !/_{3,}/.test(label)) prev = k === 'tel' || k === 'telefon' ? prev : k;
      if (!val || !label || label.length > 60) continue;
      if (/^_{3,}$/.test(next)) {
        r = r.replace(cells[i + 1]!, replaceUnderscores(cells[i + 1]!, val));
        filled++;
      } else if (next === '' && !/<w:drawing/.test(cells[i + 1]!)) {
        r = r.replace(cells[i + 1]!, fillEmptyCell(cells[i + 1]!, val));
        filled++;
      }
    }
    return r;
  });
  // 2) Absätze „Beschriftung: ____“
  let prev = '';
  out = out.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (p) => {
    const text = plain(p);
    const m = /^(.{2,40}?):\s*_{3,}\s*$/.exec(text);
    if (!m) {
      const k = /^(.{2,40}?):/.exec(text)?.[1];
      if (k) prev = normLabel(k);
      return p;
    }
    const k = normLabel(m[1]!);
    const val = lookup(values, m[1]!, prev);
    if (k !== 'tel' && k !== 'telefon') prev = k;
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
            doc[part] = strToU8(fillFolderXml(strFromU8(doc[part]!), values).xml);
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
    ['Ansprechpartner Kunde', values['ansprechpartner kunde'] ?? '– fehlt –'],
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
      { label: 'Wert', width: 330 },
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
      { label: 'Leistung', width: 230 },
      { label: 'Turnus', width: 90 },
      { label: 'Menge', width: 70, align: 'right' },
      { label: 'Hinweise', width: 160 },
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
      { label: 'Raum', width: 200 },
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
      { label: 'Revier / Bereich', width: 230 },
    ],
    rows: plans.length
      ? plans.map((p) => [p.name ?? '(offen)', WD[p.weekday] ?? '', `${p.start}–${p.end}`, p.note ?? ''])
      : [['Noch keine Einsätze geplant', '', '', '']],
    fontSize: 9,
  });
  const zip = zipSync(out, { level: 6 });
  return { zip, name: `Objektordner_${safe(tag)}.zip`, withPackage: !!pkg, facts: f };
}
