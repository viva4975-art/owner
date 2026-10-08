import { readFile } from 'node:fs/promises';
import type { Sql } from '../db/client.js';
import { addDays } from '../domain/time/holidays.js';
import type { Cents } from '../domain/money/money.js';
import { checkTotals, type IncomingEInvoice, readEInvoice } from '../domain/einvoice/incoming.js';
import { assignInboxFile, INBOX_ID } from './documents.js';
import { BusinessError } from './errors.js';
import { uuidOf } from './fortytools-export-import.js';
import { saveSupplier, suggestSupplierNo } from './inventory.js';
import { type CostCategory, saveIncoming } from './purchasing.js';
import { type FileRow, filePath, storeFile, type UploadConfig } from './uploads.js';

/*
 * Rechnungseingang aus E-Rechnungen: Datei (XRechnung-XML oder ZUGFeRD-PDF) landet write-once im Dokumenteneingang,
 * wird gelesen und nach Prüfung im Büro als Eingangsrechnung übernommen (feste ID je Datei → doppelt absenden legt
 * nichts doppelt an). Lieferant wird über USt-IdNr., IBAN, Steuernummer oder Namen erkannt bzw. aus den
 * Rechnungsdaten angelegt. Freigabe „sachlich und rechnerisch richtig“ bleibt wie bei Papierrechnungen.
 */

const norm = (s: string | null | undefined) => (s ?? '').replace(/[\s./-]/g, '').toUpperCase();
const normName = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .replace(/\b(gmbh|co|kg|ug|ag|ohg|gbr|e\.?\s?k|mbh|haftungsbeschränkt)\b|[^a-z0-9äöüß]/g, '')
    .trim();

export interface SupplierMatch {
  id: string;
  name: string;
  supplier_no: string;
  by: 'USt-IdNr.' | 'IBAN' | 'Name';
}

export async function matchSupplier(sql: Sql, e: IncomingEInvoice): Promise<SupplierMatch | null> {
  const rows = await sql<
    { id: string; name: string; supplier_no: string; vat_id: string | null; iban: string | null }[]
  >`
    select id, name, supplier_no, vat_id, iban from app.suppliers order by active desc, name`;
  const vat = norm(e.seller.vatId);
  const tax = norm(e.seller.taxNumber);
  if (vat || tax) {
    const r = rows.find((s) => s.vat_id && (norm(s.vat_id) === vat || norm(s.vat_id) === tax));
    if (r) return { ...r, by: 'USt-IdNr.' };
  }
  if (e.iban) {
    const r = rows.find((s) => norm(s.iban) === norm(e.iban));
    if (r) return { ...r, by: 'IBAN' };
  }
  const n = normName(e.seller.name);
  if (n.length >= 3) {
    const r = rows.find((s) => normName(s.name) === n);
    if (r) return { ...r, by: 'Name' };
  }
  return null;
}

/** Datei prüfen und in den Dokumenteneingang legen. Keine E-Rechnung → Fehlermeldung, nichts gespeichert. */
export async function uploadEInvoice(
  sql: Sql,
  cfg: UploadConfig,
  p: { id: string; name: string; bytes: Uint8Array },
  actor: string,
): Promise<FileRow> {
  if (!p.bytes.byteLength) throw new BusinessError('Datei ist leer');
  if (p.bytes.byteLength > 30 * 1024 * 1024) throw new BusinessError('Datei ist zu groß (höchstens 30 MB)');
  try {
    await readEInvoice(p.bytes);
  } catch (err) {
    throw new BusinessError(err instanceof RangeError ? err.message : 'Datei ist keine lesbare E-Rechnung');
  }
  const pdf = new TextDecoder().decode(p.bytes.slice(0, 5)) === '%PDF-';
  return storeFile(
    sql,
    cfg,
    {
      id: p.id,
      name: p.name || (pdf ? 'e-rechnung.pdf' : 'e-rechnung.xml'),
      type: pdf ? 'application/pdf' : 'application/xml',
      data: p.bytes,
      link: { type: 'inbox', id: INBOX_ID },
      category: 'E-Rechnung',
    },
    actor,
  );
}

export const incomingIdOf = (fileId: string) => uuidOf(`e-rechnung:${fileId}`);

export interface EInvoiceView {
  file: FileRow;
  e: IncomingEInvoice;
  warnings: string[];
  match: SupplierMatch | null;
  /** schon übernommen (diese Datei) */
  takenId: string | null;
  /** gleiche Rechnungsnummer beim erkannten Lieferanten schon erfasst */
  duplicateId: string | null;
}

export async function loadEInvoice(sql: Sql, cfg: UploadConfig, fileId: string): Promise<EInvoiceView> {
  const [file] = await sql<FileRow[]>`select * from app.files where id = ${fileId} and status = 'complete'`;
  if (!file) throw new BusinessError('Datei nicht gefunden');
  let e: IncomingEInvoice;
  try {
    e = await readEInvoice(new Uint8Array(await readFile(filePath(cfg, file))));
  } catch (err) {
    throw new BusinessError(err instanceof RangeError ? err.message : 'Datei ist keine lesbare E-Rechnung');
  }
  const [seller] = await sql<{ vat_id: string | null; legal_name: string }[]>`
    select vat_id, legal_name from app.company where id = 1`;
  const warnings = checkTotals(e);
  if (seller?.vat_id && norm(seller.vat_id) === norm(e.seller.vatId))
    warnings.unshift('Das ist eine Rechnung von uns selbst (eigene USt-IdNr.) – keine Eingangsrechnung');
  else if (seller?.vat_id && e.buyerVatId && norm(e.buyerVatId) !== norm(seller.vat_id))
    warnings.push(
      `Rechnungsempfänger hat eine andere USt-IdNr. (${e.buyerVatId}) – ist die Rechnung an uns?`,
    );
  if (!e.dueDate) warnings.push('Kein Fälligkeitsdatum – es gilt das Zahlungsziel des Lieferanten');
  const match = await matchSupplier(sql, e);
  if (match) {
    const [sup] = await sql<{ iban: string | null; name: string }[]>`
      select iban, name from app.suppliers where id = ${match.id}`;
    if (match.by === 'IBAN' && normName(sup?.name) !== normName(e.seller.name))
      warnings.push(
        `Lieferant nur über die IBAN erkannt, Name weicht ab („${e.seller.name}“ ↔ „${sup?.name}“) – bitte Auswahl prüfen`,
      );
    if (e.iban && sup?.iban && norm(sup.iban) !== norm(e.iban))
      warnings.push(
        `Achtung: Bankverbindung auf der Rechnung (${e.iban}) weicht von der hinterlegten (${sup.iban}) ab – vor der Zahlung telefonisch beim Lieferanten bestätigen (häufige Betrugsmasche)`,
      );
  }
  const [taken] = await sql<{ id: string }[]>`
    select id from app.incoming_invoices where einvoice_file_id = ${fileId} or id = ${incomingIdOf(fileId)}`;
  const [dup] = match
    ? await sql<{ id: string }[]>`
        select id from app.incoming_invoices where supplier_id = ${match.id} and invoice_no = ${e.invoiceNo}
           and id <> ${incomingIdOf(fileId)}`
    : [];
  return { file, e, warnings, match, takenId: taken?.id ?? null, duplicateId: dup?.id ?? null };
}

export interface TakeOverInput {
  /** vorhandener Lieferant oder 'neu' (aus den Rechnungsdaten anlegen) */
  supplierId: string;
  category: CostCategory;
  siteId: string | null;
  serviceMonth: string | null;
  note: string | null;
}

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

/** Als Eingangsrechnung übernehmen. Idempotent: gleiche Datei → dieselbe Eingangsrechnung. */
export async function takeOverEInvoice(
  sql: Sql,
  cfg: UploadConfig,
  fileId: string,
  input: TakeOverInput,
  actor: string,
): Promise<string> {
  const v = await loadEInvoice(sql, cfg, fileId);
  if (v.takenId) return v.takenId;
  const { e } = v;
  if (v.warnings.some((w) => w.startsWith('Das ist eine Rechnung von uns selbst')))
    throw new BusinessError('Das ist eine eigene Ausgangsrechnung – nicht im Rechnungseingang erfassen');
  if (e.currency !== 'EUR')
    throw new BusinessError(`Währung ${e.currency} – bitte von Hand in Euro erfassen`);
  let supplierId = input.supplierId;
  if (supplierId === 'neu') {
    supplierId = uuidOf(`e-rechnung-lieferant:${fileId}`);
    const [exists] = await sql`select 1 from app.suppliers where id = ${supplierId}`;
    if (!exists) {
      const terms = e.dueDate ? Math.max(0, Math.min(365, daysBetween(e.issueDate, e.dueDate))) : 30;
      const ibanOk = e.iban && /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(e.iban) ? e.iban : null;
      await saveSupplier(
        sql,
        supplierId,
        {
          supplier_no: await suggestSupplierNo(sql),
          name: e.seller.name || 'Lieferant (aus E-Rechnung)',
          kind: 'lieferant',
          street: e.seller.street,
          postal_code: e.seller.postalCode,
          city: e.seller.city,
          email: e.seller.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.seller.email) ? e.seller.email : null,
          vat_id: e.seller.vatId ?? e.seller.taxNumber,
          iban: ibanOk,
          bic: e.bic,
          payment_terms_days: terms,
          notes: 'Angelegt aus E-Rechnung',
          active: 'on',
        },
        null,
        actor,
      );
    }
  } else if (!supplierId) throw new BusinessError('Bitte Lieferant wählen oder neu anlegen');
  const id = incomingIdOf(fileId);
  const month = input.serviceMonth ?? (e.periodStart ?? e.deliveryDate ?? e.issueDate).slice(0, 7);
  const sk = e.skonto && e.skonto.percentBp >= 1 && e.skonto.percentBp <= 1000 ? e.skonto : null;
  await saveIncoming(
    sql,
    id,
    {
      supplierId,
      invoiceNo: e.invoiceNo,
      invoiceDate: e.issueDate,
      dueDate: e.dueDate,
      serviceMonth: month,
      net: e.netCents as Cents,
      vat: e.vatCents as Cents,
      reverseCharge: e.reverseCharge,
      category: input.category,
      siteId: input.siteId,
      purchaseOrderId: null,
      skontoUntil: sk ? addDays(e.issueDate, sk.days) : null,
      skontoPercentBp: sk ? sk.percentBp : null,
      note:
        [
          input.note,
          e.isCorrection ? `Rechnungskorrektur/Storno (Belegart ${e.typeCode})` : null,
          e.precedingInvoice ? `bezieht sich auf Rechnung ${e.precedingInvoice}` : null,
        ]
          .filter(Boolean)
          .join(' · ') || null,
      expectedVersion: null,
    },
    actor,
  );
  const summary = {
    syntax: e.syntax,
    fromPdf: e.fromPdf,
    profile: e.profile,
    typeCode: e.typeCode,
    seller: e.seller,
    iban: e.iban,
    bic: e.bic,
    paymentReference: e.paymentReference,
    paymentTerms: e.paymentTerms,
    periodStart: e.periodStart,
    periodEnd: e.periodEnd,
    buyerReference: e.buyerReference,
    orderReference: e.orderReference,
    precedingInvoice: e.precedingInvoice,
    payableCents: String(e.payableCents),
    prepaidCents: String(e.prepaidCents),
    vat: e.vat.map((x) => ({ ...x, baseCents: String(x.baseCents), taxCents: String(x.taxCents) })),
    lines: e.lines.map((l) => ({
      ...l,
      quantityMilli: String(l.quantityMilli),
      netCents: String(l.netCents),
    })),
    notes: e.notes,
    warnings: v.warnings,
  };
  await sql`update app.incoming_invoices set einvoice_file_id = ${fileId}, einvoice = ${sql.json(summary as never)}
             where id = ${id} and einvoice_file_id is null`;
  await assignInboxFile(sql, fileId, { type: 'incoming_invoice', id, category: 'E-Rechnung' }, actor);
  return id;
}

/** Dateien im Dokumenteneingang, die wie E-Rechnungen aussehen (Kategorie oder Endung). */
export async function pendingEInvoices(sql: Sql) {
  return sql<{ id: string; original_name: string; created_at: Date; uploaded_by: string }[]>`
    select f.id, f.original_name, f.created_at, f.uploaded_by
      from app.file_links l join app.files f on f.id = l.file_id
     where l.entity_type = 'inbox' and l.entity_id = ${INBOX_ID} and f.status = 'complete'
       and l.category = 'E-Rechnung'
     order by f.created_at desc`;
}
