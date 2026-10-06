import { randomUUID } from 'node:crypto';
import { type ArchiveStore, sha256 as hashOf } from '../archive/store.js';
import type { Env } from '../config/env.js';
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { type InvoiceDocument, KIND_TITLES } from '../domain/invoice/types.js';
import { formatEuro } from '../domain/money/money.js';
import { generateCii, generateXRechnungUbl, generateZugferd } from '../einvoice/generate.js';
import { type ValidationResult, validateWithKosit } from '../einvoice/kosit.js';
import { MAILER_MISSING, type Mailer, resolveRecipients } from '../mail/mailer.js';
import { renderInvoicePdf } from '../pdf/render.js';
import { BusinessError, getInvoice, issue, loadDocument } from './invoices.js';
import { effectiveBilling } from './masterdata.js';

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
  const [inv] = await deps.sql<{ planned_issue_date: string | null }[]>`
    select planned_issue_date from app.invoices where id = ${id}`;
  const issueDate = inv?.planned_issue_date ?? todayBerlin();
  const doc = await loadDocument(deps.sql, id, { number: 'ENTWURF', issueDate, dueDate: issueDate });
  try {
    return await validateBoth(doc, deps.env);
  } catch (err) {
    if (err instanceof Error && /KoSIT/.test(err.message)) throw new BusinessError(err.message);
    throw new BusinessError(`E-Rechnung kann nicht erzeugt werden: ${(err as Error).message}`);
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
    if (data.invoice.planned_issue_date && data.invoice.planned_issue_date > todayBerlin()) {
      throw new BusinessError(
        `Rechnungsdatum ${data.invoice.planned_issue_date.split('-').reverse().join('.')} liegt in der Zukunft – Ausstellen ist erst ab diesem Tag möglich (oder Rechnungsdatum ändern).`,
      );
    }
    const pre = await preflight(deps, id);
    if (!pre.valid) {
      const msgs = [...pre.ubl.messages, ...pre.cii.messages].filter((m) => m.level === 'error');
      throw new BusinessError(
        `E-Rechnung ist ungültig – nicht ausgestellt:\n${msgs.map((m) => `${m.code}: ${m.text}`).join('\n')}`,
      );
    }
    await issue(deps.sql, id, actor);
  }
  return ensureDocuments(deps, id);
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
    const have = new Set(
      (
        await tx<{ kind: string }[]>`select kind::text from app.invoice_documents where invoice_id = ${id}`
      ).map((r) => r.kind),
    );
    if (['pdf', 'xrechnung_xml', 'zugferd_pdf', 'validation_report'].every((k) => have.has(k))) return;

    const doc = await loadDocument(sql, id);
    const base = `invoices/${inv.issue_date.slice(0, 4)}/${inv.number}`;
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
      await tx`insert into app.invoice_documents (invoice_id, kind, filename, content_type, storage_path, sha256, size_bytes, valid, retain_until)
               values (${id}, ${kind}, ${filename}, ${contentType}, ${path}, ${sha256}, ${size}, ${valid}, ${until})
               on conflict (storage_path) do nothing`;
    };

    const pdf = await renderInvoicePdf(doc);
    if (!have.has('pdf')) await store('pdf', `${inv.number}.pdf`, 'application/pdf', pdf);

    const ublXml = await generateXRechnungUbl(doc);
    const ciiXml = await generateCii(doc);
    const [ubl, cii] = await Promise.all([
      validateWithKosit(ublXml, env.KOSIT_VALIDATOR_URL),
      validateWithKosit(ciiXml, env.KOSIT_VALIDATOR_URL),
    ]);
    if (!have.has('xrechnung_xml')) {
      await store(
        'xrechnung_xml',
        `${inv.number}_xrechnung.xml`,
        'application/xml',
        Buffer.from(ublXml, 'utf8'),
        ubl.valid,
      );
    }
    if (!have.has('zugferd_pdf')) {
      const zugferd = await generateZugferd(doc, pdf, `${inv.number}.pdf`);
      await store('zugferd_pdf', `${inv.number}_zugferd.pdf`, 'application/pdf', zugferd, cii.valid);
    }
    if (!have.has('validation_report')) {
      await store(
        'validation_report',
        `${inv.number}_pruefbericht_ubl.xml`,
        'application/xml',
        Buffer.from(ubl.reportXml, 'utf8'),
        ubl.valid,
      );
      await store(
        'validation_report',
        `${inv.number}_pruefbericht_cii.xml`,
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
}

export async function listDeliveries(sql: Sql, invoiceId: string) {
  return sql<
    DeliveryRow[]
  >`select * from app.invoice_deliveries where invoice_id = ${invoiceId} order by created_at`;
}

function mailText(doc: InvoiceDocument, redirectedFrom: string[] | null): string {
  const title = KIND_TITLES[doc.kind];
  const lines = [
    'Sehr geehrte Damen und Herren,',
    '',
    `anbei erhalten Sie unsere ${title} ${doc.number} vom ${formatDateDe(doc.issueDate)}` +
      (doc.buyer.site ? ` für das Objekt ${doc.buyer.site.name}` : '') +
      '.',
    '',
    `Betrag: ${formatEuro(doc.payableTotal)}` +
      (doc.payableTotal > 0n ? `, zahlbar bis ${formatDateDe(doc.dueDate)}.` : '.'),
    '',
    'Mit freundlichen Grüßen',
    doc.seller.legalName,
    [doc.seller.street, `${doc.seller.postalCode} ${doc.seller.city}`].join(', '),
    doc.seller.phone ? `Tel. ${doc.seller.phone}` : '',
  ];
  if (redirectedFrom) {
    lines.unshift(
      '*** TESTVERSAND – diese Mail ging NICHT an den Kunden. ***',
      `Eigentliche Empfänger: ${redirectedFrom.join(', ') || '(keine hinterlegt)'}`,
      '',
    );
  }
  return lines.join('\n');
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
  opts: { retryFailed?: boolean } = {},
) {
  const { sql, env } = deps;
  const data = await getInvoice(sql, id);
  if (!data) throw new BusinessError('Rechnung nicht gefunden');
  if (data.invoice.status !== 'issued')
    throw new BusinessError('Nur ausgestellte Rechnungen können versendet werden');
  // Empfänger: abweichende Rechnungs-E-Mails des Objekts vor denen des Kunden
  const customer = {
    invoice_emails: (await effectiveBilling(sql, data.invoice.customer_id, data.invoice.site_id)).emails,
  };

  const docs = await ensureDocuments(deps, id);
  if (deps.mailer.configured === false) throw new BusinessError(MAILER_MISSING);
  const pick = (kind: DocRow['kind']) => docs.find((d) => d.kind === kind);
  const format = data.invoice.invoice_format;
  const selected: DocRow[] = [];
  if (format === 'pdf') selected.push(pick('pdf')!);
  if (format === 'zugferd') selected.push(pick('zugferd_pdf')!);
  if (format === 'xrechnung') selected.push(pick('xrechnung_xml')!, pick('pdf')!);
  for (const d of selected) {
    if ((d.kind === 'xrechnung_xml' || d.kind === 'zugferd_pdf') && d.valid !== true) {
      throw new BusinessError('E-Rechnung hat die KoSIT-Prüfung nicht bestanden – Versand gesperrt');
    }
  }
  selected.push(...docs.filter((d) => d.kind === 'attachment'));

  const { actual, redirected } = resolveRecipients(env, customer.invoice_emails);
  const doc = await loadDocument(sql, id);
  const subject = `${redirected ? '[TEST] ' : ''}${KIND_TITLES[doc.kind]} ${doc.number} – ${doc.seller.legalName}`;
  const key = `${id}:initial`;
  const files = selected.map((d) => ({ filename: d.filename, sha256: d.sha256, size: Number(d.size_bytes) }));

  await sql`insert into app.invoice_deliveries (invoice_id, idempotency_key, intended_recipients, actual_recipients, subject, files)
            values (${id}, ${key}, ${customer.invoice_emails}, ${actual}, ${subject}, ${sql.json(files)})
            on conflict (idempotency_key) do nothing`;

  // Übernahme: nur wenn noch nie versucht (attempts = 0) oder ausdrücklich nach Fehler wiederholt.
  const [claimed] = await sql<DeliveryRow[]>`
    update app.invoice_deliveries
       set status = 'pending', attempts = attempts + 1, error = null,
           actual_recipients = ${actual}, subject = ${subject}, files = ${sql.json(files)}
     where idempotency_key = ${key}
       and (attempts = 0 or (status = 'failed' and ${!!opts.retryFailed}))
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
    const attachments = await Promise.all(
      selected.map(async (d) => ({
        filename: d.filename,
        contentType: d.content_type,
        content: await deps.archive.get(d.storage_path),
      })),
    );
    const { messageId } = await deps.mailer.send({
      from: env.MAIL_FROM,
      to: actual,
      subject,
      text: mailText(doc, redirected ? customer.invoice_emails : null),
      attachments,
      messageId: `<${claimed.id}@viva-deluxe-app>`,
    });
    const [sent] = await sql<DeliveryRow[]>`
      update app.invoice_deliveries set status = 'sent', sent_at = now(), message_id = ${messageId}
       where id = ${claimed.id} returning *`;
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${actor}, 'send', 'invoice', ${id}, ${sql.json({ to: actual, redirected, files: files.map((f) => f.filename) })})`;
    return { delivery: sent!, alreadySent: false };
  } catch (err) {
    await sql`update app.invoice_deliveries set status = 'failed', error = ${(err as Error).message} where id = ${claimed.id}`;
    throw new BusinessError(`Versand fehlgeschlagen: ${(err as Error).message}`);
  }
}
