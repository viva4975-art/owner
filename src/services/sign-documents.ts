import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from '@cantoo/pdf-lib';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { pdfFonts } from '../pdf/render.js';
import { BusinessError } from './errors.js';
import { assertSignaturePng } from './orders.js';
import type { Deps } from './workflow.js';

/*
 * Dokumente digital unterschreiben (Mitarbeiter-App).
 *
 * Rechtlich: einfache elektronische Signatur – belegt Kenntnisnahme/Zustimmung (z. B. Unterweisung nach § 12 ArbSchG,
 * Verpflichtung auf Vertraulichkeit nach DSGVO). Für Erklärungen mit gesetzlicher Schriftform ist sie UNWIRKSAM:
 * Kündigung und Auflösungsvertrag (§ 623 BGB), Befristungsabrede (§ 14 Abs. 4 TzBfG), Zeugnis (§ 630 BGB).
 * Solche Dokumente werden abgelehnt.
 *
 * Beweissicherung: Original-PDF write-once mit SHA-256; beim Unterschreiben werden Unterschriftsbild, Zeitpunkt,
 * Name/Personalnummer, IP und Gerät festgehalten und dem Original ein Nachweisblatt angehängt (ebenfalls write-once).
 */

export type SignCategory =
  'unterweisung' | 'datenschutz' | 'arbeitsanweisung' | 'betriebsanweisung' | 'vereinbarung' | 'sonstiges';
export const SIGN_CATEGORY: Record<SignCategory, string> = {
  unterweisung: 'Unterweisung Arbeitsschutz (§ 12 ArbSchG)',
  datenschutz: 'Datenschutz / Verschwiegenheit',
  arbeitsanweisung: 'Arbeitsanweisung / Objektanweisung',
  betriebsanweisung: 'Betriebsanweisung Gefahrstoffe / Maschinen',
  vereinbarung: 'Sonstige Vereinbarung (ohne Schriftformerfordernis)',
  sonstiges: 'Sonstiges zur Kenntnisnahme',
};

const FORBIDDEN = /k(ü|ue)ndig|aufhebung|aufl(ö|oe)sung|befrist|zeugnis/i;
export const FORBIDDEN_HINT =
  'Nicht digital unterschreiben lassen: Kündigung, Aufhebungs-/Auflösungsvertrag (§ 623 BGB), Befristung ' +
  '(§ 14 Abs. 4 TzBfG), Zeugnis (§ 630 BGB) – dafür gilt die Schriftform (Papier, eigenhändig unterschrieben).';
const MAX_PDF = 20 * 1024 * 1024;

export interface SignDocument {
  id: string;
  title: string;
  category: SignCategory;
  description: string | null;
  file_name: string;
  file_path: string;
  file_sha256: string;
  file_size: bigint;
  page_count: number;
  due_date: string | null;
  created_by: string;
  created_at: Date;
}
export type SignDocumentRow = SignDocument & { total: number; signed: number; open: number };

export interface SignRequest {
  id: string;
  document_id: string;
  employee_id: string;
  status: 'offen' | 'unterschrieben' | 'zurueckgezogen';
  created_at: Date;
  signed_at: Date | null;
  signed_name: string | null;
  signature_path: string | null;
  client_ip: string | null;
  user_agent: string | null;
  signed_pdf_path: string | null;
  signed_pdf_sha256: string | null;
}
export type SignRequestRow = SignRequest & {
  employee_name: string;
  personnel_no: string;
  title: string;
  category: SignCategory;
  description: string | null;
  due_date: string | null;
  page_count: number;
};

const reqId = (sql: Sql, docId: string, empId: string) => sql`md5(${'sign:' + docId + ':' + empId})::uuid`;

export async function createSignDocument(
  deps: Deps,
  id: string,
  p: {
    title: string;
    category: SignCategory;
    description: string | null;
    dueDate: string | null;
    fileName: string;
    pdf: Uint8Array;
    employeeIds: string[];
  },
  actor: string,
) {
  const { sql } = deps;
  const title = p.title.trim();
  if (!title) throw new BusinessError('Bitte Titel angeben');
  if (FORBIDDEN.test(title) || FORBIDDEN.test(p.fileName)) throw new BusinessError(FORBIDDEN_HINT);
  if (!(p.category in SIGN_CATEGORY)) throw new BusinessError('Bitte Art des Dokuments wählen');
  if (p.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(p.dueDate)) throw new BusinessError('Frist ungültig');
  if (!p.employeeIds.length)
    throw new BusinessError('Bitte mindestens eine Mitarbeiterin / einen Mitarbeiter wählen');
  const [exists] = await sql`select 1 from app.sign_documents where id = ${id}`;
  if (exists) return; // doppelt abgeschickt
  if (p.pdf.byteLength > MAX_PDF) throw new BusinessError('PDF ist zu groß (max. 20 MB)');
  if (Buffer.from(p.pdf.subarray(0, 5)).toString('latin1') !== '%PDF-') {
    throw new BusinessError('Bitte eine PDF-Datei hochladen');
  }
  let pages: number;
  try {
    pages = (await PDFDocument.load(p.pdf, { updateMetadata: false })).getPageCount();
  } catch {
    throw new BusinessError('PDF lässt sich nicht öffnen (beschädigt oder mit Passwort geschützt)');
  }
  const path = `dokumente/${todayBerlin().slice(0, 4)}/${id}/original.pdf`;
  const { sha256 } = await deps.archive.put(path, p.pdf);
  await sql.begin(async (tx) => {
    const [row] = await tx`
      insert into app.sign_documents (id, title, category, description, file_name, file_path, file_sha256, file_size,
                                      page_count, due_date, created_by)
      values (${id}, ${title}, ${p.category}, ${p.description}, ${p.fileName.slice(0, 200)}, ${path}, ${sha256},
              ${p.pdf.byteLength}, ${pages}, ${p.dueDate}, ${actor})
      on conflict (id) do nothing returning id`;
    if (!row) return;
    await insertRequests(tx as unknown as Sql, id, p.employeeIds, actor);
  });
}

async function insertRequests(sql: Sql, docId: string, employeeIds: string[], actor: string) {
  const emps = await sql<{ id: string }[]>`
    select id from app.employees where id in ${sql(employeeIds)} and status = 'aktiv'`;
  for (const e of emps) {
    await sql`
      insert into app.sign_requests (id, document_id, employee_id, created_by)
      values (${reqId(sql, docId, e.id)}, ${docId}, ${e.id}, ${actor})
      on conflict (document_id, employee_id) do nothing`;
  }
  return emps.length;
}

export async function addRecipients(sql: Sql, docId: string, employeeIds: string[], actor: string) {
  if (!employeeIds.length) return 0;
  return insertRequests(sql, docId, employeeIds, actor);
}

export async function withdrawRequest(sql: Sql, requestId: string, actor: string) {
  await sql`
    update app.sign_requests set status = 'zurueckgezogen', withdrawn_at = now(), withdrawn_by = ${actor}
     where id = ${requestId} and status = 'offen'`;
}

export async function listSignDocuments(sql: Sql) {
  return sql<SignDocumentRow[]>`
    select d.*,
           count(r.id) filter (where r.status <> 'zurueckgezogen')::int as total,
           count(r.id) filter (where r.status = 'unterschrieben')::int as signed,
           count(r.id) filter (where r.status = 'offen')::int as open
      from app.sign_documents d left join app.sign_requests r on r.document_id = d.id
     group by d.id order by d.created_at desc`;
}

const reqSelect = (sql: Sql) => sql`
  select r.*, e.first_name || ' ' || e.last_name as employee_name, e.personnel_no,
         d.title, d.category, d.description, d.due_date, d.page_count
    from app.sign_requests r join app.employees e on e.id = r.employee_id join app.sign_documents d on d.id = r.document_id`;

export async function getSignDocument(sql: Sql, id: string) {
  const [d] = await sql<SignDocument[]>`select * from app.sign_documents where id = ${id}`;
  if (!d) return undefined;
  const requests = await sql<SignRequestRow[]>`
    ${reqSelect(sql)} where r.document_id = ${id} order by r.status, e.last_name, e.first_name`;
  return { doc: d, requests };
}

export async function requestsForEmployee(sql: Sql, employeeId: string) {
  return sql<SignRequestRow[]>`
    ${reqSelect(sql)} where r.employee_id = ${employeeId} and r.status <> 'zurueckgezogen'
     order by (r.status = 'offen') desc, d.due_date nulls last, r.created_at desc`;
}

export async function getRequest(sql: Sql, id: string) {
  const [r] = await sql<SignRequestRow[]>`${reqSelect(sql)} where r.id = ${id}`;
  return r;
}

export async function originalPdf(deps: Deps, docId: string) {
  const [d] = await deps.sql<
    { file_path: string }[]
  >`select file_path from app.sign_documents where id = ${docId}`;
  if (!d) throw new BusinessError('Dokument nicht gefunden');
  return deps.archive.get(d.file_path);
}

/** Mitarbeiter/in unterschreibt (nur eigene, offene Anforderung; zweimal = nichts). */
export async function signRequest(
  deps: Deps,
  requestId: string,
  employeeId: string,
  p: { png: Uint8Array; confirmed: boolean; ip: string | null; userAgent: string | null },
) {
  const { sql } = deps;
  const r = await getRequest(sql, requestId);
  if (!r || r.employee_id !== employeeId) throw new BusinessError('Dokument nicht gefunden');
  if (r.status === 'unterschrieben') return;
  if (r.status !== 'offen') throw new BusinessError('Dieses Dokument wurde zurückgezogen', 'doc_withdrawn');
  if (!p.confirmed)
    throw new BusinessError('Bitte bestätigen, dass Sie das Dokument gelesen haben', 'read_required');
  try {
    assertSignaturePng(p.png);
  } catch {
    throw new BusinessError('Bitte im Feld unterschreiben', 'signature');
  }
  const path = `dokumente/unterschriften/${r.document_id}/${r.employee_id}.png`;
  const { sha256 } = await deps.archive.put(path, p.png);
  const res = await sql`
    update app.sign_requests
       set status = 'unterschrieben', signed_at = now(), signed_name = ${r.employee_name},
           signature_path = ${path}, signature_sha256 = ${sha256},
           client_ip = ${p.ip?.slice(0, 64) ?? null}, user_agent = ${p.userAgent?.slice(0, 300) ?? null}
     where id = ${requestId} and status = 'offen' returning id`;
  if (!res.length) return;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${'mitarbeiter:' + r.personnel_no}, 'sign', 'sign_request', ${requestId},
                    ${sql.json({ document: r.document_id, signature_sha256: sha256 })})`;
  await archiveSignedPdf(deps, requestId);
}

async function archiveSignedPdf(deps: Deps, requestId: string) {
  const r = await getRequest(deps.sql, requestId);
  if (!r || r.status !== 'unterschrieben' || r.signed_pdf_path) return;
  const pdf = await renderSignedPdf(deps, r);
  const path = `dokumente/unterschrieben/${r.document_id}/${r.personnel_no}-${r.id}.pdf`;
  const { sha256 } = await deps.archive.put(path, pdf);
  await deps.sql`update app.sign_requests set signed_pdf_path = ${path}, signed_pdf_sha256 = ${sha256}
                  where id = ${requestId} and signed_pdf_path is null`;
}

/** Original + Nachweisblatt (Unterschrift, Zeitpunkt, Prüfsumme des Originals). */
async function renderSignedPdf(deps: Deps, r: SignRequestRow): Promise<Uint8Array> {
  const [doc] = await deps.sql<SignDocument[]>`select * from app.sign_documents where id = ${r.document_id}`;
  const original = await deps.archive.get(doc!.file_path);
  const pdf = await PDFDocument.load(original, { updateMetadata: false });
  pdf.registerFontkit(fontkit);
  const fonts = await pdfFonts();
  const regular = await pdf.embedFont(fonts.regular);
  const bold = await pdf.embedFont(fonts.bold);
  const png = await pdf.embedPng(await deps.archive.get(r.signature_path!));
  const page = pdf.addPage([595.28, 841.89]);
  const ink = rgb(0.1, 0.1, 0.12);
  const mut = rgb(0.38, 0.4, 0.45);
  let y = 780;
  const line = (text: string, size = 10.5, font = regular, color = ink) => {
    for (const part of wrap(text, 88)) {
      page.drawText(part, { x: 56, y, size, font, color });
      y -= size + 5;
    }
  };
  line('Unterschriftsnachweis', 18, bold, rgb(0.49, 0.08, 0.21));
  y -= 8;
  line(`Dokument: ${doc!.title}`, 11, bold);
  line(`Art: ${SIGN_CATEGORY[doc!.category]}`);
  line(`Datei: ${doc!.file_name} (${doc!.page_count} Seiten)`);
  line(`SHA-256 des Originals: ${doc!.file_sha256}`, 8.5, regular, mut);
  y -= 10;
  line(`Unterschrieben von: ${r.employee_name} (Personalnr. ${r.personnel_no})`, 11, bold);
  const at = r.signed_at!.toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    dateStyle: 'full',
    timeStyle: 'medium',
  });
  line(`Zeitpunkt: ${at} (Serverzeit, Europe/Berlin)`);
  line('Erklärung: „Ich habe das Dokument gelesen und verstanden.“ (vor dem Unterschreiben bestätigt)');
  if (r.client_ip) line(`IP-Adresse: ${r.client_ip}`, 9, regular, mut);
  if (r.user_agent) line(`Gerät/Browser: ${r.user_agent}`, 8.5, regular, mut);
  y -= 16;
  const w = 240;
  const h = (png.height / png.width) * w;
  page.drawImage(png, { x: 56, y: y - h, width: w, height: h });
  y -= h + 6;
  page.drawLine({ start: { x: 56, y }, end: { x: 56 + w, y }, thickness: 0.6, color: mut });
  y -= 14;
  line(r.employee_name, 10, regular, mut);
  y -= 24;
  line(
    'Einfache elektronische Signatur nach eIDAS (Art. 3 Nr. 10). Sie belegt die Kenntnisnahme; für Erklärungen mit ' +
      'gesetzlicher Schriftform (z. B. § 623 BGB, § 14 Abs. 4 TzBfG) ist sie nicht geeignet.',
    8.5,
    regular,
    mut,
  );
  pdf.setTitle(`${doc!.title} – unterschrieben von ${r.employee_name}`);
  pdf.setProducer('Viva-Deluxe Betriebs-App');
  return pdf.save({ useObjectStreams: false });
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/)) {
    if ((cur + ' ' + word).trim().length > width && cur) {
      out.push(cur);
      cur = word;
    } else cur = (cur + ' ' + word).trim();
  }
  if (cur) out.push(cur);
  return out;
}

export async function signedPdf(deps: Deps, requestId: string) {
  const r = await getRequest(deps.sql, requestId);
  if (!r?.signed_pdf_path) throw new BusinessError('Noch nicht unterschrieben');
  return deps.archive.get(r.signed_pdf_path);
}
