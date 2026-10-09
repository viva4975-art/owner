import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import type { BuyerSnapshot } from '../domain/invoice/types.js';
import { type Cents, formatEuro } from '../domain/money/money.js';
import { NU_CONDITIONS } from '../domain/subcontract/conditions.js';
import { FORM_COLORS, FORM_X, FormDoc } from '../pdf/form-doc.js';
import { renderLetterPdf } from '../pdf/render.js';
import { assertVersion } from './crm.js';
import { hashPin, LOCK_MINUTES, MAX_ATTEMPTS, verifyHash } from './employee-auth.js';
import { BusinessError } from './errors.js';
import { getSupplier, type Supplier } from './inventory.js';
import { getSeller } from './masterdata.js';
import { nextYearNumber } from './purchasing.js';
import type { Deps } from './workflow.js';

/*
 * Nachunternehmer: Nachweise mit Fristen (Ampel wie in der alten App), Versionen (nie löschen), Upload-Portal für den
 * Nachunternehmer (Link + PIN, Prüfung durch das Büro), Aufträge mit Preisnachträgen, Soll/Ist je Monat, Kündigung.
 * Hintergrund: Als Auftraggeber haften wir für Mindestlohn (§ 13 MiLoG, § 14 AEntG) und SV-Beiträge (§ 28e Abs. 3a
 * SGB IV) der Beschäftigten des Nachunternehmers – lückenlose, aktuelle Nachweise sind die Entlastung.
 */

export const LEGAL_FORMS: Record<string, string> = {
  einzelunternehmen: 'Einzelunternehmen',
  kleingewerbe: 'Kleingewerbe',
  freiberufler: 'Freiberufler',
  gbr: 'GbR',
  ek: 'e.K.',
  ohg: 'OHG',
  kg: 'KG',
  gmbh_co_kg: 'GmbH & Co. KG',
  gmbh: 'GmbH',
  ug: 'UG (haftungsbeschränkt)',
  ag: 'AG',
  kgaa: 'KGaA',
  eg: 'eG',
  sonstige: 'Sonstige',
};
/** Rechtsformen mit Handelsregister → HR-Auszug Pflicht; ohne Register wird er nicht verlangt. */
const HR_FORMS = new Set(['ek', 'ohg', 'kg', 'gmbh_co_kg', 'gmbh', 'ug', 'ag', 'kgaa', 'eg']);
const NO_HR_FORMS = new Set(['einzelunternehmen', 'kleingewerbe', 'freiberufler', 'gbr']);
export const WARN_DAYS = 60;

export const TERMINATION_REASONS = [
  'Qualitätsmängel',
  'Nachweise fehlen / abgelaufen',
  'Mindestlohn-/Arbeitszeitverstöße',
  'Auftrag beim Kunden beendet',
  'Preis / Wirtschaftlichkeit',
  'Unzuverlässigkeit / Termine',
  'auf Wunsch des Nachunternehmers',
  'Sonstiges',
];

export interface DocType {
  id: string;
  label: string;
  category: string;
  required: 'ja' | 'nein' | 'hr';
  valid_months: number;
  hint: string | null;
  sort: number;
}
export interface SupplierDocument {
  id: string;
  supplier_id: string;
  doc_type: string;
  file_name: string;
  content_type: string;
  path: string;
  sha256: string;
  size_bytes: number;
  valid_until: string | null;
  source: 'buero' | 'portal';
  status: 'zu_pruefen' | 'gueltig' | 'abgelehnt';
  reject_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  uploaded_by: string;
  created_at: Date;
}
export type DocState = 'fehlt' | 'abgelaufen' | 'laeuft_ab' | 'gueltig' | 'zu_pruefen';
export const DOC_STATE: Record<DocState, string> = {
  fehlt: 'fehlt',
  abgelaufen: 'abgelaufen',
  laeuft_ab: 'läuft bald ab',
  gueltig: 'gültig',
  zu_pruefen: 'zu prüfen',
};
export type Overall = 'kritisch' | 'warnung' | 'ok' | 'inaktiv';
export const OVERALL: Record<Overall, string> = {
  kritisch: 'Nachweise fehlen',
  warnung: 'läuft bald ab',
  ok: 'vollständig',
  inaktiv: 'inaktiv',
};

export async function docTypes(sql: Sql) {
  return sql<DocType[]>`select * from app.supplier_doc_types where active order by sort, label`;
}

export function isRequired(t: DocType, legalForm: string | null): boolean | null {
  if (t.required === 'ja') return true;
  if (t.required === 'nein') return false;
  if (legalForm && HR_FORMS.has(legalForm)) return true;
  if (legalForm && NO_HR_FORMS.has(legalForm)) return null; // nicht anzeigen
  return false; // unbekannte/sonstige Rechtsform: optional
}

export interface ComplianceRow {
  type: DocType;
  required: boolean;
  state: DocState;
  current: SupplierDocument | null;
  pending: SupplierDocument | null;
  days: number | null;
}

/** Ampel je Nachweisart und gesamt (Regeln wie alte App; „zu prüfen“ zählt erst nach Prüfung). */
export function evaluate(
  s: Pick<Supplier, 'active'> & { legal_form: string | null; terminated_on: string | null },
  types: DocType[],
  docs: SupplierDocument[],
  today = todayBerlin(),
): { rows: ComplianceRow[]; overall: Overall; nextExpiry: string | null } {
  const rows: ComplianceRow[] = [];
  for (const t of types) {
    const req = isRequired(t, s.legal_form);
    if (req === null) continue;
    const mine = docs.filter((d) => d.doc_type === t.id).sort((a, b) => +b.created_at - +a.created_at);
    const current = mine.find((d) => d.status === 'gueltig') ?? null;
    const pending =
      mine.find((d) => d.status === 'zu_pruefen' && (!current || d.created_at > current.created_at)) ?? null;
    let state: DocState;
    let days: number | null = null;
    if (!current) state = pending ? 'zu_pruefen' : 'fehlt';
    else if (t.valid_months === 0) state = 'gueltig';
    else if (!current.valid_until) state = 'laeuft_ab';
    else {
      days = Math.round((Date.parse(current.valid_until) - Date.parse(today)) / 86_400_000);
      state = days < 0 ? 'abgelaufen' : days <= WARN_DAYS ? 'laeuft_ab' : 'gueltig';
    }
    rows.push({ type: t, required: req, state, current, pending, days });
  }
  let overall: Overall = 'ok';
  if (!s.active || s.terminated_on) overall = 'inaktiv';
  else if (rows.some((r) => r.required && ['fehlt', 'abgelaufen', 'zu_pruefen'].includes(r.state)))
    overall = 'kritisch';
  else if (rows.some((r) => r.state === 'laeuft_ab' || (!r.required && r.state === 'abgelaufen')))
    overall = 'warnung';
  const nextExpiry =
    rows
      .map((r) => r.current?.valid_until)
      .filter((d): d is string => !!d)
      .sort()[0] ?? null;
  return { rows, overall, nextExpiry };
}

type SupplierRow = Supplier & {
  legal_form: string | null;
  short_code: string | null;
  contacts: { name: string; phone?: string; email?: string }[];
  terminated_on: string | null;
  termination_reason: string | null;
  portal_token: string | null;
  portal_pin_hash: string | null;
  portal_failed: number;
  portal_locked_until: Date | null;
};

export async function getSubcontractor(sql: Sql, id: string) {
  const s = (await getSupplier(sql, id)) as SupplierRow | undefined;
  if (!s) return undefined;
  const [types, docs] = await Promise.all([
    docTypes(sql),
    sql<
      SupplierDocument[]
    >`select * from app.supplier_documents where supplier_id = ${id} order by created_at desc`,
  ]);
  return { supplier: s, docs, ...evaluate(s, types, docs) };
}

/** Übersicht aller Nachunternehmer mit Ampel (für Liste, Startseite und Zahlungslauf). */
export async function complianceOverview(sql: Sql) {
  const [subs, types, docs] = await Promise.all([
    sql<SupplierRow[]>`select * from app.suppliers where kind = 'nachunternehmer' order by active desc, name`,
    docTypes(sql),
    sql<SupplierDocument[]>`
      select d.* from app.supplier_documents d join app.suppliers s on s.id = d.supplier_id
       where s.kind = 'nachunternehmer'`,
  ]);
  return subs.map((s) => {
    const e = evaluate(
      s,
      types,
      docs.filter((d) => d.supplier_id === s.id),
    );
    return {
      supplier: s,
      overall: e.overall,
      nextExpiry: e.nextExpiry,
      missing: e.rows
        .filter((r) => r.required && r.state !== 'gueltig' && r.state !== 'laeuft_ab')
        .map((r) => r.type.label),
      expiring: e.rows.filter((r) => r.state === 'laeuft_ab').map((r) => r.type.label),
      // für den Fristen-Hinweis: abgelaufene und bald ablaufende Nachweise mit Resttagen
      due: e.rows
        .filter((r) => r.required && (r.state === 'abgelaufen' || r.state === 'laeuft_ab') && r.days != null)
        .map((r) => ({ label: r.type.label, days: r.days!, until: r.current?.valid_until ?? null })),
      pending: e.rows.filter((r) => r.pending).length,
      requiredTotal: e.rows.filter((r) => r.required).length,
      requiredOk: e.rows.filter((r) => r.required && (r.state === 'gueltig' || r.state === 'laeuft_ab'))
        .length,
    };
  });
}

/** Nachunternehmer mit kritischer Ampel (Zahlung zurückhalten). */
export async function criticalSupplierIds(sql: Sql): Promise<Set<string>> {
  return new Set(
    (await complianceOverview(sql)).filter((r) => r.overall === 'kritisch').map((r) => r.supplier.id),
  );
}

// ---------------------------------------------------------------------------
// Nachweise hochladen / prüfen
// ---------------------------------------------------------------------------

const MAX_DOC_BYTES = 10 * 1024 * 1024;

function sniff(data: Uint8Array): { type: string; ext: string } {
  const h = Buffer.from(data.slice(0, 8));
  if (h.subarray(0, 5).toString() === '%PDF-') return { type: 'application/pdf', ext: 'pdf' };
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (h.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { type: 'image/png', ext: 'png' };
  throw new BusinessError('Bitte PDF, JPG oder PNG hochladen');
}

export function suggestValidUntil(t: DocType, from = todayBerlin()): string | null {
  if (t.valid_months === 0) return null;
  const d = new Date(`${from}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + t.valid_months);
  return d.toISOString().slice(0, 10);
}

export async function uploadDocument(
  deps: Deps,
  p: {
    id: string;
    supplierId: string;
    docType: string;
    fileName: string;
    data: Uint8Array;
    validUntil: string | null;
    source: 'buero' | 'portal';
    actor: string;
  },
) {
  const { sql } = deps;
  const [exists] = await sql`select 1 from app.supplier_documents where id = ${p.id}`;
  if (exists) return; // doppelt gesendet
  if (!p.data.byteLength) throw new BusinessError('Datei ist leer');
  if (p.data.byteLength > MAX_DOC_BYTES) throw new BusinessError('Datei ist größer als 10 MB');
  const [t] = await sql<DocType[]>`select * from app.supplier_doc_types where id = ${p.docType}`;
  if (!t) throw new BusinessError('Unbekannte Nachweisart');
  const s = await getSupplier(sql, p.supplierId);
  if (!s || s.kind !== 'nachunternehmer') throw new BusinessError('Nachunternehmer nicht gefunden');
  if (p.validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(p.validUntil))
    throw new BusinessError('Datum „gültig bis“ ungültig');
  // Büro: Datum Pflicht (steht auf dem Nachweis); Portal: Angabe des Nachunternehmers, Büro prüft
  if (p.source === 'buero' && t.valid_months > 0 && !p.validUntil)
    throw new BusinessError(`${t.label}: Bitte „gültig bis“ angeben (steht auf dem Nachweis)`);
  const kind = sniff(p.data);
  const sha = createHash('sha256').update(p.data).digest('hex');
  const path = `nachunternehmer/${p.supplierId}/${sha}.${kind.ext}`;
  await deps.archive.put(path, p.data);
  await sql`
    insert into app.supplier_documents (id, supplier_id, doc_type, file_name, content_type, path, sha256, size_bytes,
                                        valid_until, source, status, uploaded_by, reviewed_by, reviewed_at)
    values (${p.id}, ${p.supplierId}, ${p.docType}, ${p.fileName.slice(0, 200) || `${p.docType}.${kind.ext}`},
            ${kind.type}, ${path}, ${sha}, ${p.data.byteLength}, ${t.valid_months === 0 ? null : p.validUntil},
            ${p.source}, ${p.source === 'buero' ? 'gueltig' : 'zu_pruefen'}, ${p.actor},
            ${p.source === 'buero' ? p.actor : null}, ${p.source === 'buero' ? new Date() : null})
    on conflict (id) do nothing`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${p.actor}, 'upload', 'supplier_document', ${p.id}, ${sql.json({ supplier: p.supplierId, type: p.docType, sha256: sha })})`;
  await syncSupplierDates(sql, p.supplierId);
}

export async function reviewDocument(
  sql: Sql,
  docId: string,
  p: { accept: boolean; validUntil: string | null; reason: string | null },
  actor: string,
) {
  const [d] = await sql<(SupplierDocument & { valid_months: number })[]>`
    select d.*, t.valid_months from app.supplier_documents d join app.supplier_doc_types t on t.id = d.doc_type
     where d.id = ${docId}`;
  if (!d) throw new BusinessError('Nachweis nicht gefunden');
  if (d.status !== 'zu_pruefen') return;
  if (p.accept && d.valid_months > 0 && !p.validUntil)
    throw new BusinessError('Bitte „gültig bis“ prüfen/eintragen');
  if (!p.accept && !p.reason?.trim()) throw new BusinessError('Bitte Grund für die Ablehnung angeben');
  await sql`
    update app.supplier_documents
       set status = ${p.accept ? 'gueltig' : 'abgelehnt'},
           valid_until = ${p.accept ? (d.valid_months > 0 ? p.validUntil : null) : d.valid_until},
           reject_reason = ${p.accept ? null : p.reason!.trim()}, reviewed_by = ${actor}, reviewed_at = now()
     where id = ${docId} and status = 'zu_pruefen'`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id)
            values (${actor}, ${p.accept ? 'accept' : 'reject'}, 'supplier_document', ${docId})`;
  await syncSupplierDates(sql, d.supplier_id);
}

/** Bisherige Felder (Liste, Warnungen) aus den Nachweisen ableiten: § 48b und früheste Unbedenklichkeit. */
async function syncSupplierDates(sql: Sql, supplierId: string) {
  await sql`
    with cur as (
      select distinct on (doc_type) doc_type, valid_until from app.supplier_documents
       where supplier_id = ${supplierId} and status = 'gueltig' order by doc_type, created_at desc
    )
    update app.suppliers set
      exemption_valid_until = coalesce((select valid_until from cur where doc_type = 'freistellung'), exemption_valid_until),
      clearance_valid_until = coalesce(
        (select case when count(*) = 3 then min(valid_until) end from cur where doc_type in ('ub_kk_sv', 'ub_kk_min', 'ub_bg')),
        clearance_valid_until)
     where id = ${supplierId}`;
}

export async function documentFile(deps: Deps, docId: string) {
  const [d] = await deps.sql<SupplierDocument[]>`select * from app.supplier_documents where id = ${docId}`;
  if (!d) throw new BusinessError('Nachweis nicht gefunden');
  return { doc: d, data: await deps.archive.get(d.path) };
}

/** Nachforderung als Text (E-Mail oder Brief), mit Portal-Link falls vorhanden. */
export function requestText(
  s: { name: string; contact_name: string | null },
  rows: ComplianceRow[],
  portalUrl: string | null,
): string {
  const need = rows.filter((r) => r.required && r.state !== 'gueltig');
  const soon = rows.filter((r) => !r.required && (r.state === 'laeuft_ab' || r.state === 'abgelaufen'));
  const line = (r: ComplianceRow) =>
    `- ${r.type.label}${r.state === 'laeuft_ab' && r.current?.valid_until ? ` (läuft ab am ${formatDateDe(r.current.valid_until)})` : r.state === 'abgelaufen' ? ' (abgelaufen)' : ''}`;
  return [
    s.contact_name ? `Guten Tag ${s.contact_name},` : 'Sehr geehrte Damen und Herren,',
    '',
    'für die weitere Zusammenarbeit benötigen wir von Ihnen folgende aktuelle Nachweise:',
    ...need.map(line),
    ...(soon.length ? ['', 'Außerdem bitte, sofern zutreffend:', ...soon.map(line)] : []),
    '',
    portalUrl
      ? `Sie können die Unterlagen direkt hochladen: ${portalUrl} (PIN haben Sie separat erhalten).`
      : 'Bitte senden Sie die Unterlagen als PDF an uns zurück.',
    '',
    'Ohne vollständige Nachweise dürfen wir Zahlungen leider nur unter Vorbehalt leisten.',
    '',
    'Mit freundlichen Grüßen',
    'Viva-Deluxe Gebäudereinigung GmbH',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Portal (Link + PIN)
// ---------------------------------------------------------------------------

/** Neuer Zugang: alter Link/PIN werden ungültig. PIN wird nur jetzt angezeigt. */
export async function createPortalAccess(sql: Sql, supplierId: string, actor: string) {
  const token = randomBytes(24).toString('base64url');
  const weak = (p: string) => /^(\d)\1+$/.test(p) || '0123456789'.includes(p) || '9876543210'.includes(p);
  let pin = String(randomInt(100000, 1000000));
  while (weak(pin)) pin = String(randomInt(100000, 1000000));
  await sql`update app.suppliers set portal_token = ${token}, portal_pin_hash = ${await hashPin(pin)},
                   portal_failed = 0, portal_locked_until = null where id = ${supplierId} and kind = 'nachunternehmer'`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, 'portal_access', 'supplier', ${supplierId})`;
  return { token, pin };
}

export async function revokePortal(sql: Sql, supplierId: string, actor: string) {
  await sql`update app.suppliers set portal_token = null, portal_pin_hash = null where id = ${supplierId}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, 'portal_revoke', 'supplier', ${supplierId})`;
}

export async function portalSupplier(sql: Sql, token: string) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return undefined;
  const [s] = await sql<SupplierRow[]>`
    select * from app.suppliers where portal_token = ${token} and kind = 'nachunternehmer' and active`;
  return s;
}

export async function portalLogin(sql: Sql, token: string, pin: string): Promise<string> {
  const s = await portalSupplier(sql, token);
  if (!s || !s.portal_pin_hash) throw new BusinessError('Link ist ungültig oder abgelaufen');
  if (s.portal_locked_until && s.portal_locked_until > new Date())
    throw new BusinessError(`Zu viele Fehlversuche – bitte in ${LOCK_MINUTES} Minuten erneut versuchen`);
  if (!(await verifyHash(pin.trim(), s.portal_pin_hash))) {
    await sql`update app.suppliers set portal_failed = portal_failed + 1,
                     portal_locked_until = case when portal_failed + 1 >= ${MAX_ATTEMPTS}
                                                then now() + make_interval(mins => ${LOCK_MINUTES}) end
               where id = ${s.id}`;
    throw new BusinessError('PIN falsch');
  }
  await sql`update app.suppliers set portal_failed = 0, portal_locked_until = null where id = ${s.id}`;
  return s.id;
}

// ---------------------------------------------------------------------------
// Aufträge an Nachunternehmer
// ---------------------------------------------------------------------------

export const SERVICE_KINDS = [
  'Unterhaltsreinigung',
  'Treppenhausreinigung',
  'Glasreinigung',
  'Fassadenreinigung',
  'Grundreinigung',
  'Bauschlussreinigung',
  'Industrie-/Sonderreinigung',
  'Teppichreinigung',
  'Winterdienst',
  'Sonstiges',
];
/** Standard-Kurzbeschreibung je Leistung (wie in der alten App) – wird im Formular vorgeschlagen, bleibt änderbar. */
export const SERVICE_DESCRIPTIONS: Record<string, string> = {
  Unterhaltsreinigung:
    'Unterhaltsreinigung gemäß Leistungsverzeichnis des Objekts: Böden kehren/feucht wischen, Sanitärräume reinigen und desinfizieren, Papierkörbe leeren, Oberflächen in Griffhöhe abstauben, Verbrauchsmaterial auffüllen.',
  Treppenhausreinigung:
    'Treppenhausreinigung: Treppen, Podeste und Flure kehren und feucht wischen, Handläufe und Geländer abwischen, Eingangsbereich und Briefkastenanlage reinigen, Glas der Eingangstüren beidseitig.',
  Glasreinigung:
    'Glasreinigung: Fenster- und Glasflächen beidseitig inkl. Rahmen und Falze, Fensterbänke innen/außen; Arbeiten mit Leiter/Hebebühne nach Absprache, Abdeckung empfindlicher Bereiche.',
  Fassadenreinigung:
    'Fassadenreinigung der vereinbarten Flächen mit geeignetem Verfahren und Mittel, Sicherung des Arbeitsbereichs, Schutz angrenzender Bauteile und Pflanzen.',
  Grundreinigung:
    'Grundreinigung der vereinbarten Bodenflächen: Altpflege entfernen, maschinell reinigen, neutralisieren und – soweit beauftragt – neu einpflegen bzw. beschichten; Möbel rücken und zurückstellen.',
  Bauschlussreinigung:
    'Bauschlussreinigung: Grob- und Feinreinigung nach Bauende, Entfernen von Baustaub, Farb-/Mörtelresten und Aufklebern, Reinigung von Böden, Fenstern, Türen, Sanitär und Einbauten – bezugsfertig.',
  'Industrie-/Sonderreinigung':
    'Industrie-/Sonderreinigung der vereinbarten Bereiche und Anlagen nach Vorgabe des Objekts; Arbeitsschutz und Betriebsanweisungen des Kunden sind einzuhalten.',
  Teppichreinigung:
    'Teppichreinigung der vereinbarten Flächen im Sprühextraktionsverfahren, Fleckenbehandlung vorab, Trocknungszeit beachten; Möbel rücken und zurückstellen.',
  Winterdienst:
    'Winterdienst: Räumen und Streuen der vereinbarten Flächen gemäß Räum- und Streupflicht der Gemeinde und Räumplan des Objekts, Dokumentation jedes Einsatzes (Datum, Uhrzeit, Streumittel).',
  Sonstiges: '',
};

export const FREQUENCY: Record<string, string> = {
  einmalig: 'einmalig',
  woechentlich: 'wöchentlich',
  monatlich: 'monatlich',
  quartalsweise: 'quartalsweise',
  halbjaehrlich: 'halbjährlich',
  jaehrlich: 'jährlich',
};
export const BILLING: Record<string, string> = {
  pauschale_monat: 'Pauschale je Monat',
  pauschale_einsatz: 'Pauschale je Einsatz',
  tag: 'je Tag',
  stunde: 'je Stunde',
};
export const SC_STATUS: Record<string, string> = {
  entwurf: 'Entwurf',
  erteilt: 'erteilt',
  beendet: 'beendet',
  storniert: 'storniert',
};

export interface Subcontract {
  id: string;
  number: string;
  supplier_id: string;
  site_id: string;
  service_kind: string;
  frequency: string;
  billing: string;
  price_cents: bigint;
  max_hours_month: string | null;
  valid_from: string;
  valid_to: string | null;
  description: string | null;
  note: string | null;
  status: 'entwurf' | 'erteilt' | 'beendet' | 'storniert';
  issued_at: Date | null;
  signed_file_path: string | null;
  signed_file_sha256: string | null;
  version: number;
}
export type SubcontractRow = Subcontract & {
  supplier_name: string;
  supplier_no: string;
  site_name: string;
  site_no: string;
  current_price_cents: bigint;
  requested_by: string | null;
  request_note: string | null;
};

const SC_SELECT = (sql: Sql, month: string) => sql`
  select sc.*, sp.name as supplier_name, sp.supplier_no, s.name as site_name, s.site_no,
         coalesce((select p.price_cents from app.subcontract_prices p
                    where p.subcontract_id = sc.id and p.valid_from_month <= ${month}::date
                    order by p.valid_from_month desc limit 1), sc.price_cents) as current_price_cents
    from app.subcontracts sc
    join app.suppliers sp on sp.id = sc.supplier_id
    join app.sites s on s.id = sc.site_id`;

export async function listSubcontracts(sql: Sql, f: { supplierId?: string; siteId?: string } = {}) {
  const month = `${todayBerlin().slice(0, 7)}-01`;
  return sql<SubcontractRow[]>`
    ${SC_SELECT(sql, month)}
     where (${f.supplierId ?? null}::uuid is null or sc.supplier_id = ${f.supplierId ?? null})
       and (${f.siteId ?? null}::uuid is null or sc.site_id = ${f.siteId ?? null})
     order by sc.status = 'erteilt' desc, sc.valid_from desc`;
}

export async function getSubcontract(sql: Sql, id: string) {
  const month = `${todayBerlin().slice(0, 7)}-01`;
  const [sc] = await sql<SubcontractRow[]>`${SC_SELECT(sql, month)} where sc.id = ${id}`;
  if (!sc) return undefined;
  const prices = await sql<
    { valid_from_month: string; price_cents: bigint; reason: string; created_by: string }[]
  >`
    select valid_from_month, price_cents, reason, created_by from app.subcontract_prices
     where subcontract_id = ${id} order by valid_from_month`;
  return { contract: sc, prices };
}

export interface SubcontractInput {
  supplierId: string;
  siteId: string;
  serviceKind: string;
  frequency: string;
  billing: string;
  priceCents: bigint;
  maxHours: string | null;
  validFrom: string;
  validTo: string | null;
  description: string | null;
  note: string | null;
  version?: number | null;
}

export async function saveSubcontract(sql: Sql, id: string, p: SubcontractInput, actor: string) {
  if (!(p.frequency in FREQUENCY)) throw new BusinessError('Bitte Häufigkeit wählen');
  if (!(p.billing in BILLING)) throw new BusinessError('Bitte Abrechnungsart wählen');
  if (!p.serviceKind.trim()) throw new BusinessError('Bitte Leistung angeben');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.validFrom)) throw new BusinessError('Bitte Beginn angeben');
  if (p.validTo && p.validTo < p.validFrom) throw new BusinessError('Ende liegt vor dem Beginn');
  if (p.maxHours && !/^\d{1,5}([.,]\d{1,2})?$/.test(p.maxHours))
    throw new BusinessError('Max. Stunden ungültig');
  const [sup] = await sql<
    { kind: string; active: boolean }[]
  >`select kind, active from app.suppliers where id = ${p.supplierId}`;
  if (!sup || sup.kind !== 'nachunternehmer') throw new BusinessError('Bitte Nachunternehmer wählen');
  await sql.begin(async (tx) => {
    const [cur] = await tx<Subcontract[]>`select * from app.subcontracts where id = ${id} for update`;
    assertVersion(cur?.version, p.version, 'Der Auftrag');
    if (cur && cur.status === 'storniert')
      throw new BusinessError('Stornierte Bestellung kann nicht geändert werden');
    if (cur && cur.status !== 'entwurf') {
      // erteilt/beendet (Ahmed 09.10.: „manche sind als monatlich drin, obwohl es nicht monatlich ist“): Objekt,
      // Leistung, Häufigkeit, Abrechnung, Stunden, Zeitraum, Beschreibung korrigierbar. Nachunternehmer und Preis bleiben
      // (Preisänderung über Nachtrag ab Monat). Alter/neuer Stand ins Protokoll.
      const next = {
        site_id: p.siteId || cur.site_id,
        service_kind: p.serviceKind.trim(),
        frequency: p.frequency,
        billing: p.billing,
        max_hours_month: p.maxHours ? p.maxHours.replace(',', '.') : null,
        valid_from: p.validFrom,
        valid_to: p.validTo,
        description: p.description?.trim() || null,
        note: p.note?.trim() || null,
      };
      const old = cur as unknown as Record<string, unknown>;
      const norm = (v: unknown) => (v === null || v === undefined ? null : String(v).replace(/\.0+$/, ''));
      const changes = Object.fromEntries(
        Object.entries(next)
          .filter(([k, v]) => norm(old[k]) !== norm(v))
          .map(([k, v]) => [k, { alt: old[k] ?? null, neu: v }]),
      );
      if (!Object.keys(changes).length) return;
      await tx`update app.subcontracts set ${tx(next)} where id = ${id}`;
      await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
               values (${actor}, 'update', 'subcontract', ${id}, ${tx.json(changes as never)})`;
      return;
    } else {
      if (!sup.active) throw new BusinessError('Nachunternehmer ist inaktiv/gekündigt');
      const row = {
        supplier_id: p.supplierId,
        site_id: p.siteId,
        service_kind: p.serviceKind.trim(),
        frequency: p.frequency,
        billing: p.billing,
        price_cents: p.priceCents,
        max_hours_month: p.maxHours ? p.maxHours.replace(',', '.') : null,
        valid_from: p.validFrom,
        valid_to: p.validTo,
        description: p.description?.trim() || null,
        note: p.note?.trim() || null,
      };
      if (cur) await tx`update app.subcontracts set ${tx(row)} where id = ${id}`;
      else {
        const number = await nextYearNumber(tx, 'po', 'BE-', p.validFrom.slice(0, 4), 4);
        await tx`insert into app.subcontracts ${tx({ id, number, created_by: actor, ...row })}`;
      }
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id)
             values (${actor}, ${cur ? 'update' : 'create'}, 'subcontract', ${id})`;
  });
}

export async function setSubcontractStatus(
  sql: Sql,
  id: string,
  status: 'erteilt' | 'beendet' | 'storniert',
  actor: string,
) {
  const [sc] = await sql<Subcontract[]>`select * from app.subcontracts where id = ${id}`;
  if (!sc) throw new BusinessError('Auftrag nicht gefunden');
  if (sc.status === status) return;
  const allowed: Record<string, string[]> = {
    entwurf: ['erteilt', 'storniert'],
    erteilt: ['beendet'],
    beendet: [],
    storniert: [],
  };
  if (!allowed[sc.status]!.includes(status))
    throw new BusinessError(`Von „${SC_STATUS[sc.status]}“ nicht möglich`);
  if (status === 'erteilt') {
    const crit = await criticalSupplierIds(sql);
    if (crit.has(sc.supplier_id))
      throw new BusinessError(
        'Pflicht-Nachweise des Nachunternehmers fehlen oder sind abgelaufen – erst vervollständigen',
      );
  }
  await sql`
    update app.subcontracts set status = ${status},
           issued_at = case when ${status} = 'erteilt' then now() else issued_at end,
           valid_to = case when ${status} = 'beendet' then coalesce(valid_to, ${todayBerlin()}::date) else valid_to end
     where id = ${id}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'status', 'subcontract', ${id}, ${sql.json({ status })})`;
}

export async function addPriceChange(
  sql: Sql,
  p: { id: string; subcontractId: string; month: string; priceCents: bigint; reason: string },
  actor: string,
) {
  const [sc] = await sql<Subcontract[]>`select * from app.subcontracts where id = ${p.subcontractId}`;
  if (!sc || sc.status !== 'erteilt') throw new BusinessError('Nachträge nur bei erteilten Aufträgen');
  if (!/^\d{4}-\d{2}$/.test(p.month)) throw new BusinessError('Bitte Monat angeben');
  const first = `${p.month}-01`;
  if (first <= sc.valid_from.slice(0, 7) + '-01')
    throw new BusinessError('Nachtrag muss nach dem Beginnmonat liegen');
  if (!p.reason.trim()) throw new BusinessError('Bitte Grund angeben (z. B. Tariflohnerhöhung)');
  await sql`insert into app.subcontract_prices (id, subcontract_id, valid_from_month, price_cents, reason, created_by)
            values (${p.id}, ${p.subcontractId}, ${first}, ${p.priceCents}, ${p.reason.trim()}, ${actor})
            on conflict do nothing`;
}

export async function uploadSignedSubcontract(deps: Deps, id: string, data: Uint8Array, actor: string) {
  const [sc] = await deps.sql<Subcontract[]>`select * from app.subcontracts where id = ${id}`;
  if (!sc) throw new BusinessError('Auftrag nicht gefunden');
  if (sc.signed_file_path) throw new BusinessError('Unterschriebener Auftrag liegt bereits vor');
  if (data.byteLength > MAX_DOC_BYTES) throw new BusinessError('Datei ist größer als 10 MB');
  const kind = sniff(data);
  const sha = createHash('sha256').update(data).digest('hex');
  const path = `nachunternehmer/${sc.supplier_id}/auftrag-${sc.number}-${sha.slice(0, 12)}.${kind.ext}`;
  const put = await deps.archive.put(path, data);
  await deps.sql`update app.subcontracts set signed_file_path = ${path}, signed_file_sha256 = ${put.sha256}
                 where id = ${id} and signed_file_path is null`;
  await deps.sql`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, 'signed_upload', 'subcontract', ${id})`;
}

function supplierBuyer(s: Supplier): BuyerSnapshot {
  return {
    customerNo: s.supplier_no,
    name: s.name,
    name2: s.contact_name ? `z. Hd. ${s.contact_name}` : null,
    street: s.street ?? '',
    postalCode: s.postal_code ?? '',
    city: s.city ?? '',
    countryCode: 'DE',
    vatId: null,
    leitwegId: null,
    supplierNo: null,
    email: null,
    contactName: null,
    site: null,
  };
}

const PDF_STATUS: Record<Subcontract['status'], string> = {
  entwurf: 'Entwurf',
  erteilt: 'Offen',
  beendet: 'Beendet',
  storniert: 'Storniert',
};

/**
 * Bestellschein an den Nachunternehmer wie die alte App (Ahmed 08.10., Muster BE-2026-0001): Seite 1 Bestellung mit
 * Auftragnehmer, Objekt/Auftrag-Kasten, Kurzfassung der Bedingungen und Unterschrift; Seite 2 Leistungsbeschreibung;
 * danach die vollständigen Auftragsbedingungen und die Bestätigung mit Unterschrift.
 */
export interface SubcontractSignature {
  name: string;
  png: Uint8Array;
  /** 'JJJJ-MM-TT HH:MM' Berliner Zeit */
  at: string;
}

export async function subcontractPdf(sql: Sql, id: string, sig?: SubcontractSignature) {
  const data = await getSubcontract(sql, id);
  if (!data) throw new BusinessError('Auftrag nicht gefunden');
  const { contract: sc, prices } = data;
  const s = (await getSupplier(sql, sc.supplier_id))!;
  const seller = await getSeller(sql);
  const [site] = await sql<{ street: string | null; postal_code: string | null; city: string | null }[]>`
    select street, postal_code, city from app.sites where id = ${sc.site_id}`;
  const date = sc.issued_at
    ? sc.issued_at.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' })
    : todayBerlin();
  const dateDe = formatDateDe(date)
    .replace(/^0/, '')
    .replace(/\.0(\d)\./, '.$1.');
  const unit =
    sc.billing === 'stunde'
      ? 'Std.'
      : sc.billing === 'pauschale_einsatz'
        ? 'Einsatz'
        : sc.billing === 'tag'
          ? 'Tag'
          : 'Monat';
  const price = `${formatEuro(sc.current_price_cents as Cents)} / ${unit}`;
  const d = await FormDoc.create({
    title: `Bestellung ${sc.number}`,
    sideRef: `VD-NU-02 Bestellschein ${sc.number} · Rev. 1.0 · Stand: ${dateDe}`,
    date,
    author: seller.legalName,
    ...(sc.status === 'entwurf' ? { watermark: 'ENTWURF' } : {}),
  });
  d.y += 4;
  d.titleRight(`BESTELLUNG  ${sc.number}`, 'Bitte Bestellnummer auf jeder Rechnung angeben.');
  d.y += 8;
  d.text('Auftragnehmer (Nachunternehmer):', FORM_X.L, d.y + 6, {
    size: 7.5,
    bold: true,
    color: FORM_COLORS.MUT,
  });
  d.y += 22;
  d.text(`[${s.supplier_no}]  ${s.name}`, FORM_X.L, d.y, { size: 12, bold: true });
  d.y += 14;
  for (const l of [
    s.contact_name ? `z.Hd. ${s.contact_name}` : '',
    s.street ?? '',
    `${s.postal_code ?? ''} ${s.city ?? ''}`.trim(),
  ].filter(Boolean)) {
    d.text(l, FORM_X.L, d.y, { size: 9.5 });
    d.y += 12;
  }
  if (s.phone) {
    d.text(`Tel.: ${s.phone}`, FORM_X.L, d.y, { size: 8.5, color: FORM_COLORS.MUT });
    d.y += 11;
  }
  if (s.email) {
    d.text(s.email, FORM_X.L, d.y, { size: 8.5, color: FORM_COLORS.MUT });
    d.y += 11;
  }
  d.y += 8;
  const hourly = sc.billing === 'stunde';
  d.kvBox([
    { k: 'Objekt / Auftrag:', v: sc.site_name, strong: true },
    {
      k: 'Adresse:',
      v: [site?.street, `${site?.postal_code ?? ''} ${site?.city ?? ''}`.trim()].filter(Boolean).join(', '),
    },
    { k: 'Häufigkeit:', v: FREQUENCY[sc.frequency] ?? sc.frequency, k2: 'Kostenstelle:', v2: sc.site_no },
    { k: 'Leistungsart:', v: sc.service_kind },
    {
      k: 'Zeitraum:',
      v: `${formatDateDe(sc.valid_from)}${sc.valid_to ? ` bis ${formatDateDe(sc.valid_to)}` : ' (unbefristet)'}`,
    },
    { k: 'Status:', v: PDF_STATUS[sc.status] },
    hourly
      ? {
          k: 'Stundensatz:',
          v: price,
          k2: 'Angenommene Std.:',
          v2: sc.max_hours_month ? `${sc.max_hours_month.replace('.', ',')} / Monat` : 'n. Aufmaß',
        }
      : { k: 'Preis:', v: price },
    {
      k: 'Gesamtbetrag:',
      v: hourly
        ? sc.max_hours_month
          ? `max. ${formatEuro(((sc.current_price_cents * BigInt(Math.round(Number(sc.max_hours_month) * 100))) / 100n) as Cents)} / Monat`
          : '- nach erfassten Stunden -'
        : price,
      accent: true,
    },
    { k: 'Bestelldatum:', v: formatDateDe(date) },
  ]);
  // Kompakt auf höchstens 2 Seiten (Ahmed 09.10.): Seite 1 Auftrag + Leistungsbeschreibung,
  // dann Auftragsbedingungen zweispaltig und EINE Unterschrift für Bestellung und Bedingungen.
  if (sc.description || prices.length) {
    d.text('Leistungsbeschreibung', FORM_X.L, d.y + 4, { size: 9.5, bold: true });
    d.y += 12;
    if (sc.description) d.para(sc.description, { size: 8.8 });
    for (const p of prices)
      d.para(
        `Preisnachtrag ab ${formatDateDe(p.valid_from_month).slice(3)}: ${formatEuro(p.price_cents as Cents)} / ${unit} (${p.reason})`,
        { size: 8.5 },
      );
    d.y += 4;
  }
  d.ensure(120);
  d.heading('Auftragsbedingungen für Nachunternehmer', 10.5);
  d.para(`Bestandteil der Bestellung ${sc.number}, ergänzend zum Rahmenvertrag.`, {
    size: 7.6,
    color: FORM_COLORS.MUT,
  });
  d.columns(NU_CONDITIONS);
  d.ensure(80);
  d.y += 4;
  d.para(
    `Der Auftragnehmer nimmt die Bestellung ${sc.number} an und erkennt die vorstehenden Auftragsbedingungen als verbindlichen Bestandteil an.`,
    { size: 8.5, bold: true },
  );
  if (sig) {
    const img = await d.embedPng(sig.png);
    d.signatures('Ort, Datum', `Unterschrift Auftragnehmer: ${sig.name}`, {
      leftText: `München, den ${formatDateDe(sig.at.slice(0, 10))}`,
      png: img,
    });
    d.para(
      `Elektronisch unterschrieben von ${sig.name} für ${s.name} am ${formatDateDe(sig.at.slice(0, 10))} um ${sig.at.slice(11, 16)} Uhr (Unterschrift auf dem Gerät von Viva-Deluxe).`,
      { size: 7.5, color: FORM_COLORS.MUT },
    );
  } else
    d.signatures('Ort, Datum', 'Unterschrift Auftragnehmer / Stempel', {
      leftText: `München, den ${dateDe}`,
    });
  return d.save();
}

/**
 * Nachunternehmer unterschreibt die Bestellung am Handy/Tablet (Ahmed 09.10.: statt Scan hochladen). Erzeugt den
 * Bestellschein mit Unterschrift, legt ihn und die Unterschrift write-once ab und hinterlegt ihn als unterschriebenen
 * Auftrag. Einfache elektronische Signatur – Beweismittel für die Annahme, keine Schriftform.
 */
export async function signSubcontract(
  deps: Deps,
  id: string,
  p: { name: string; png: Uint8Array },
  actor: string,
) {
  const [sc] = await deps.sql<Subcontract[]>`select * from app.subcontracts where id = ${id}`;
  if (!sc) throw new BusinessError('Auftrag nicht gefunden');
  if (sc.signed_file_path) throw new BusinessError('Unterschriebener Auftrag liegt bereits vor');
  if (sc.status !== 'erteilt') throw new BusinessError('Bitte den Auftrag zuerst erteilen');
  const name = p.name.trim();
  if (name.length < 3) throw new BusinessError('Bitte den Namen des Unterzeichners angeben');
  if (p.png.byteLength < 200 || p.png.byteLength > 2_000_000)
    throw new BusinessError('Unterschrift fehlt – bitte im Feld unterschreiben');
  const at = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 16);
  const pdf = await subcontractPdf(deps.sql, id, { name, png: p.png, at });
  const sha = createHash('sha256').update(pdf).digest('hex');
  const base = `nachunternehmer/${sc.supplier_id}/auftrag-${sc.number}`;
  await deps.archive.put(
    `${base}-unterschrift-${createHash('sha256').update(p.png).digest('hex').slice(0, 12)}.png`,
    p.png,
  );
  const path = `${base}-signiert-${sha.slice(0, 12)}.pdf`;
  const put = await deps.archive.put(path, pdf);
  const done =
    await deps.sql`update app.subcontracts set signed_file_path = ${path}, signed_file_sha256 = ${put.sha256}
                               where id = ${id} and signed_file_path is null returning id`;
  if (!done.length) throw new BusinessError('Unterschriebener Auftrag liegt bereits vor');
  await deps.sql`insert into app.audit_log (actor, action, entity, entity_id, details)
                 values (${actor}, 'signed_digital', 'subcontract', ${id}, ${deps.sql.json({ name, at })})`;
}

// ---------------------------------------------------------------------------
// Soll/Ist je Monat
// ---------------------------------------------------------------------------

export async function monthOverview(sql: Sql, month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new BusinessError('Monat ungültig');
  const first = `${month}-01`;
  const rows = await sql<
    (SubcontractRow & { month_price_cents: bigint; ist_cents: bigint | null; invoices: string | null })[]
  >`
    with sc as (${SC_SELECT(sql, first)}
      where sc.status in ('erteilt', 'beendet') and sc.valid_from < (${first}::date + interval '1 month')
        and (sc.valid_to is null or sc.valid_to >= ${first}::date))
    select sc.*, sc.current_price_cents as month_price_cents,
           (select sum(i.net_cents) from app.incoming_invoices i
             where i.service_month = ${first}::date
               and (i.subcontract_id = sc.id or (i.subcontract_id is null and i.supplier_id = sc.supplier_id and i.site_id = sc.site_id)))::bigint as ist_cents,
           (select string_agg(i.invoice_no, ', ') from app.incoming_invoices i
             where i.service_month = ${first}::date
               and (i.subcontract_id = sc.id or (i.subcontract_id is null and i.supplier_id = sc.supplier_id and i.site_id = sc.site_id))) as invoices
      from sc order by sc.supplier_name, sc.site_name`;
  return rows.map((r) => {
    // Soll nur bei Monatspauschale (sonst nach Aufwand; Stunden: Obergrenze × Preis)
    const soll =
      r.billing === 'pauschale_monat'
        ? r.month_price_cents
        : r.billing === 'stunde' && r.max_hours_month
          ? (r.month_price_cents * BigInt(Math.round(Number(r.max_hours_month) * 100))) / 100n
          : null;
    const diff = soll !== null && r.ist_cents !== null ? r.ist_cents - soll : null;
    const state =
      r.ist_cents === null
        ? 'fehlt'
        : diff === null
          ? 'erfasst'
          : r.billing === 'stunde'
            ? diff > 0n
              ? 'ueber'
              : 'ok'
            : diff === 0n
              ? 'ok'
              : 'abweichung';
    return { ...r, soll, diff, state };
  });
}

// ---------------------------------------------------------------------------
// Kündigung und Nachweis-Übersicht (PDF)
// ---------------------------------------------------------------------------

export async function terminate(
  sql: Sql,
  supplierId: string,
  p: { date: string; reasons: string[]; note: string | null },
  actor: string,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new BusinessError('Bitte Datum angeben');
  if (!p.reasons.length) throw new BusinessError('Bitte mindestens einen Grund wählen');
  const reason = [...p.reasons, ...(p.note?.trim() ? [p.note.trim()] : [])].join('; ');
  await sql.begin(async (tx) => {
    const [s] = await tx<
      { kind: string }[]
    >`select kind from app.suppliers where id = ${supplierId} for update`;
    if (s?.kind !== 'nachunternehmer') throw new BusinessError('Nachunternehmer nicht gefunden');
    await tx`update app.suppliers set terminated_on = ${p.date}, termination_reason = ${reason}, active = false
              where id = ${supplierId}`;
    // laufende Aufträge enden mit der Kündigung, noch nicht begonnene Entwürfe werden storniert
    await tx`update app.subcontracts set valid_to = ${p.date}
              where supplier_id = ${supplierId} and status = 'erteilt' and (valid_to is null or valid_to > ${p.date})
                and valid_from <= ${p.date}`;
    await tx`update app.subcontracts set status = 'storniert' where supplier_id = ${supplierId} and status = 'entwurf'`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'terminate', 'supplier', ${supplierId}, ${tx.json({ date: p.date, reason })})`;
  });
}

export async function revokeTermination(sql: Sql, supplierId: string, actor: string) {
  await sql`update app.suppliers set terminated_on = null, termination_reason = null, active = true where id = ${supplierId}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, 'terminate_revoke', 'supplier', ${supplierId})`;
}

export async function terminationPdf(sql: Sql, supplierId: string) {
  const s = (await getSupplier(sql, supplierId)) as SupplierRow | undefined;
  if (!s?.terminated_on) throw new BusinessError('Keine Kündigung erfasst');
  const contracts = (await listSubcontracts(sql, { supplierId })).filter(
    (c) => c.valid_to === s.terminated_on,
  );
  return renderLetterPdf({
    title: 'Kündigung der Zusammenarbeit',
    date: todayBerlin(),
    info: [['Lieferanten-Nr.', s.supplier_no]],
    seller: await getSeller(sql),
    buyer: supplierBuyer(s),
    intro:
      `hiermit kündigen wir den mit Ihnen bestehenden Nachunternehmervertrag sowie alle darauf beruhenden Aufträge ` +
      `fristgerecht zum ${formatDateDe(s.terminated_on)}, hilfsweise zum nächstmöglichen Termin.`,
    columns: [
      { label: 'Auftrag', x: 62.3, align: 'left' },
      { label: 'Objekt / Leistung', x: 150, align: 'left' },
      { label: 'endet am', x: 538.8 },
    ],
    rows: contracts.map((c) => [
      c.number,
      `${c.site_name} – ${c.service_kind}`.slice(0, 50),
      formatDateDe(c.valid_to!),
    ]),
    sums: [],
    total: null,
    paragraphs: [
      'Bitte geben Sie alle überlassenen Schlüssel, Zugangskarten und Arbeitsmittel bis zum Vertragsende zurück und ' +
        'stellen Sie Ihre Schlussrechnung. Offene Nachweise für den Leistungszeitraum bitten wir nachzureichen.',
      'Mit freundlichen Grüßen',
    ],
    signature: null,
  });
}

/** Nachweis-Übersicht je Nachunternehmer (z. B. für Zollprüfung oder Auftraggeber). */
export async function compliancePdf(sql: Sql, supplierId: string) {
  const data = await getSubcontractor(sql, supplierId);
  if (!data) throw new BusinessError('Nachunternehmer nicht gefunden');
  const s = data.supplier;
  return renderLetterPdf({
    title: 'Nachweisübersicht Nachunternehmer',
    date: todayBerlin(),
    info: [
      ['Lieferanten-Nr.', s.supplier_no],
      ['Rechtsform', s.legal_form ? (LEGAL_FORMS[s.legal_form] ?? s.legal_form) : '–'],
      ['Status', OVERALL[data.overall]],
    ],
    seller: await getSeller(sql),
    buyer: supplierBuyer(s),
    greeting: null,
    intro: `Stand der Nachweise am ${formatDateDe(todayBerlin())} (Prüfung durch Viva-Deluxe Gebäudereinigung GmbH).`,
    columns: [
      { label: 'Nachweis', x: 62.3, align: 'left' },
      { label: 'Pflicht', x: 330 },
      { label: 'Status', x: 420 },
      { label: 'gültig bis', x: 538.8 },
    ],
    rows: data.rows.map((r) => [
      r.type.label.slice(0, 46),
      r.required ? 'ja' : 'nein',
      DOC_STATE[r.state],
      r.current?.valid_until
        ? formatDateDe(r.current.valid_until)
        : r.type.valid_months === 0 && r.current
          ? 'einmalig'
          : '–',
    ]),
    sums: [],
    total: null,
    paragraphs: [
      'Die Nachweise liegen im Original-Scan revisionssicher (SHA-256, unveränderbar) bei uns vor und können ' +
        'jederzeit vorgelegt werden.',
    ],
    signature: null,
  });
}

// ---------------------------------------------------------------------------
// Ansprechpartner (mehrere je Lieferant/Nachunternehmer)
// ---------------------------------------------------------------------------

export interface SupplierContact {
  id: string;
  supplier_id: string;
  name: string;
  role: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  note: string | null;
  is_primary: boolean;
  version: number;
}

export async function listSupplierContacts(sql: Sql, supplierId: string) {
  return sql<SupplierContact[]>`
    select * from app.supplier_contacts where supplier_id = ${supplierId} order by is_primary desc, name`;
}

export async function saveSupplierContact(
  sql: Sql,
  id: string,
  supplierId: string,
  p: Omit<SupplierContact, 'id' | 'supplier_id' | 'version'> & { expectedVersion: number | null },
  actor: string,
) {
  if (!p.name.trim()) throw new BusinessError('Bitte Namen angeben');
  if (p.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) throw new BusinessError('E-Mail ungültig');
  await sql.begin(async (tx) => {
    const [cur] = await tx<{ supplier_id: string; version: number }[]>`
      select supplier_id, version from app.supplier_contacts where id = ${id} for update`;
    if (cur && cur.supplier_id !== supplierId)
      throw new BusinessError('Kontakt gehört zu einem anderen Lieferanten');
    assertVersion(cur?.version, p.expectedVersion, 'Der Ansprechpartner');
    const row = {
      name: p.name.trim(),
      role: p.role,
      phone: p.phone,
      mobile: p.mobile,
      email: p.email,
      note: p.note,
      is_primary: p.is_primary,
    };
    if (p.is_primary)
      await tx`update app.supplier_contacts set is_primary = false where supplier_id = ${supplierId} and id <> ${id}`;
    await tx`
      insert into app.supplier_contacts ${tx({ id, supplier_id: supplierId, ...row } as Record<string, unknown>)}
      on conflict (id) do update set ${tx(row as Record<string, unknown>)}`;
    // Hauptkontakt auch in den Stammdaten (Anschreiben, Nachforderung, PDF)
    if (p.is_primary)
      await tx`update app.suppliers set contact_name = ${row.name}, email = coalesce(${row.email}, email),
                      phone = coalesce(${row.phone ?? row.mobile}, phone) where id = ${supplierId}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'save', 'supplier_contact', ${id}, ${tx.json({ supplier_id: supplierId, name: row.name })})`;
  });
}

export async function deleteSupplierContact(sql: Sql, id: string, actor: string) {
  await sql`delete from app.supplier_contacts where id = ${id}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, 'delete', 'supplier_contact', ${id})`;
}
