import { randomUUID } from 'node:crypto';
import { contactGreeting } from '../domain/letter/greeting.js';
import { type ArchiveStore, sha256 as hashOf } from '../archive/store.js';
import type { Env } from '../config/env.js';
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { type InvoiceDocument, KIND_TITLES } from '../domain/invoice/types.js';
import { formatEuro } from '../domain/money/money.js';
import { generateCii, generateXRechnungUbl, generateZugferd } from '../einvoice/generate.js';
import { rejectReason, type ValidationResult, validateWithKosit } from '../einvoice/kosit.js';
import { MAILER_MISSING, type Mailer, notTransmitted, resolveRecipients } from '../mail/mailer.js';
import { composeMail, loadSignature } from '../mail/compose.js';
import { renderInvoicePdf } from '../pdf/invoice-pdf.js';
import { describeEInvoiceError } from '../einvoice/errors.js';
import {
  type BillAddress,
  BusinessError,
  applyBillAddress,
  getInvoice,
  issue,
  loadDocument,
} from './invoices.js';
import { effectiveBilling, fallbackGroupId } from './masterdata.js';
import { buildMailBundle } from './mail-bundle.js';

export interface Deps {
  sql: Sql;
  env: Env;
  archive: ArchiveStore;
  mailer: Mailer;
}

const RETENTION_YEARS = 10;

function retainUntil(issueDate: string): string {
  // GoBD: 10 Jahre ab Ende des Kalenderjahres der Ausstellung.
  const year = Number(issueDate.slice(0, 4)) + RETENTION_YEARS;
  return `${year}-12-31`;
}

export interface PreflightResult {
  ubl: ValidationResult;
  cii: ValidationResult;
  valid: boolean;
}

/** XRechnung verlangt eine elektronische Adresse des Empfängers (BT-49: Leitweg-ID oder E-Mail). */
const hasEndpoint = (doc: InvoiceDocument) => !!(doc.buyer.leitwegId || doc.buyer.email);
/**
 * PDF-Kunde ohne E-Mail/Leitweg-ID (Versand per Post): keine E-Rechnung, nur PDF archivieren.
 * Rechtlich: ab 2027/2028 bei inländischen Firmenkunden E-Rechnung Pflicht – dann E-Mail nachtragen.
 */
const PDF_ONLY: PreflightResult = {
  ubl: { valid: true, messages: [], reportXml: '' } as unknown as ValidationResult,
  cii: { valid: true, messages: [], reportXml: '' } as unknown as ValidationResult,
  valid: true,
};

async function validateBoth(doc: InvoiceDocument, env: Env): Promise<PreflightResult> {
  const [ublXml, ciiXml] = await Promise.all([generateXRechnungUbl(doc), generateCii(doc)]);
  const [ubl, cii] = await Promise.all([
    validateWithKosit(ublXml, env.KOSIT_VALIDATOR_URL),
    validateWithKosit(ciiXml, env.KOSIT_VALIDATOR_URL),
  ]);
  return { ubl, cii, valid: ubl.valid && cii.valid };
}

/**
 * Vorabprüfung eines Entwurfs: E-Rechnung mit vorläufiger Nummer erzeugen und gegen KoSIT prüfen.
 * Nur wenn gültig, darf ausgestellt (und damit eine Nummer verbraucht) werden.
 */
export async function preflight(deps: Deps, id: string): Promise<PreflightResult> {
  const [inv] = await deps.sql<
    {
      planned_issue_date: string | null;
      invoice_format: string;
      is_internal: boolean;
      customer_id: string;
      site_id: string | null;
      invoice_group_id: string | null;
    }[]
  >`
    select i.planned_issue_date, i.invoice_format::text, c.is_internal, i.customer_id, i.site_id, i.invoice_group_id
      from app.invoices i join app.customers c on c.id = i.customer_id where i.id = ${id}`;
  if (inv?.is_internal)
    throw new BusinessError(
      'Interner Bereich: dafür werden keine Rechnungen ausgestellt – Entwurf bitte löschen.',
    );
  // Entwurf ohne Gruppe (auch über das Objekt keine): Standardgruppe des Kunden festhalten – gilt dann auch beim
  // Ausstellen (Zahlungsziel, Skonto) und Versand
  if (inv && !inv.invoice_group_id) {
    const [s0] = inv.site_id
      ? await deps.sql<{ invoice_group_id: string | null }[]>`
          select invoice_group_id from app.sites where id = ${inv.site_id}`
      : [];
    const gid = s0?.invoice_group_id ? null : await fallbackGroupId(deps.sql, inv.customer_id);
    if (gid) {
      await deps.sql`update app.invoices set invoice_group_id = ${gid} where id = ${id} and status = 'draft'
                       and invoice_group_id is null`;
      inv.invoice_group_id = gid;
    }
  }
  // PEPPOL-EN16931-R110/R111: Leistungszeiträume der Positionen müssen im Leistungszeitraum der Rechnung liegen →
  // Rechnungszeitraum auf alle Positionen erweitern (gilt dann für PDF und E-Rechnung gleich)
  await deps.sql`
    update app.invoices i
       set period_start = least(i.period_start, x.s), period_end = greatest(coalesce(i.period_end, i.period_start), x.e)
      from (select min(period_start) as s, max(coalesce(period_end, period_start)) as e
              from app.invoice_lines where invoice_id = ${id} and period_start is not null) x
     where i.id = ${id} and i.status = 'draft' and i.period_start is not null and x.s is not null
       and (x.s < i.period_start or x.e > coalesce(i.period_end, i.period_start))`;
  const issueDate = inv?.planned_issue_date ?? todayBerlin();
  const doc = await loadDocument(deps.sql, id, { number: 'ENTWURF', issueDate, dueDate: issueDate });
  if (!hasEndpoint(doc)) {
    if (inv?.invoice_format === 'pdf') return PDF_ONLY;
    // Format inzwischen in der Rechnungsgruppe/beim Kunden auf „PDF“ umgestellt (Entwurf ist älter): übernehmen
    const now = inv
      ? await effectiveBilling(deps.sql, inv.customer_id, inv.site_id, inv.invoice_group_id)
      : null;
    if (now?.format === 'pdf') {
      await deps.sql`update app.invoices set invoice_format = 'pdf' where id = ${id} and status = 'draft'`;
      return PDF_ONLY;
    }
    const fmt =
      { zugferd: 'ZUGFeRD', xrechnung: 'XRechnung', pdf: 'PDF' }[(now?.format ?? 'pdf') as 'pdf'] ?? '';
    const where = now?.groupName ? `Rechnungsgruppe „${now.groupName}“` : 'Kunde';
    throw new BusinessError(
      `E-Rechnung nicht möglich: Beim Empfänger fehlt die Rechnungs-E-Mail (bzw. Leitweg-ID). Format laut ${where}: ${fmt}. Bitte unter Kunde → Rechnungsgruppen${now?.groupName ? ` → „${now.groupName}“` : ''} die E-Mail eintragen oder dort Format „PDF“ wählen (Versand per Post) – das Format am Kunden zählt nur ohne Rechnungsgruppe.`,
    );
  }
  try {
    return await validateBoth(doc, deps.env);
  } catch (err) {
    if (err instanceof Error && /KoSIT/.test(err.message)) throw new BusinessError(err.message);
    throw new BusinessError(`E-Rechnung kann nicht erzeugt werden. ${describeEInvoiceError(err)}`);
  }
}

/** Prüfen → Ausstellen → Belege erzeugen und archivieren. */
export async function issueInvoice(deps: Deps, id: string, actor: string) {
  const data = await getInvoice(deps.sql, id);
  if (!data) throw new BusinessError('Rechnung nicht gefunden');
  if (data.invoice.status === 'draft') {
    if (data.invoice.review_required) {
      throw new BusinessError(
        'Rechnung ist als „unfertig“ markiert (Leistung mit „immer unfertig“). Bitte Positionen prüfen und „Geprüft“ setzen.',
      );
    }
    if (!data.invoice.period_start) {
      throw new BusinessError(
        'Bitte den Leistungszeitraum eintragen (Entwurf bearbeiten) – Pflicht für Archiv und Buchhaltung.',
      );
    }
    if (data.invoice.planned_issue_date && data.invoice.planned_issue_date > todayBerlin()) {
      throw new BusinessError(
        `Rechnungsdatum ${data.invoice.planned_issue_date.split('-').reverse().join('.')} liegt in der Zukunft – Ausstellen ist erst ab diesem Tag möglich (oder Rechnungsdatum ändern).`,
      );
    }
    if (data.invoice.work_report_required) await requireSignedWorkReport(deps, id, actor);
    const pre = await preflight(deps, id);
    if (!pre.valid) {
      const lines: string[] = [];
      for (const [name, r] of [
        ['XRechnung UBL', pre.ubl],
        ['XRechnung CII', pre.cii],
      ] as const) {
        if (r.valid) continue;
        const errs = r.messages.filter((m) => m.level === 'error');
        lines.push(
          `${name}: ${errs.length ? [...new Set(errs.map((m) => `${m.code}: ${m.text}`))].join('\n') : rejectReason(r)}`,
        );
      }
      throw new BusinessError(`E-Rechnung ist ungültig – nicht ausgestellt:\n${lines.join('\n')}`);
    }
    await issue(deps.sql, id, actor);
  }
  const docs = await ensureDocuments(deps, id);
  await attachTimesheetsSafe(deps, id, actor);
  await recordNoDelivery(deps, id, actor);
  return docs;
}

/**
 * Geschwärzte Stundennachweise (Leistung mit „Stundennachweis anhängen“) beim Ausstellen anhängen. Fehler halten das
 * Ausstellen nicht auf (Rechnung ist schon ausgestellt) – sie stehen im Protokoll, Anhängen geht an der Rechnung
 * von Hand nach. Dynamischer Import: redacted-timesheet nutzt selbst addAttachment aus diesem Modul.
 */
async function attachTimesheetsSafe(deps: Deps, id: string, actor: string) {
  try {
    const { attachRedactedTimesheets } = await import('./redacted-timesheet.js');
    await attachRedactedTimesheets(deps, id, actor);
  } catch (err) {
    await deps.sql`insert into app.audit_log (actor, action, entity, entity_id, details)
                   values (${actor}, 'timesheet_attach_failed', 'invoice', ${id},
                           ${deps.sql.json({ error: err instanceof Error ? err.message : String(err) })})`;
  }
}

/**
 * Versandweg „kein Versand“ (Rechnungsgruppe, z. B. Landeshauptstadt München): mit dem Ausstellen als versendet
 * vermerken – genau einmal je Rechnung (Kanal „keiner“). Andere Versandwege: nichts tun.
 */
export async function recordNoDelivery(deps: Deps, id: string, actor: string) {
  const { sql } = deps;
  const { channel } = await deliveryChannel(sql, id);
  if (channel !== 'keiner') return false;
  const [inv] = await sql<
    { status: string }[]
  >`select status::text as status from app.invoices where id = ${id}`;
  if (inv?.status !== 'issued') return false;
  const doc = await loadDocument(sql, id);
  const label = 'kein Versand (laut Rechnungsgruppe)';
  const [row] = await sql<{ id: string }[]>`
    insert into app.invoice_deliveries (invoice_id, idempotency_key, status, intended_recipients, actual_recipients,
                                        subject, files, attempts, sent_at, channel, recorded_by)
    values (${id}, ${`${id}:keiner`}, 'sent', ${[label]}, ${[label]},
            ${`Kein Versand: ${KIND_TITLES[doc.kind]} ${doc.number}`}, ${sql.json([])}, 1, now(), 'keiner', ${actor})
    on conflict (idempotency_key) do nothing returning id`;
  return !!row;
}

/**
 * Rechnung mit Arbeitsschein-Pflicht (aus dem Entwurf angelegt): Ausstellen erst, wenn ein zugehöriger Schein vom
 * Kunden unterschrieben ist. Das unterschriebene PDF hängt danach an der Rechnung (falls noch nicht geschehen).
 */
async function requireSignedWorkReport(deps: Deps, id: string, actor: string) {
  const reports = await deps.sql<
    { id: string; number: string; status: string; invoice_id: string | null; pdf_path: string | null }[]
  >`select id, number, status::text as status, invoice_id, pdf_path from app.work_reports
     where (draft_invoice_id = ${id} or invoice_id = ${id}) and cancelled_at is null order by created_at`;
  const signed = reports.filter((r) => r.status === 'unterschrieben' && r.pdf_path);
  if (!signed.length)
    throw new BusinessError(
      reports.length
        ? `Arbeitsschein ${reports.map((r) => r.number).join(', ')} ist noch nicht vom Kunden unterschrieben – Rechnung erst danach fertigstellen.`
        : 'Zu dieser Rechnung gehört ein unterschriebener Arbeitsschein – bitte „Arbeitsschein erstellen“ und unterschreiben lassen.',
    );
  for (const r of signed.filter((x) => !x.invoice_id)) {
    const pdf = await deps.archive.get(r.pdf_path!);
    await addAttachment(deps, id, `Arbeitsschein_${r.number}.pdf`, 'application/pdf', pdf, actor);
    await deps.sql`update app.work_reports set invoice_id = ${id} where id = ${r.id} and invoice_id is null`;
  }
}

interface DocRow {
  id: string;
  kind: 'pdf' | 'zugferd_pdf' | 'xrechnung_xml' | 'validation_report' | 'attachment';
  filename: string;
  content_type: string;
  storage_path: string;
  sha256: string;
  size_bytes: bigint;
  valid: boolean | null;
  retain_until: string;
  revision: number;
  created_at: Date;
}

export async function listDocuments(sql: Sql, invoiceId: string) {
  return sql<
    DocRow[]
  >`select * from app.invoice_documents where invoice_id = ${invoiceId} order by created_at, filename`;
}

/**
 * Erzeugt fehlende Belege einer ausgestellten Rechnung (idempotent, mit Sperre je Rechnung):
 * PDF, XRechnung (UBL), ZUGFeRD (PDF/A-3 + CII) und die KoSIT-Prüfberichte.
 */
export async function ensureDocuments(deps: Deps, id: string): Promise<DocRow[]> {
  const { sql, archive, env } = deps;
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${'docs:' + id}))`;
    const [inv] = await tx<{ status: string; number: string; issue_date: string }[]>`
      select status, number, issue_date from app.invoices where id = ${id}`;
    if (!inv || inv.status !== 'issued') throw new BusinessError('Belege nur für ausgestellte Rechnungen');
    // Fassung: 0 = Original, 1.. = berichtigte Anschrift (Original bleibt unverändert archiviert)
    const [rv] = await tx<{ r: number }[]>`
      select coalesce(max(revision), 0)::int as r from app.invoice_revisions where invoice_id = ${id}`;
    const rev = rv?.r ?? 0;
    const have = new Set(
      (
        await tx<{ kind: string }[]>`select kind::text from app.invoice_documents
                                      where invoice_id = ${id} and revision = ${rev}`
      ).map((r) => r.kind),
    );
    if (['pdf', 'xrechnung_xml', 'zugferd_pdf', 'validation_report'].every((k) => have.has(k))) return;

    const doc = await loadDocument(sql, id);
    const pdfOnly = !hasEndpoint(doc);
    if (pdfOnly && have.has('pdf')) return;
    const base = `invoices/${inv.issue_date.slice(0, 4)}/${inv.number}${rev ? `/berichtigt-${rev}` : ''}`;
    const nm = rev ? `${inv.number}_berichtigt-${rev}` : inv.number;
    const until = retainUntil(inv.issue_date);
    const store = async (
      kind: DocRow['kind'],
      filename: string,
      contentType: string,
      bytes: Uint8Array,
      valid: boolean | null = null,
    ) => {
      // Inhaltsadressiert: ein abgebrochener Lauf hinterlässt höchstens eine verwaiste Datei,
      // überschreibt aber nie etwas (Archiv ist write-once).
      const path = `${base}/${hashOf(bytes).slice(0, 12)}_${filename}`;
      const { sha256, size } = await archive.put(path, bytes);
      await tx`insert into app.invoice_documents (invoice_id, kind, filename, content_type, storage_path, sha256, size_bytes, valid, retain_until, revision)
               values (${id}, ${kind}, ${filename}, ${contentType}, ${path}, ${sha256}, ${size}, ${valid}, ${until}, ${rev})
               on conflict (storage_path) do nothing`;
    };

    const pdf = await renderInvoicePdf(doc);
    if (!have.has('pdf')) await store('pdf', `${nm}.pdf`, 'application/pdf', pdf);
    if (pdfOnly) return; // ohne Empfänger-Adresse keine E-Rechnung (nur PDF, Versand per Post)

    const ublXml = await generateXRechnungUbl(doc);
    const ciiXml = await generateCii(doc);
    const [ubl, cii] = await Promise.all([
      validateWithKosit(ublXml, env.KOSIT_VALIDATOR_URL),
      validateWithKosit(ciiXml, env.KOSIT_VALIDATOR_URL),
    ]);
    if (!have.has('xrechnung_xml')) {
      await store(
        'xrechnung_xml',
        `${nm}_xrechnung.xml`,
        'application/xml',
        Buffer.from(ublXml, 'utf8'),
        ubl.valid,
      );
    }
    if (!have.has('zugferd_pdf')) {
      const zugferd = await generateZugferd(doc, pdf, `${nm}.pdf`);
      await store('zugferd_pdf', `${nm}_zugferd.pdf`, 'application/pdf', zugferd, cii.valid);
    }
    if (!have.has('validation_report')) {
      await store(
        'validation_report',
        `${nm}_pruefbericht_ubl.xml`,
        'application/xml',
        Buffer.from(ubl.reportXml, 'utf8'),
        ubl.valid,
      );
      await store(
        'validation_report',
        `${nm}_pruefbericht_cii.xml`,
        'application/xml',
        Buffer.from(cii.reportXml, 'utf8'),
        cii.valid,
      );
    }
  });
  return listDocuments(sql, id);
}

/** Anhang (Leistungsnachweis, Stundenzettel, Arbeitsschein) archivieren. */
export async function addAttachment(
  deps: Deps,
  invoiceId: string,
  filename: string,
  contentType: string,
  bytes: Uint8Array,
  actor: string,
) {
  const allowed = ['application/pdf', 'image/png', 'image/jpeg'];
  if (!allowed.includes(contentType)) throw new BusinessError('Erlaubt sind PDF, PNG und JPG');
  if (bytes.byteLength > 20 * 1024 * 1024) throw new BusinessError('Anhang größer als 20 MB');
  const data = await getInvoice(deps.sql, invoiceId);
  if (!data) throw new BusinessError('Rechnung nicht gefunden');
  const safe = filename.replace(/[^\w.\-äöüÄÖÜß ]+/g, '_').slice(0, 120) || 'anhang.pdf';
  const year = (data.invoice.issue_date ?? todayBerlin()).slice(0, 4);
  const folder = data.invoice.number ?? `entwurf-${invoiceId}`;
  const path = `invoices/${year}/${folder}/anlagen/${randomUUID()}_${safe}`;
  const { sha256, size } = await deps.archive.put(path, bytes);
  await deps.sql.begin(async (tx) => {
    await tx`insert into app.invoice_documents (invoice_id, kind, filename, content_type, storage_path, sha256, size_bytes, retain_until)
             values (${invoiceId}, 'attachment', ${safe}, ${contentType}, ${path}, ${sha256}, ${size}, ${retainUntil(`${year}-01-01`)})`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'add_attachment', 'invoice', ${invoiceId}, ${tx.json({ filename: safe, sha256 })})`;
  });
}

// ---------------------------------------------------------------------------
// Versand
// ---------------------------------------------------------------------------

export interface DeliveryRow {
  id: string;
  invoice_id: string;
  idempotency_key: string;
  status: 'pending' | 'sent' | 'failed';
  intended_recipients: string[];
  actual_recipients: string[];
  subject: string;
  files: { filename: string; sha256: string; size: number }[];
  message_id: string | null;
  error: string | null;
  attempts: number;
  created_at: Date;
  sent_at: Date | null;
  channel?: 'email' | 'portal' | 'manuell' | 'keiner';
  portal_reference?: string | null;
  recorded_by?: string | null;
}

export async function listDeliveries(sql: Sql, invoiceId: string) {
  return sql<
    DeliveryRow[]
  >`select * from app.invoice_deliveries where invoice_id = ${invoiceId} order by created_at`;
}

/** Text der Rechnungs-Mail (ohne Grußformel/Signatur – die setzt composeMail). */
export function invoiceMailBody(doc: InvoiceDocument): string {
  const title = KIND_TITLES[doc.kind];
  return [
    contactGreeting(doc.buyer.contactName),
    '',
    `anbei erhalten Sie unsere ${title} ${doc.number} vom ${formatDateDe(doc.issueDate)}` +
      (doc.buyer.site ? ` für das Objekt ${doc.buyer.site.name}` : '') +
      '.',
    '',
    `Betrag: ${formatEuro(doc.payableTotal)}` +
      (doc.payableTotal > 0n ? `, zahlbar bis ${formatDateDe(doc.dueDate)}.` : '.'),
  ].join('\n');
}

const testNotice = (redirectedFrom: string[]) =>
  `*** TESTVERSAND – diese Mail ging NICHT an den Kunden. ***\nEigentliche Empfänger: ${redirectedFrom.join(', ') || '(keine hinterlegt)'}`;

/** Betreff einer Rechnungs-Mail. */
export const invoiceMailSubject = (doc: InvoiceDocument, latest: number, test: boolean, again = false) =>
  `${test ? '[TEST] ' : ''}${again ? 'Erneute Zusendung: ' : ''}${latest ? 'Berichtigte Fassung: ' : ''}${KIND_TITLES[doc.kind]} ${doc.number} – ${doc.seller.legalName}`;

/**
 * Anlagen ohne überholte Stundennachweise: Gibt es zu einem Objekt + Zeitraum eine berichtigte Fassung
 * („…_berichtigt_<Zeitstempel>.pdf“), geht nur die neueste mit (die älteren bleiben im Archiv).
 */
export function currentAttachments<T extends { filename: string }>(docs: T[]): T[] {
  const re = /^(Stundennachweis_.+?)(?:_berichtigt_([\d_-]+))?\.pdf$/;
  const newest = new Map<string, string>();
  for (const d of docs) {
    const m = re.exec(d.filename);
    if (!m) continue;
    const v = m[2] ?? '';
    if (!newest.has(m[1]!) || v > newest.get(m[1]!)!) newest.set(m[1]!, v);
  }
  return docs.filter((d) => {
    const m = re.exec(d.filename);
    return !m || (m[2] ?? '') === newest.get(m[1]!);
  });
}

/** Anhänge einer Rechnungs-Mail je Rechnungsformat (aktuelle Fassung) + Anlagen. */
export function invoiceMailDocs(docs: DocRow[], format: string) {
  const latest = docs.reduce((m, d) => (d.kind !== 'attachment' && d.revision > m ? d.revision : m), 0);
  const pick = (kind: DocRow['kind']) => docs.find((d) => d.kind === kind && d.revision === latest);
  const selected: DocRow[] = [];
  if (format === 'pdf') selected.push(pick('pdf')!);
  if (format === 'zugferd') selected.push(pick('zugferd_pdf')!);
  if (format === 'xrechnung') selected.push(pick('xrechnung_xml')!, pick('pdf')!);
  for (const d of selected) {
    if (!d) throw new BusinessError('Beleg fehlt im Archiv');
    if ((d.kind === 'xrechnung_xml' || d.kind === 'zugferd_pdf') && d.valid !== true) {
      throw new BusinessError('E-Rechnung hat die KoSIT-Prüfung nicht bestanden – Versand gesperrt');
    }
  }
  selected.push(...currentAttachments(docs.filter((d) => d.kind === 'attachment')));
  return { latest, selected };
}

/**
 * Dateien der Rechnungs-Mail. Mit „eine Datei je E-Mail“ (Rechnungsgruppe, z. B. Deutsche Bahn) werden Rechnung und
 * Anlagen zu genau einer Datei zusammengefasst (siehe mail-bundle.ts) und die Mail ohne eingebettete Bilder versendet.
 */
async function mailFiles(
  deps: Deps,
  doc: InvoiceDocument,
  docs: DocRow[],
  format: string,
  latest: number,
  selected: DocRow[],
  single: boolean,
) {
  if (!single) {
    return {
      attachments: async () =>
        Promise.all(
          selected.map(async (d) => ({
            filename: d.filename,
            contentType: d.content_type,
            content: await deps.archive.get(d.storage_path),
          })),
        ),
      files: selected.map((d) => ({ filename: d.filename, sha256: d.sha256, size: Number(d.size_bytes) })),
    };
  }
  const pdf = docs.find((d) => d.kind === 'pdf' && d.revision === latest);
  if (!pdf) throw new BusinessError('Rechnungs-PDF fehlt im Archiv');
  const b = await buildMailBundle({
    doc,
    format: doc.buyer.leitwegId || doc.buyer.email ? format : 'pdf',
    main: selected.filter((d) => d.kind !== 'attachment'),
    pdf,
    attachments: selected.filter((d) => d.kind === 'attachment'),
    baseName: latest ? `${doc.number}_berichtigt-${latest}` : doc.number,
    archiveBase: `invoices/${doc.issueDate.slice(0, 4)}/${doc.number}`,
    get: (p) => deps.archive.get(p),
    put: (p, bytes) => deps.archive.put(p, bytes),
    kositUrl: deps.env.KOSIT_VALIDATOR_URL,
  });
  return {
    attachments: async () => [{ filename: b.filename, contentType: b.contentType, content: b.content }],
    files: [
      {
        filename: b.filename,
        sha256: b.sha256,
        size: b.size,
        storage_path: b.storage_path,
        enthaelt: selected.map((d) => d.filename),
      },
    ],
  };
}

/** Eine Datei je E-Mail: nur Text, keine eingebetteten Bilder (Logo/Siegel zählen beim Empfänger sonst als Anhänge). */
function plainIf<T extends { text: string; html?: string; inline?: unknown }>(single: boolean, m: T) {
  return single ? { text: m.text } : m;
}

/** Rechnungsgruppe verlangt genau eine Datei je E-Mail (z. B. Deutsche Bahn). */
export async function singleFileOf(sql: Sql, invoiceId: string): Promise<boolean> {
  const [r] = await sql<{ single_file: boolean | null; gid: string | null; customer_id: string }[]>`
    select g.single_file, g.id as gid, i.customer_id
      from app.invoices i
      left join app.sites s on s.id = i.site_id
      left join app.invoice_groups g on g.id = coalesce(i.invoice_group_id, s.invoice_group_id)
     where i.id = ${invoiceId}`;
  if (!r) return false;
  if (r.gid) return !!r.single_file;
  // ohne Gruppe an Rechnung/Objekt: Gruppe „Standard“ bzw. einzige Gruppe des Kunden (wie effectiveBilling)
  const fb = await fallbackGroupId(sql, r.customer_id);
  if (!fb) return false;
  const [g] = await sql<
    { single_file: boolean }[]
  >`select single_file from app.invoice_groups where id = ${fb}`;
  return !!g?.single_file;
}

/**
 * Test-E-Mail genau wie an den Kunden (Betreff, Text, Signatur, Anhänge) – geht nur an die angegebene Adresse,
 * kein Versandeintrag, die Rechnung gilt nicht als versendet.
 */
export async function sendInvoiceTestMail(deps: Deps, id: string, to: string, actor: string) {
  const { sql, env } = deps;
  const data = await getInvoice(sql, id);
  if (!data || data.invoice.status !== 'issued') throw new BusinessError('Nur ausgestellte Rechnungen');
  if (deps.mailer.configured === false) throw new BusinessError(MAILER_MISSING);
  const docs = await ensureDocuments(deps, id);
  const { latest, selected } = invoiceMailDocs(docs, data.invoice.invoice_format);
  const doc = await loadDocument(sql, id);
  const intended = (
    await effectiveBilling(sql, data.invoice.customer_id, data.invoice.site_id, data.invoice.invoice_group_id)
  ).emails;
  const sig = await loadSignature(sql);
  const single = await singleFileOf(sql, id);
  const mf = await mailFiles(deps, doc, docs, data.invoice.invoice_format, latest, selected, single);
  const attachments = await mf.attachments();
  await deps.mailer.send({
    from: env.MAIL_FROM,
    to: [to],
    subject: invoiceMailSubject(doc, latest, true),
    ...plainIf(
      single,
      composeMail({
        notice: `*** TEST-E-MAIL – so erhält der Kunde die Rechnung. Nicht an den Kunden gegangen, Rechnung gilt nicht als versendet. ***\nEmpfänger beim echten Versand: ${intended.join(', ') || '(keine Rechnungs-E-Mail hinterlegt)'}`,
        body: invoiceMailBody(doc),
        signature: sig,
      }),
    ),
    attachments,
    messageId: `<test-${randomUUID()}@viva-deluxe-app>`,
  });
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'test_mail', 'invoice', ${id}, ${sql.json({ to, files: attachments.map((d) => d.filename) })})`;
  return { files: attachments.map((d) => d.filename), intended };
}

export type DeliveryWay = 'email' | 'portal' | 'keiner';

/** Versandweg der Rechnung aus ihrer Rechnungsgruppe (bzw. der Gruppe des Objekts). */
export async function deliveryChannel(
  sql: Sql,
  invoiceId: string,
): Promise<{ channel: DeliveryWay; portal: string | null }> {
  const [r] = await sql<{ delivery_channel: DeliveryWay | null; portal_name: string | null }[]>`
    select g.delivery_channel, g.portal_name
      from app.invoices i
      left join app.sites s on s.id = i.site_id
      left join app.invoice_groups g on g.id = coalesce(i.invoice_group_id, s.invoice_group_id)
     where i.id = ${invoiceId}`;
  return { channel: r?.delivery_channel ?? 'email', portal: r?.portal_name ?? null };
}

/**
 * Portal-Versand (z. B. Patentamt): Die E-Rechnung wurde von Hand im Portal des Kunden hochgeladen. Vermerk im
 * Versandprotokoll genau einmal je Fassung (Kanal „portal“, Zeitpunkt, Benutzer, Upload-Referenz). Nur mit gültiger
 * (KoSIT-geprüfter) E-Rechnung.
 */
export async function recordPortalUpload(
  deps: Deps,
  id: string,
  p: { reference: string | null; actor: string },
) {
  const { sql } = deps;
  const data = await getInvoice(sql, id);
  if (!data) throw new BusinessError('Rechnung nicht gefunden');
  if (data.invoice.status !== 'issued') throw new BusinessError('Nur ausgestellte Rechnungen');
  const docs = await ensureDocuments(deps, id);
  const latest = docs.reduce((m, d) => (d.kind !== 'attachment' && d.revision > m ? d.revision : m), 0);
  const kind = data.invoice.invoice_format === 'zugferd' ? 'zugferd_pdf' : 'xrechnung_xml';
  const file = docs.find((d) => d.kind === kind && d.revision === latest);
  if (!file || file.valid !== true)
    throw new BusinessError('E-Rechnung hat die KoSIT-Prüfung nicht bestanden – nicht hochladen');
  const { portal } = await deliveryChannel(sql, id);
  const target = portal ?? 'Portal des Kunden';
  const doc = await loadDocument(sql, id);
  const key = latest ? `${id}:portal-berichtigt-${latest}` : `${id}:portal`;
  const files = [{ filename: file.filename, sha256: file.sha256, size: Number(file.size_bytes) }];
  const [row] = await sql<DeliveryRow[]>`
    insert into app.invoice_deliveries (invoice_id, idempotency_key, status, intended_recipients, actual_recipients,
                                        subject, files, attempts, sent_at, channel, portal_reference, recorded_by)
    values (${id}, ${key}, 'sent', ${[target]}, ${[target]},
            ${`Portal-Upload: ${KIND_TITLES[doc.kind]} ${doc.number}`}, ${sql.json(files)}, 1, now(), 'portal',
            ${p.reference}, ${p.actor})
    on conflict (idempotency_key) do nothing returning *`;
  if (!row) return { alreadySent: true };
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${p.actor}, 'portal_upload', 'invoice', ${id}, ${sql.json({ portal: target, reference: p.reference, file: file.filename })})`;
  return { alreadySent: false };
}

/**
 * Versand ohne E-Mail festhalten (Ahmed 08.10.): Post, persönlich übergeben, Fax … Zählt als versendet,
 * genau einmal je Fassung; Protokoll mit Weg, Bemerkung und Benutzer.
 */
export const MANUAL_WAYS = ['Post', 'persönlich übergeben', 'Fax', 'sonstiges'] as const;
export async function recordManualDelivery(
  deps: Deps,
  id: string,
  p: { way: string; note: string | null; actor: string },
) {
  const { sql } = deps;
  if (!(MANUAL_WAYS as readonly string[]).includes(p.way)) throw new BusinessError('Versandweg wählen');
  const data = await getInvoice(sql, id);
  if (!data) throw new BusinessError('Rechnung nicht gefunden');
  if (data.invoice.status !== 'issued') throw new BusinessError('Nur ausgestellte Rechnungen');
  const docs = await ensureDocuments(deps, id);
  const latest = docs.reduce((m, d) => (d.kind !== 'attachment' && d.revision > m ? d.revision : m), 0);
  const pdf = docs.find((d) => d.kind === 'pdf' && d.revision === latest);
  const doc = await loadDocument(sql, id);
  const key = latest ? `${id}:manuell-berichtigt-${latest}` : `${id}:manuell`;
  const files = pdf ? [{ filename: pdf.filename, sha256: pdf.sha256, size: Number(pdf.size_bytes) }] : [];
  const label = [p.way, p.note?.trim()].filter(Boolean).join(' – ');
  const [row] = await sql<DeliveryRow[]>`
    insert into app.invoice_deliveries (invoice_id, idempotency_key, status, intended_recipients, actual_recipients,
                                        subject, files, attempts, sent_at, channel, portal_reference, recorded_by)
    values (${id}, ${key}, 'sent', ${[label]}, ${[label]},
            ${`${p.way}: ${KIND_TITLES[doc.kind]} ${doc.number}`}, ${sql.json(files)}, 1, now(), 'manuell',
            ${p.note?.trim() || null}, ${p.actor})
    on conflict (idempotency_key) do nothing returning *`;
  if (!row) return { alreadySent: true };
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${p.actor}, 'manual_delivery', 'invoice', ${id}, ${sql.json({ way: p.way, note: p.note })})`;
  return { alreadySent: false };
}

/**
 * Versand genau einmal: Ein Versandeintrag je Rechnung (idempotency_key). Der Eintrag wird VOR dem
 * SMTP-Versand auf "pending" gesetzt und nur von genau einem Aufrufer übernommen. Bleibt er nach
 * einem Abbruch "pending", ist der Status unklar → kein automatischer zweiter Versand.
 */
export async function sendInvoice(
  deps: Deps,
  id: string,
  actor: string,
  opts: {
    retryFailed?: boolean;
    /** erneuter Versand (Ahmed 15.10.): eigener Versandeintrag je Formular, Empfänger frei wählbar */
    resend?: { id: string; recipients: string[] };
  } = {},
) {
  const { sql, env } = deps;
  const data = await getInvoice(sql, id);
  if (!data) throw new BusinessError('Rechnung nicht gefunden');
  if (data.invoice.status !== 'issued')
    throw new BusinessError('Nur ausgestellte Rechnungen können versendet werden');
  const resend = opts.resend;
  // Empfänger: abweichende Rechnungs-E-Mails des Objekts vor denen des Kunden
  const customer = {
    invoice_emails: (
      await effectiveBilling(
        sql,
        data.invoice.customer_id,
        data.invoice.site_id,
        data.invoice.invoice_group_id,
      )
    ).emails,
  };

  if (resend) customer.invoice_emails = resend.recipients;
  const channel = resend ? { channel: 'email', portal: null } : await deliveryChannel(sql, id);
  if (channel.channel === 'keiner')
    throw new BusinessError(
      'Für diesen Kunden ist „kein Versand“ eingestellt (Rechnungsgruppe) – die Rechnung gilt mit dem Ausstellen als versendet.',
    );
  if (channel.channel === 'portal')
    throw new BusinessError(
      `Dieser Kunde erhält Rechnungen über ${channel.portal ?? 'sein Portal'} – E-Rechnung herunterladen, dort hochladen und hier „Im Portal hochgeladen“ vermerken.`,
    );
  if (!customer.invoice_emails.length)
    throw new BusinessError(
      'Für diese Rechnung ist keine Rechnungs-E-Mail hinterlegt – bitte in der Rechnungsgruppe eintragen oder „Als versendet markieren“ (z. B. per Post).',
    );
  const docs = await ensureDocuments(deps, id);
  if (deps.mailer.configured === false) throw new BusinessError(MAILER_MISSING);
  const { latest, selected } = invoiceMailDocs(docs, data.invoice.invoice_format);

  const { actual, redirected } = resolveRecipients(env, customer.invoice_emails);
  const doc = await loadDocument(sql, id);
  const subject = invoiceMailSubject(doc, latest, redirected, !!resend);
  // berichtigte Fassung: eigener Versand (genau einmal je Fassung); erneuter Versand: genau einmal je Formular
  const key = resend ? `${id}:erneut-${resend.id}` : latest ? `${id}:berichtigt-${latest}` : `${id}:initial`;
  const single = await singleFileOf(sql, id);
  const mf = await mailFiles(deps, doc, docs, data.invoice.invoice_format, latest, selected, single);
  const files = mf.files;

  await sql`insert into app.invoice_deliveries (invoice_id, idempotency_key, intended_recipients, actual_recipients, subject, files)
            values (${id}, ${key}, ${customer.invoice_emails}, ${actual}, ${subject}, ${sql.json(files)})
            on conflict (idempotency_key) do nothing`;

  // Übernahme: nur wenn noch nie versucht (attempts = 0) oder nach Fehler wiederholt – ausdrücklich, oder von selbst,
  // wenn der Mailserver die Mail nachweislich vor der Übertragung abgelehnt hat (z. B. Rate-Limit).
  const [prev] = await sql<
    { status: string; error: string | null }[]
  >`select status, error from app.invoice_deliveries where idempotency_key = ${key}`;
  const retry = !!opts.retryFailed || (prev?.status === 'failed' && notTransmitted(prev.error));
  const [claimed] = await sql<DeliveryRow[]>`
    update app.invoice_deliveries
       set status = 'pending', attempts = attempts + 1, error = null,
           actual_recipients = ${actual}, subject = ${subject}, files = ${sql.json(files)}
     where idempotency_key = ${key}
       and (attempts = 0 or (status = 'failed' and ${retry}))
     returning *`;
  if (!claimed) {
    const [existing] = await sql<
      DeliveryRow[]
    >`select * from app.invoice_deliveries where idempotency_key = ${key}`;
    if (existing?.status === 'sent') return { delivery: existing, alreadySent: true };
    if (existing?.status === 'failed')
      throw new BusinessError(
        `Letzter Versand fehlgeschlagen: ${existing.error}. Bitte „Erneut versenden“ wählen.`,
      );
    throw new BusinessError(
      'Versand läuft bereits oder Status ist unklar – bitte Postfach prüfen, bevor erneut versendet wird.',
    );
  }

  try {
    const attachments = await mf.attachments();
    const { messageId } = await deps.mailer.send({
      from: env.MAIL_FROM,
      to: actual,
      subject,
      ...plainIf(
        single,
        composeMail({
          notice: redirected ? testNotice(customer.invoice_emails) : null,
          body: resend
            ? invoiceMailBody(doc).replace(/\n\nanbei erhalten Sie/, '\n\nhiermit senden wir Ihnen erneut') +
              '\n\nBitte beachten Sie: Es handelt sich um dieselbe Rechnung, keine neue Forderung – bitte nicht doppelt buchen.'
            : invoiceMailBody(doc),
          signature: await loadSignature(sql),
        }),
      ),
      attachments,
      messageId: `<${claimed.id}@viva-deluxe-app>`,
    });
    const [sent] = await sql<DeliveryRow[]>`
      update app.invoice_deliveries set status = 'sent', sent_at = now(), message_id = ${messageId}
       where id = ${claimed.id} returning *`;
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${actor}, ${resend ? 'resend' : 'send'}, 'invoice', ${id}, ${sql.json({ to: actual, redirected, files: files.map((f) => f.filename) })})`;
    return { delivery: sent!, alreadySent: false };
  } catch (err) {
    await sql`update app.invoice_deliveries set status = 'failed', error = ${(err as Error).message} where id = ${claimed.id}`;
    throw new BusinessError(`Versand fehlgeschlagen: ${(err as Error).message}`);
  }
}

/** E-Mail-Liste aus einem Eingabefeld (Komma, Semikolon, Zeilen) – geprüft, ohne Doppelte */
export function parseEmailList(text: string): string[] {
  const list = [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const bad = list.find((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  if (bad) throw new BusinessError(`E-Mail ungültig: ${bad}`);
  if (!list.length) throw new BusinessError('Bitte mindestens eine E-Mail-Adresse angeben');
  return list;
}

/**
 * Rechnung erneut per E-Mail versenden (z. B. Kunde hat sie nicht erhalten oder nennt eine neue Adresse). Eigener
 * Versandeintrag mit fester ID je Formular → doppelt absenden schickt nichts doppelt. Optional werden die Adressen
 * dauerhaft in der Rechnungsgruppe der Rechnung gespeichert (ohne Gruppe: beim Kunden).
 */
export async function resendInvoice(
  deps: Deps,
  id: string,
  actor: string,
  p: { resendId: string; recipients: string; saveToGroup: boolean },
) {
  const { sql } = deps;
  const recipients = parseEmailList(p.recipients);
  const res = await sendInvoice(deps, id, actor, { resend: { id: p.resendId, recipients } });
  if (p.saveToGroup) {
    const [inv] = await sql<{ customer_id: string; gid: string | null }[]>`
      select i.customer_id, coalesce(i.invoice_group_id, s.invoice_group_id) as gid
        from app.invoices i left join app.sites s on s.id = i.site_id where i.id = ${id}`;
    if (inv?.gid) await sql`update app.invoice_groups set bill_emails = ${recipients} where id = ${inv.gid}`;
    else if (inv)
      await sql`update app.customers set invoice_emails = ${recipients} where id = ${inv.customer_id}`;
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${actor}, 'invoice_emails', ${inv?.gid ? 'invoice_group' : 'customer'},
                      ${inv?.gid ?? inv?.customer_id ?? id}, ${sql.json({ emails: recipients, from_invoice: id })})`;
  }
  return res;
}

/**
 * Anschrift einer ausgestellten Rechnung berichtigen (Fortytools „Adresse ändern“). Rechtlich: Berichtigung durch den
 * Rechnungsaussteller (§ 31 Abs. 5 UStDV) – nur Anschrift/Schreibweise desselben Empfängers. Ein anderer
 * Rechnungsempfänger ist keine Berichtigung → Storno und neue Rechnung. Die Originalbelege bleiben unverändert im
 * Archiv; die berichtigte Fassung (PDF, XRechnung, ZUGFeRD) wird vorher gegen KoSIT geprüft und zusätzlich archiviert.
 */
export async function reviseInvoiceAddress(
  deps: Deps,
  id: string,
  address: BillAddress,
  reason: string,
  actor: string,
  revId: string,
) {
  const { sql } = deps;
  if (!reason.trim()) throw new BusinessError('Bitte den Grund der Berichtigung angeben');
  const [done] = await sql`select 1 from app.invoice_revisions where id = ${revId}`;
  if (done) return;
  const data = await getInvoice(sql, id);
  if (!data || data.invoice.status !== 'issued')
    throw new BusinessError(
      'Anschrift berichtigen nur bei ausgestellten Rechnungen – im Entwurf direkt ändern',
    );
  const current = await loadDocument(sql, id);
  const buyer = applyBillAddress(current.buyer, address);
  const check = await validateBoth({ ...current, buyer }, deps.env);
  if (!check.valid)
    throw new BusinessError('Berichtigte E-Rechnung besteht die KoSIT-Prüfung nicht – nichts geändert');
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${'docs:' + id}))`;
    const [r] = await tx<{ n: number }[]>`
      select coalesce(max(revision), 0)::int + 1 as n from app.invoice_revisions where invoice_id = ${id}`;
    await tx`insert into app.invoice_revisions (id, invoice_id, revision, buyer_snapshot, reason, created_by)
             values (${revId}, ${id}, ${r!.n}, ${tx.json(buyer as never)}, ${reason.trim()}, ${actor})`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'address_revision', 'invoice', ${id}, ${tx.json({ revision: r!.n, reason: reason.trim() })})`;
  });
  await ensureDocuments(deps, id);
}
