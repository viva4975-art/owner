import { randomUUID } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
import { todayBerlin } from '../domain/invoice/calc.js';
import type { BuyerSnapshot } from '../domain/invoice/types.js';
import { renderLetterPdf } from '../pdf/invoice-pdf.js';
import {
  type DocumentTemplate,
  type Employee,
  type EmployeePrivate,
  fillTemplate,
  getEmployee,
} from './employees.js';
import { BusinessError } from './errors.js';
import { getSeller } from './masterdata.js';
import { type UploadConfig, storeFile } from './uploads.js';
import type { Deps } from './workflow.js';

/*
 * Briefe an Mitarbeitende aus Vorlagen („Neu aus Vorlage“, Serienbrief) auf dem Briefpapier.
 * Hinweis: Kündigungen, Aufhebungsverträge und Befristungen brauchen die Schriftform (eigenhändige Unterschrift
 * auf Papier) – ein PDF aus der App ersetzt das nicht.
 */

async function template(deps: Deps, id: string) {
  const [t] = await deps.sql<DocumentTemplate[]>`select * from app.document_templates where id = ${id}`;
  if (!t) throw new BusinessError('Vorlage nicht gefunden');
  return t;
}

function buyerOf(e: Employee, p: Partial<EmployeePrivate> | undefined): BuyerSnapshot {
  const anrede = e.salutation && e.salutation !== 'divers' ? `${e.salutation} ` : '';
  return {
    customerNo: e.personnel_no,
    name: `${anrede}${e.first_name} ${e.last_name}`,
    name2: null,
    street: p?.street ?? '',
    postalCode: p?.postal_code ?? '',
    city: p?.city ?? '',
    countryCode: 'DE',
    vatId: null,
    leitwegId: null,
    supplierNo: null,
    email: null,
    contactName: null,
    site: null,
  };
}

function greeting(e: Employee) {
  if (e.salutation === 'Herr') return `Sehr geehrter Herr ${e.last_name},`;
  if (e.salutation === 'Frau') return `Sehr geehrte Frau ${e.last_name},`;
  return `Guten Tag ${e.first_name} ${e.last_name},`;
}

export async function renderTemplateLetter(
  deps: Deps,
  templateId: string,
  employeeId: string,
): Promise<Uint8Array> {
  const t = await template(deps, templateId);
  const data = await getEmployee(deps.sql, employeeId);
  if (!data) throw new BusinessError('Mitarbeiter nicht gefunden');
  const text = fillTemplate(t.body, data.employee, data.priv);
  const paras = text
    .split(/\n\s*\n/)
    .map((x) => x.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
  return renderLetterPdf({
    title: t.title,
    date: todayBerlin(),
    info: [
      ['Datum', todayBerlin().split('-').reverse().join('.')],
      ['Personalnr.', data.employee.personnel_no],
    ],
    seller: await getSeller(deps.sql),
    buyer: buyerOf(data.employee, data.priv),
    greeting: greeting(data.employee),
    intro: paras[0] ?? '',
    columns: [],
    rows: [],
    sums: [],
    total: null,
    paragraphs: [...paras.slice(1), 'Mit freundlichen Grüßen', 'Viva-Deluxe Gebäudereinigung GmbH'],
  });
}

/** Brief aus Vorlage erzeugen und als Personaldokument (write-once) ablegen. Idempotent über fileId. */
export async function createFromTemplate(
  deps: Deps,
  cfg: UploadConfig,
  fileId: string,
  templateId: string,
  employeeId: string,
  actor: string,
) {
  const t = await template(deps, templateId);
  const pdf = await renderTemplateLetter(deps, templateId, employeeId);
  const name = `${t.title.replace(/[^\wäöüÄÖÜß -]+/g, '').trim()}_${todayBerlin()}.pdf`;
  return storeFile(
    deps.sql,
    cfg,
    {
      id: fileId,
      name,
      type: 'application/pdf',
      data: pdf,
      link: { type: 'employee', id: employeeId },
      category: t.category,
    },
    actor,
  );
}

/** Serienbrief: ein PDF mit je einem Brief pro Mitarbeiter (Reihenfolge wie übergeben). */
export async function serialLetter(
  deps: Deps,
  templateId: string,
  employeeIds: string[],
): Promise<Uint8Array> {
  if (!employeeIds.length) throw new BusinessError('Keine Mitarbeitenden ausgewählt');
  if (employeeIds.length > 300) throw new BusinessError('Höchstens 300 Briefe auf einmal');
  const out = await PDFDocument.create();
  for (const id of employeeIds) {
    const one = await PDFDocument.load(await renderTemplateLetter(deps, templateId, id));
    for (const pg of await out.copyPages(one, one.getPageIndices())) out.addPage(pg);
  }
  out.setTitle(`Serienbrief ${(await template(deps, templateId)).title}`);
  return out.save({ useObjectStreams: false });
}

export const newFileId = () => randomUUID();
