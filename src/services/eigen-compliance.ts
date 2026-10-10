import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import { renderLetterPdf } from '../pdf/render.js';
import { internalBuyer } from './cashbook.js';
import { BusinessError } from './errors.js';
import { getSeller } from './masterdata.js';
import type { Deps } from './workflow.js';

/*
 * Eigen-Compliance (wie die alte App): eigene Nachweise der GmbH mit Gültigkeit, Mehrfach-Nachweise (Krankenkassen,
 * Geschäftsführer), Archiv früherer Versionen, Checkliste der Selbstprüfung und Report für Zoll/Auftraggeber.
 * Anders als die alte App: Dateien write-once, Versionen nie löschbar (DB-Trigger).
 */

export interface EcDoc {
  id: string;
  name: string;
  cat: string;
  critical: boolean;
  validMonths: number;
  template?: boolean;
  multi?: 'kasse' | 'gf';
}

export const EC_DOCS: EcDoc[] = [
  { id: 'gewerbe', name: 'Gewerbeanmeldung', cat: 'Stammdokumente', critical: true, validMonths: 36 },
  {
    id: 'hr',
    name: 'Handelsregisterauszug (HRB 262567)',
    cat: 'Stammdokumente',
    critical: true,
    validMonths: 12,
  },
  {
    id: 'handwerk',
    name: 'Eintragung Handwerksrolle / Handwerkskarte',
    cat: 'Stammdokumente',
    critical: true,
    validMonths: 36,
  },
  {
    id: 'freistellung',
    name: 'Freistellungsbescheinigung § 48b EStG',
    cat: 'Stammdokumente',
    critical: true,
    validMonths: 12,
  },
  {
    id: 'haftpflicht_gr',
    name: 'Betriebshaftpflicht Gebäudereinigung',
    cat: 'Stammdokumente',
    critical: true,
    validMonths: 12,
  },
  {
    id: 'haftpflicht_ab',
    name: 'Betriebshaftpflicht Abbruch',
    cat: 'Stammdokumente',
    critical: false,
    validMonths: 12,
  },
  {
    id: 'eigenauskunft',
    name: 'Eigenauskunft & Compliance-Erklärung',
    cat: 'Stammdokumente',
    critical: true,
    validMonths: 12,
    template: true,
  },
  {
    id: 'satzung',
    name: 'Satzung / Gesellschaftsvertrag (letzte Änderung)',
    cat: 'Stammdokumente',
    critical: false,
    validMonths: 0,
  },
  {
    id: 'gesellschafter',
    name: 'Gesellschafterliste',
    cat: 'Stammdokumente',
    critical: false,
    validMonths: 0,
  },
  {
    id: 'ausweis_gf',
    name: 'Ausweis Geschäftsführer',
    cat: 'Stammdokumente',
    critical: false,
    validMonths: 60,
    multi: 'gf',
  },
  {
    id: 'ub_fa',
    name: 'Bescheinigung in Steuersachen (Finanzamt)',
    cat: 'Unbedenklichkeit',
    critical: true,
    validMonths: 6,
  },
  {
    id: 'ub_kk',
    name: 'UB Krankenkasse(n) / Einzugsstelle (SV)',
    cat: 'Unbedenklichkeit',
    critical: true,
    validMonths: 6,
    multi: 'kasse',
  },
  {
    id: 'ub_knapp',
    name: 'UB Knappschaft (Minijob-Zentrale)',
    cat: 'Unbedenklichkeit',
    critical: true,
    validMonths: 6,
  },
  {
    id: 'ub_bg',
    name: 'UB Berufsgenossenschaft (BG BAU)',
    cat: 'Unbedenklichkeit',
    critical: true,
    validMonths: 6,
  },
  { id: 'ub_soka', name: 'UB SOKA-BAU / ULAK', cat: 'Unbedenklichkeit', critical: false, validMonths: 6 },
  {
    id: 'ub_gewst',
    name: 'UB Gewerbesteuer (Stadtkasse)',
    cat: 'Unbedenklichkeit',
    critical: false,
    validMonths: 12,
  },
  {
    id: 'insolvenz',
    name: 'Auskunft Insolvenzregister',
    cat: 'Unbedenklichkeit',
    critical: false,
    validMonths: 3,
  },
  {
    id: 'milog',
    name: 'Mindestlohn-Selbsterklärung (MiLoG/AEntG)',
    cat: 'Mindestlohn & Tarif',
    critical: true,
    validMonths: 12,
    template: true,
  },
  {
    id: 'tarif',
    name: 'Tarif-Compliance Gebäudereinigung',
    cat: 'Mindestlohn & Tarif',
    critical: false,
    validMonths: 12,
    template: true,
  },
  {
    id: 'gzr',
    name: 'Gewerbezentralregisterauszug',
    cat: 'Mindestlohn & Tarif',
    critical: false,
    validMonths: 12,
  },
  {
    id: 'iso9001',
    name: 'ISO 9001 Zertifikat (Qualität)',
    cat: 'Qualität',
    critical: false,
    validMonths: 36,
  },
  {
    id: 'iso14001',
    name: 'ISO 14001 Zertifikat (Umwelt)',
    cat: 'Qualität',
    critical: false,
    validMonths: 36,
  },
  {
    id: 'innung',
    name: 'Mitgliedsbescheinigung Gebäudereiniger-Innung',
    cat: 'Eignung & Darstellung',
    critical: false,
    validMonths: 12,
  },
  {
    id: 'praequal',
    name: 'Präqualifizierung (PQ-VOB / Amtl. Verzeichnis)',
    cat: 'Eignung & Darstellung',
    critical: false,
    validMonths: 12,
  },
  {
    id: 'unternehmen',
    name: 'Unternehmensdarstellung',
    cat: 'Eignung & Darstellung',
    critical: false,
    validMonths: 12,
  },
];
export const EC_CATS = [
  'Stammdokumente',
  'Unbedenklichkeit',
  'Mindestlohn & Tarif',
  'Qualität',
  'Eignung & Darstellung',
];
export const EC_MULTI = {
  kasse: { label: 'Krankenkasse', quick: ['AOK'] },
  gf: { label: 'Geschäftsführer', quick: [] as string[] },
};

export const EC_CHECKS: { id: string; text: string }[] = [
  { id: 'c1', text: 'Gewerbeanmeldung liegt vor und ist aktuell' },
  { id: 'c2', text: 'Handelsregisterauszug aktuell (≤ 12 Monate)' },
  { id: 'c3', text: 'Eintragung Handwerksrolle / Handwerkskarte vorhanden' },
  { id: 'c4', text: 'Betriebshaftpflichtversicherung besteht und ist ausreichend' },
  { id: 'c5', text: 'Freistellungsbescheinigung § 48b EStG gültig' },
  { id: 'c6', text: 'Unbedenklichkeitsbescheinigung Finanzamt aktuell (≤ 6 Monate)' },
  { id: 'c7', text: 'UB Krankenkassen / Einzugsstellen aktuell' },
  { id: 'c8', text: 'UB Knappschaft (Minijob) aktuell' },
  { id: 'c9', text: 'UB Berufsgenossenschaft (BG BAU) aktuell' },
  { id: 'c10', text: 'UB SOKA-BAU / ULAK aktuell (falls zutreffend)' },
  { id: 'c11', text: 'Alle Mitarbeiter sind zur Sozialversicherung gemeldet (Sofortmeldung)' },
  { id: 'c12', text: 'Mindestlohn nach Tarifvertrag Gebäudereinigung wird gezahlt' },
  { id: 'c13', text: 'Arbeitszeitaufzeichnungen werden gem. MiLoG geführt' },
  { id: 'c14', text: 'A1-Bescheinigungen für entsandte Mitarbeiter liegen vor (falls zutreffend)' },
  { id: 'c15', text: 'Ausweis-/Mitführungspflicht beachtet (Schwarzarbeitsbekämpfung, § 2a SchwarzArbG)' },
  { id: 'c16', text: 'Lohnunterlagen werden vorgehalten und sind auf Anforderung (Zoll/FKS) vorlegbar' },
];

export const VALIDITY_OPTS: [string, string][] = [
  ['3', '3 Monate'],
  ['6', '6 Monate'],
  ['12', '12 Monate'],
  ['24', '24 Monate'],
  ['36', '36 Monate'],
  ['60', '5 Jahre'],
  ['0', 'Kein Ablauf'],
  ['manuell', 'Manuell'],
];

export type EcStatus = 'valid' | 'expiring' | 'expired' | 'missing';
export const EC_STATUS_LABEL: Record<EcStatus, string> = {
  valid: 'Gültig',
  expiring: 'Läuft ab',
  expired: 'Abgelaufen',
  missing: 'Fehlt',
};

export interface EcVersion {
  id: string;
  doc_key: string;
  slot: string;
  file_path: string;
  file_name: string | null;
  file_type: string | null;
  issued_on: string | null;
  validity: string;
  expires_on: string | null;
  checked_by: string | null;
  checked_on: string | null;
  uploaded_by: string;
  uploaded_at: Date;
  superseded_at: Date | null;
  version: number;
}

const addMonthsIso = (d: string, n: number) => {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return t.toISOString().slice(0, 10);
};

export const validityOf = (v: Pick<EcVersion, 'validity'>, dt: EcDoc) =>
  v.validity === 'standard' ? String(dt.validMonths) : v.validity;

/** Ablaufdatum: Ausstellung + Monate, „manuell“ = von Hand, 0 = kein Ablauf. */
export function expiresOf(
  v: Pick<EcVersion, 'validity' | 'issued_on' | 'expires_on'>,
  dt: EcDoc,
): string | null {
  const g = validityOf(v, dt);
  if (g === 'manuell') return v.expires_on;
  if (g === '0') return null;
  return v.issued_on ? addMonthsIso(v.issued_on, Number(g)) : v.expires_on;
}

export function statusOf(v: EcVersion | undefined, dt: EcDoc, today = todayBerlin()): EcStatus {
  if (!v) return 'missing';
  if (validityOf(v, dt) === '0') return 'valid';
  const exp = expiresOf(v, dt);
  if (!exp) return 'expiring'; // Datum offen
  if (exp < today) return 'expired';
  if (exp < addDays(today, 60)) return 'expiring';
  return 'valid';
}

export interface EcEntry {
  dt: EcDoc;
  /** Einzel-Nachweis: ein Eintrag mit slot ''; Mehrfach: je Name */
  items: { slot: string; current: EcVersion | undefined; archive: EcVersion[]; status: EcStatus }[];
  status: EcStatus;
  bucket: 'crit' | 'warn' | 'ok' | 'none';
}

export async function ecOverview(sql: Sql, today = todayBerlin()) {
  const [versions, slots] = await Promise.all([
    sql<EcVersion[]>`select * from app.ec_versions order by uploaded_at desc`,
    sql<{ doc_key: string; name: string }[]>`
      select doc_key, name from app.ec_slots where removed_at is null order by created_at`,
  ]);
  const entries: EcEntry[] = EC_DOCS.map((dt) => {
    const names = dt.multi ? slots.filter((s) => s.doc_key === dt.id).map((s) => s.name) : [''];
    const items = names.map((slot) => {
      const all = versions.filter((v) => v.doc_key === dt.id && v.slot === slot);
      const current = all.find((v) => !v.superseded_at);
      return {
        slot,
        current,
        archive: all.filter((v) => v.superseded_at),
        status: statusOf(current, dt, today),
      };
    });
    let status: EcStatus = items.length ? 'valid' : 'missing';
    for (const i of items) {
      if (i.status === 'missing' || i.status === 'expired') status = dt.multi ? 'expired' : i.status;
      else if (i.status === 'expiring' && status === 'valid') status = 'expiring';
    }
    if (!dt.multi) status = items[0]!.status;
    const bucket =
      status === 'valid'
        ? 'ok'
        : status === 'expired'
          ? dt.critical
            ? 'crit'
            : 'warn'
          : status === 'missing'
            ? dt.critical
              ? 'crit'
              : 'none'
            : 'warn';
    return { dt, items, status, bucket };
  });
  return {
    entries,
    sum: {
      crit: entries.filter((e) => e.bucket === 'crit').length,
      warn: entries.filter((e) => e.bucket === 'warn').length,
      ok: entries.filter((e) => e.bucket === 'ok').length,
    },
  };
}

const docOf = (key: string) => {
  const dt = EC_DOCS.find((d) => d.id === key);
  if (!dt) throw new BusinessError('Unbekannter Nachweis');
  return dt;
};

async function assertSlot(sql: Sql, dt: EcDoc, slot: string) {
  if (!dt.multi) {
    if (slot) throw new BusinessError('Ungültiger Eintrag');
    return;
  }
  const [s] =
    await sql`select 1 from app.ec_slots where doc_key = ${dt.id} and name = ${slot} and removed_at is null`;
  if (!s) throw new BusinessError(`${EC_MULTI[dt.multi].label} nicht gefunden`);
}

/** Neue Version hochladen; die bisherige wandert ins Archiv (nie gelöscht). */
export async function uploadVersion(
  deps: Deps,
  p: { key: string; slot: string; file: { bytes: Uint8Array; name: string; type: string } },
  actor: string,
): Promise<string> {
  const { sql } = deps;
  const dt = docOf(p.key);
  await assertSlot(sql, dt, p.slot);
  if (p.file.bytes.length > 10 * 1024 * 1024) throw new BusinessError('Datei zu groß (max. 10 MB)');
  if (!/^(application\/pdf|image\/(jpeg|png))$/.test(p.file.type))
    throw new BusinessError('Nur PDF, JPG oder PNG erlaubt');
  const sha = createHash('sha256').update(p.file.bytes).digest('hex');
  const ext = p.file.type === 'application/pdf' ? 'pdf' : p.file.type === 'image/png' ? 'png' : 'jpg';
  const path = `eigen-compliance/${sha.slice(0, 2)}/${sha}.${ext}`;
  await deps.archive.put(path, p.file.bytes);
  const id = randomUUID();
  const today = todayBerlin();
  await sql.begin(async (tx) => {
    const [old] = await tx<EcVersion[]>`
      update app.ec_versions set superseded_at = now()
       where doc_key = ${dt.id} and slot = ${p.slot} and superseded_at is null returning *`;
    await tx`insert into app.ec_versions ${tx({
      id,
      doc_key: dt.id,
      slot: p.slot,
      file_path: path,
      file_sha256: sha,
      file_name: p.file.name.slice(0, 200),
      file_type: p.file.type,
      issued_on: dt.validMonths === 0 ? null : today,
      validity: old && old.validity !== 'standard' ? old.validity : 'standard',
      checked_by: actor,
      checked_on: today,
      uploaded_by: actor,
    } as Record<string, unknown>)}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'upload', 'eigen_compliance', ${id}, ${tx.json({ nachweis: dt.name, eintrag: p.slot || null })})`;
  });
  return id;
}

export async function getVersion(sql: Sql, id: string) {
  const [v] = await sql<EcVersion[]>`select * from app.ec_versions where id = ${id}`;
  return v;
}

/** „Datum & Gültigkeit“ der aktuellen Version setzen. */
export async function setValidity(
  sql: Sql,
  id: string,
  p: { issuedOn: string | null; validity: string; expiresOn: string | null; expectedVersion: number | null },
  actor: string,
) {
  const v = await getVersion(sql, id);
  if (!v) throw new BusinessError('Nachweis nicht gefunden');
  if (v.superseded_at) throw new BusinessError('Archivierte Versionen sind unveränderlich');
  if (!VALIDITY_OPTS.some(([k]) => k === p.validity)) throw new BusinessError('Gültigkeit ungültig');
  if (p.validity === 'manuell' && !p.expiresOn) throw new BusinessError('Bitte „gültig bis“ angeben');
  if (p.validity !== '0' && p.validity !== 'manuell' && !p.issuedOn)
    throw new BusinessError('Bitte das Ausstellungsdatum angeben');
  if (p.issuedOn && p.issuedOn > todayBerlin())
    throw new BusinessError('Ausstellungsdatum liegt in der Zukunft');
  const r = await sql`
    update app.ec_versions set issued_on = ${p.issuedOn}, validity = ${p.validity},
           expires_on = ${p.validity === 'manuell' ? p.expiresOn : null}
     where id = ${id} and (${p.expectedVersion}::int is null or version = ${p.expectedVersion})`;
  if (!r.count) throw new BusinessError('Der Nachweis wurde zwischenzeitlich geändert – bitte neu laden');
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'gueltigkeit', 'eigen_compliance', ${id},
                    ${sql.json({ ausgestellt: p.issuedOn, gueltigkeit: p.validity, bis: p.expiresOn })})`;
}

export async function markChecked(sql: Sql, id: string, actor: string) {
  await sql`update app.ec_versions set checked_by = ${actor}, checked_on = ${todayBerlin()}
             where id = ${id} and superseded_at is null`;
}

export async function addSlot(sql: Sql, key: string, name: string) {
  const dt = docOf(key);
  if (!dt.multi) throw new BusinessError('Nur für Mehrfach-Nachweise');
  const n = name.trim().slice(0, 80);
  if (!n) throw new BusinessError('Bitte einen Namen angeben');
  await sql`insert into app.ec_slots (doc_key, name) values (${key}, ${n})
            on conflict (doc_key, name) do update set removed_at = null`;
}

/** Eintrag ausblenden – hochgeladene Versionen bleiben im Archiv. */
export async function removeSlot(sql: Sql, key: string, name: string) {
  await sql`update app.ec_slots set removed_at = now() where doc_key = ${key} and name = ${name}`;
}

// ------------------------------------------------------------------ Prüfung

export async function getChecks(sql: Sql) {
  const [rows, [last]] = await Promise.all([
    sql<{ check_id: string; status: string | null; note: string | null }[]>`select * from app.ec_checks`,
    sql<{ reviewed_by: string; reviewed_at: Date }[]>`
      select reviewed_by, reviewed_at from app.ec_reviews order by id desc limit 1`,
  ]);
  return { map: new Map(rows.map((r) => [r.check_id, r])), last: last ?? null };
}

export async function saveChecks(
  sql: Sql,
  values: { id: string; status: string | null; note: string | null }[],
  actor: string,
) {
  for (const v of values) {
    if (!EC_CHECKS.some((c) => c.id === v.id)) continue;
    const status = v.status === 'ja' || v.status === 'nein' || v.status === 'na' ? v.status : null;
    await sql`insert into app.ec_checks (check_id, status, note, updated_by)
              values (${v.id}, ${status}, ${v.note?.trim() || null}, ${actor})
              on conflict (check_id) do update set status = excluded.status, note = excluded.note,
                updated_by = excluded.updated_by, updated_at = now()
              where app.ec_checks.status is distinct from excluded.status or app.ec_checks.note is distinct from excluded.note`;
  }
}

/** Prüfung abschließen: Stand wird unveränderlich festgehalten. */
export async function finishReview(sql: Sql, actor: string) {
  const { map } = await getChecks(sql);
  const open = EC_CHECKS.filter((c) => !map.get(c.id)?.status);
  if (open.length)
    throw new BusinessError(`Noch ${open.length} Punkte offen – bitte alle mit Ja/Nein/N/A beantworten`);
  await sql`insert into app.ec_reviews (reviewed_by, result)
            values (${actor}, ${sql.json(EC_CHECKS.map((c) => ({ id: c.id, text: c.text, status: map.get(c.id)!.status, notiz: map.get(c.id)!.note })))})`;
}

// ------------------------------------------------------------------ PDF

const TEMPLATES: Record<string, { title: string; subtitle: string; intro: string; points: string[] }> = {
  milog: {
    title: 'Mindestlohn-Selbsterklärung',
    subtitle: 'gem. Mindestlohngesetz (MiLoG) und Tarifvertrag Gebäudereinigung',
    intro: 'Die {firma}, {adresse}, erklärt hiermit verbindlich:',
    points: [
      'Allen im Betrieb beschäftigten Arbeitnehmerinnen und Arbeitnehmern wird mindestens der gesetzliche Mindestlohn nach dem MiLoG sowie der jeweils gültige Branchenmindestlohn der Gebäudereinigung gezahlt.',
      'Die Arbeitszeiten werden gemäß § 17 MiLoG vollständig aufgezeichnet und mindestens zwei Jahre aufbewahrt.',
      'Alle Beschäftigten werden ordnungsgemäß zur Sozialversicherung angemeldet (Sofortmeldung gem. § 28a SGB IV).',
      'Es werden keine Werkverträge oder Nachunternehmer zur Umgehung des Mindestlohns eingesetzt.',
      'Auf Verlangen der Finanzkontrolle Schwarzarbeit (Zoll) oder des Auftraggebers werden Lohn- und Arbeitszeitnachweise vorgelegt.',
    ],
  },
  tarif: {
    title: 'Tarif-Compliance-Erklärung',
    subtitle: 'Allgemeinverbindlicher Tarifvertrag für das Gebäudereiniger-Handwerk',
    intro: 'Die {firma} erklärt hiermit:',
    points: [
      'Es wird der jeweils gültige, allgemeinverbindliche Rahmen- und Lohntarifvertrag für die gewerblichen Beschäftigten im Gebäudereiniger-Handwerk angewendet.',
      'Die tariflichen Lohngruppen, Zuschläge und Urlaubsansprüche werden eingehalten.',
      'Beiträge zur Sozialkasse (SOKA) werden – soweit einschlägig – ordnungsgemäß abgeführt.',
      'Änderungen der Tariflage werden zeitnah umgesetzt.',
    ],
  },
  eigenauskunft: {
    title: 'Eigenauskunft & Compliance-Erklärung',
    subtitle: 'Selbstauskunft',
    intro: 'Die {firma}, {adresse} ({register}, USt-IdNr. {ust}), erklärt hiermit:',
    points: [
      'Das Unternehmen ist ordnungsgemäß im Handelsregister sowie in der Handwerksrolle eingetragen und übt sein Gewerbe rechtmäßig aus.',
      'Es bestehen keine offenen Verbindlichkeiten gegenüber Finanzamt, Krankenkassen, Berufsgenossenschaft oder Sozialkasse; entsprechende Unbedenklichkeitsbescheinigungen werden auf Anforderung vorgelegt.',
      'Es besteht eine ausreichende Betriebshaftpflichtversicherung.',
      'Alle gesetzlichen Bestimmungen (MiLoG, AEntG, SGB, SchwarzArbG, Tarifvertrag Gebäudereinigung) werden eingehalten.',
      'Eingesetztes Personal ist sozialversicherungsrechtlich gemeldet; Ausweis- und Mitführungspflichten werden beachtet.',
      'Auf Anforderung des Zolls (FKS) oder des Auftraggebers werden alle erforderlichen Nachweise vorgelegt.',
    ],
  },
};

export async function templatePdf(sql: Sql, key: string) {
  const t = TEMPLATES[key];
  if (!t) throw new BusinessError('Für diesen Nachweis gibt es keine Vorlage');
  const seller = await getSeller(sql);
  const fill = (s: string) =>
    s
      .replace('{firma}', seller.legalName)
      .replace('{adresse}', `${seller.street}, ${seller.postalCode} ${seller.city}`)
      .replace('{register}', [seller.registerCourt, seller.registerNumber].filter(Boolean).join(' '))
      .replace('{ust}', seller.vatId ?? '');
  const today = todayBerlin();
  return renderLetterPdf({
    title: t.title,
    date: today,
    info: [['Datum', formatDateDe(today)]],
    seller,
    buyer: internalBuyer(seller, t.subtitle),
    greeting: null,
    intro: fill(t.intro),
    columns: [],
    rows: [],
    sums: [],
    total: null,
    paragraphs: [
      ...t.points.map((x, i) => `${i + 1}. ${x}`),
      `${seller.city}, den ______________________        ______________________________________`,
      'Unterschrift / Stempel (Geschäftsführung)',
    ],
  });
}

export async function reportPdf(sql: Sql) {
  const seller = await getSeller(sql);
  const today = todayBerlin();
  const { entries, sum } = await ecOverview(sql, today);
  const { map, last } = await getChecks(sql);
  const rows: string[][] = [];
  for (const cat of EC_CATS) {
    rows.push([cat.toUpperCase(), '', '']);
    for (const e of entries.filter((x) => x.dt.cat === cat)) {
      if (e.dt.multi) {
        rows.push([
          `${e.dt.critical ? '• ' : '  '}${e.dt.name}`,
          e.items.length ? `${e.items.length} ${e.dt.multi === 'gf' ? 'Person(en)' : 'Kasse(n)'}` : 'Fehlt',
          '',
        ]);
        for (const i of e.items) {
          const exp = i.current ? expiresOf(i.current, e.dt) : null;
          rows.push([`     – ${i.slot}`, EC_STATUS_LABEL[i.status], exp ? formatDateDe(exp) : '—']);
        }
      } else {
        const cur = e.items[0]!.current;
        const exp = cur ? expiresOf(cur, e.dt) : null;
        rows.push([
          `${e.dt.critical ? '• ' : '  '}${e.dt.name}`,
          EC_STATUS_LABEL[e.status],
          cur && validityOf(cur, e.dt) === '0' ? 'kein Ablauf' : exp ? formatDateDe(exp) : '—',
        ]);
      }
    }
  }
  const label = (s: string | null | undefined) =>
    s === 'ja' ? '[Ja]' : s === 'nein' ? '[Nein]' : s === 'na' ? '[N/A]' : '[ – ]';
  return renderLetterPdf({
    title: 'Compliance-Nachweis',
    date: today,
    info: [
      ['Stand', formatDateDe(today)],
      ['Nachweise gültig', `${sum.ok} / ${EC_DOCS.length}`],
      ['Kritisch', String(sum.crit)],
    ],
    seller,
    buyer: internalBuyer(seller, 'Eigenauskunft zur Vorlage bei Zoll (FKS) und Auftraggebern'),
    greeting: null,
    intro: `1. Nachweise & Bescheinigungen (• = Pflicht). ${seller.legalName}, ${seller.street}, ${seller.postalCode} ${seller.city}${seller.registerNumber ? `, ${[seller.registerCourt, seller.registerNumber].filter(Boolean).join(' ')}` : ''}${seller.vatId ? `, USt-IdNr. ${seller.vatId}` : ''}.`,
    columns: [
      { label: 'Dokument', x: 62.3, align: 'left' },
      { label: 'Status', x: 360, align: 'left' },
      { label: 'gültig bis', x: 538.8 },
    ],
    rows,
    sums: [],
    total: null,
    paragraphs: [
      `2. Interne Selbstprüfung${last ? ` (abgeschlossen von ${last.reviewed_by} am ${last.reviewed_at.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' })})` : ''}`,
      ...EC_CHECKS.map((c) => {
        const r = map.get(c.id);
        return `${label(r?.status)} ${c.text}${r?.note ? ` – Bemerkung: ${r.note}` : ''}`;
      }),
      'Datum ______________________        Unterschrift / Stempel (Geschäftsführung) ______________________',
    ],
  });
}

// ------------------------------------------------------------------ Import alte App

export interface LegacyEcFile {
  bytes: Uint8Array;
  name: string;
}

/** Bestand der alten App übernehmen (eigen_compliance.json + Dateien). Idempotent über legacy_id. */
export async function importLegacyEc(
  deps: Deps,
  row: Record<string, unknown>,
  file: (path: string) => Uint8Array | undefined,
  actor: string,
) {
  const { sql } = deps;
  const docs = (row.documents ?? {}) as Record<string, Record<string, unknown>>;
  let n = 0;
  let missing = 0;
  const mime = (p: string) =>
    /\.pdf$/i.test(p) ? 'application/pdf' : /\.png$/i.test(p) ? 'image/png' : 'image/jpeg';
  const iso = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  const put = async (
    key: string,
    slot: string,
    d: Record<string, unknown>,
    superseded: boolean,
    seq: number,
  ): Promise<void> => {
    const fp = typeof d.file_path === 'string' ? d.file_path : null;
    if (!fp) return;
    const legacyId = `ec:${key}:${slot}:${fp}`;
    const [exists] = await sql`select 1 from app.ec_versions where legacy_id = ${legacyId}`;
    if (exists) return;
    const bytes = file(`eigencompliance/${fp}`);
    if (!bytes) {
      missing++;
      return;
    }
    const sha = createHash('sha256').update(bytes).digest('hex');
    const ext = fp.split('.').pop()?.toLowerCase() ?? 'pdf';
    const path = `eigen-compliance/${sha.slice(0, 2)}/${sha}.${ext}`;
    await deps.archive.put(path, bytes);
    const g = d.gueltig_monate;
    const validity =
      g === undefined || g === null ? 'standard' : g === 'manuell' ? 'manuell' : String(Number(g));
    const exp = iso(d.expires) ?? iso(d.gueltig_bis);
    const issued = iso(d.ausstell);
    const at = iso(d.uploaded_at) ?? iso(d.archiviert_am) ?? todayBerlin();
    await sql`insert into app.ec_versions ${sql({
      id: randomUUID(),
      doc_key: key,
      slot,
      file_path: path,
      file_sha256: sha,
      file_name: typeof d.file_name === 'string' ? d.file_name : fp,
      file_type: mime(fp),
      issued_on: issued,
      // ohne Ausstellungsdatum, aber mit Ablaufdatum der alten App → als „manuell“ übernehmen
      validity:
        validity === 'standard'
          ? !issued && exp
            ? 'manuell'
            : 'standard'
          : VALIDITY_OPTS.some(([k]) => k === validity)
            ? validity
            : 'manuell',
      expires_on: exp,
      checked_by: typeof d.geprueft_von === 'string' ? d.geprueft_von : null,
      checked_on: iso(d.geprueft_am),
      uploaded_by: actor,
      uploaded_at: new Date(new Date(`${at}T12:00:00Z`).getTime() - seq * 1000),
      superseded_at: superseded ? new Date(`${iso(d.archiviert_am) ?? at}T12:00:00Z`) : null,
      legacy_id: legacyId,
    } as Record<string, unknown>)}`;
    n++;
  };
  for (const [key, d] of Object.entries(docs)) {
    const k = key === 'haftpflicht' ? 'haftpflicht_gr' : key;
    const dt = EC_DOCS.find((x) => x.id === k);
    if (!dt || !d || typeof d !== 'object') continue;
    if (dt.multi) {
      const items = (Array.isArray(d.items) ? d.items : Array.isArray(d.kassen) ? d.kassen : []) as Record<
        string,
        unknown
      >[];
      for (const it of items) {
        const name = String(it.name ?? EC_MULTI[dt.multi].label).trim();
        await sql`insert into app.ec_slots (doc_key, name) values (${k}, ${name}) on conflict do nothing`;
        for (const [i, a] of ((it.archiv ?? []) as Record<string, unknown>[]).entries())
          await put(k, name, a, true, i + 1);
        await put(k, name, it, false, 0);
      }
      continue;
    }
    // Archiv zuerst (ältere Versionen), danach die aktuelle
    const arch = (Array.isArray(d.archiv) ? d.archiv : []) as Record<string, unknown>[];
    for (const [i, a] of [...arch].reverse().entries()) await put(k, '', a, true, arch.length - i);
    const [cur] =
      await sql`select 1 from app.ec_versions where doc_key = ${k} and slot = '' and superseded_at is null`;
    if (!cur) await put(k, '', d, false, 0);
  }
  const p = (row.pruefung ?? {}) as Record<string, { status?: string; notiz?: string }>;
  await saveChecks(
    sql,
    Object.entries(p).map(([id, v]) => ({ id, status: v?.status ?? null, note: v?.notiz ?? null })),
    actor,
  );
  return { n, missing };
}
