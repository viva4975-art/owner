import { createHash } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { renderLetterPdf } from '../pdf/render.js';
import { BusinessError } from './errors.js';
import { buildBuyerSnapshot, type Customer, getCustomer, getSeller } from './masterdata.js';
import { toCsv } from './reports.js';
import { storeFile, type UploadConfig } from './uploads.js';
import type { Deps } from './workflow.js';

/*
 * Kundenliste wie Fortytools: Status-Filter mit Anzahl, Suche, A–Z, Seiten (25 je Seite), Objekte je Kunde,
 * CSV-Download und Serienbrief an alle gefilterten Kunden (jeder Brief zusätzlich in der Kundenakte).
 */

export type CustomerStatus = 'kunde' | 'interessent' | 'ehemalig';
export const CUSTOMER_STATUS: Record<CustomerStatus, string> = {
  kunde: 'Kunde',
  interessent: 'Interessent',
  ehemalig: 'Ehemaliger Kunde',
};
export const PAGE_SIZE = 25;

export type CustomerListRow = Customer & {
  site_count: number;
  open_cents: bigint;
  list_status: CustomerStatus;
};

export interface CustomerFilter {
  status: CustomerStatus | null;
  letter: string | null;
  q: string | null;
}

/** Ehemalig = inaktiv (egal ob vorher Kunde oder Interessent). */
export async function filteredCustomers(sql: Sql, f: CustomerFilter) {
  const all = await sql<CustomerListRow[]>`
    select c.*, (select count(*)::int from app.sites s where s.customer_id = c.id) as site_count,
           coalesce((select sum(o.open_cents) from app.open_items o where o.customer_id = c.id), 0)::bigint as open_cents,
           case when not c.active then 'ehemalig' else c.status end as list_status
      from app.customers c order by lower(c.name)`;
  const counts: Record<CustomerStatus, number> = { kunde: 0, interessent: 0, ehemalig: 0 };
  for (const c of all) counts[c.list_status]++;
  const t = f.q?.trim().toLowerCase() ?? '';
  const rows = all.filter(
    (c) =>
      (!f.status || c.list_status === f.status) &&
      (!f.letter ||
        (f.letter === '#'
          ? !/^[a-zäöü]/i.test(c.name)
          : c.name
              .toUpperCase()
              .replace(/^Ä/, 'A')
              .replace(/^Ö/, 'O')
              .replace(/^Ü/, 'U')
              .startsWith(f.letter))) &&
      (!t ||
        `${c.name} ${c.name2 ?? ''} ${c.customer_no} ${c.city} ${c.street} ${c.postal_code}`
          .toLowerCase()
          .includes(t)),
  );
  return { rows, counts, total: all.length };
}

export async function sitesOf(sql: Sql, customerIds: string[]) {
  if (!customerIds.length)
    return new Map<string, { id: string; site_no: string; name: string; active: boolean }[]>();
  const rows = await sql<
    { id: string; customer_id: string; site_no: string; name: string; active: boolean }[]
  >`
    select id, customer_id, site_no, name, active from app.sites
     where customer_id = any(${customerIds}::uuid[]) order by active desc, length(site_no), site_no`;
  const m = new Map<string, { id: string; site_no: string; name: string; active: boolean }[]>();
  for (const r of rows) m.set(r.customer_id, [...(m.get(r.customer_id) ?? []), r]);
  return m;
}

export function customersCsv(rows: CustomerListRow[]): string {
  return toCsv(
    [
      'Kundennummer',
      'Status',
      'Name',
      'Zusatz',
      'Straße',
      'PLZ',
      'Ort',
      'Ansprechpartner',
      'E-Mail',
      'Rechnungs-E-Mails',
      'Leitweg-ID',
      'Rechnungsformat',
      'Objekte',
      'Offen (EUR)',
    ],
    rows.map((c) => [
      c.customer_no,
      CUSTOMER_STATUS[c.list_status],
      c.name,
      c.name2 ?? '',
      c.street,
      c.postal_code,
      c.city,
      c.contact_name ?? '',
      c.contact_email ?? '',
      c.invoice_emails.join(', '),
      c.leitweg_id ?? '',
      c.invoice_format,
      c.site_count,
      (Number(c.open_cents) / 100).toFixed(2).replace('.', ','),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Brief an Kunden aus Vorlage / Serienbrief
// ---------------------------------------------------------------------------

export const CUSTOMER_TEMPLATE_FIELDS: [string, string][] = [
  ['firma', 'Firmenname'],
  ['kundennummer', 'Kundennummer'],
  ['ansprechpartner', 'Ansprechpartner'],
  ['strasse', 'Straße'],
  ['plz', 'PLZ'],
  ['ort', 'Ort'],
  ['heute', 'heutiges Datum'],
];

function fill(body: string, c: Customer) {
  const v: Record<string, string> = {
    firma: c.name,
    kundennummer: c.customer_no,
    ansprechpartner: c.contact_name ?? '',
    strasse: c.street,
    plz: c.postal_code,
    ort: c.city,
    heute: formatDateDe(todayBerlin()),
  };
  return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => v[k] ?? m);
}

async function customerTemplate(sql: Sql, id: string) {
  const [t] = await sql<{ id: string; title: string; body: string; audience: string }[]>`
    select id, title, body, audience from app.document_templates where id = ${id} and active`;
  if (!t || t.audience !== 'kunde') throw new BusinessError('Bitte eine Vorlage für Kunden wählen');
  return t;
}

export async function renderCustomerLetter(deps: Deps, templateId: string, customerId: string) {
  const t = await customerTemplate(deps.sql, templateId);
  const c = await getCustomer(deps.sql, customerId);
  if (!c) throw new BusinessError('Kunde nicht gefunden');
  const paras = fill(t.body, c)
    .split(/\n\s*\n/)
    .map((x) => x.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
  return renderLetterPdf({
    title: t.title,
    date: todayBerlin(),
    info: [
      ['Datum', formatDateDe(todayBerlin())],
      ['Kundennr.', c.customer_no],
    ],
    seller: await getSeller(deps.sql),
    buyer: await buildBuyerSnapshot(deps.sql, customerId, null),
    intro: paras[0] ?? '',
    columns: [],
    rows: [],
    sums: [],
    total: null,
    paragraphs: [...paras.slice(1), 'Mit freundlichen Grüßen', 'Viva-Deluxe Gebäudereinigung GmbH'],
  });
}

const uuidOf = (s: string) => {
  const h = createHash('md5').update(s).digest('hex').split('');
  h[12] = '4';
  h[16] = '89ab'[parseInt(h[16]!, 16) % 4]!;
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

/**
 * Serienbrief: ein PDF zum Drucken; jeder Brief wird zusätzlich in der Kundenakte abgelegt (Dateien, write-once).
 * Feste Datei-IDs aus Lauf + Kunde → doppelt abgeschickt legt nichts doppelt ab.
 */
export async function customerSerialLetter(
  deps: Deps,
  cfg: UploadConfig,
  p: { runId: string; templateId: string; customerIds: string[]; actor: string },
): Promise<Uint8Array> {
  if (!p.customerIds.length) throw new BusinessError('Keine Kunden in der Auswahl');
  if (p.customerIds.length > 300)
    throw new BusinessError('Höchstens 300 Briefe auf einmal – bitte Auswahl eingrenzen');
  const t = await customerTemplate(deps.sql, p.templateId);
  const out = await PDFDocument.create();
  const name = `${t.title.replace(/[^\wäöüÄÖÜß -]+/g, '').trim()}_${todayBerlin()}.pdf`;
  for (const id of p.customerIds) {
    const pdf = await renderCustomerLetter(deps, p.templateId, id);
    await storeFile(
      deps.sql,
      cfg,
      {
        id: uuidOf(`serienbrief:${p.runId}:${id}`),
        name,
        type: 'application/pdf',
        data: pdf,
        link: { type: 'customer', id },
        category: 'Schriftverkehr',
      },
      p.actor,
    );
    const one = await PDFDocument.load(pdf);
    for (const pg of await out.copyPages(one, one.getPageIndices())) out.addPage(pg);
  }
  await deps.sql`insert into app.audit_log (actor, action, entity, entity_id, details)
                 values (${p.actor}, 'serial_letter', 'document_template', ${p.templateId}, ${deps.sql.json({ run: p.runId, count: p.customerIds.length })})`;
  out.setTitle(`Serienbrief ${t.title}`);
  return out.save({ useObjectStreams: false });
}
