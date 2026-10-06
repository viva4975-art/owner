import { zipSync } from 'fflate';
import type { Sql } from '../db/client.js';
import { sha256 } from '../archive/store.js';
import { BusinessError } from './errors.js';
import type { Deps } from './workflow.js';

/*
 * Rechnungsarchiv nach Leistungszeitraum (Monat des Leistungsbeginns; ohne Zeitraum: Rechnungsdatum).
 * Belege kommen aus dem write-once-Archiv; beim ZIP wird jede Datei gegen ihre SHA-256 geprüft.
 */

export interface ArchiveRow {
  id: string;
  number: string;
  kind: string;
  issue_date: string;
  period_start: string | null;
  period_end: string | null;
  customer_name: string;
  customer_no: string;
  site_name: string | null;
  net_cents: bigint;
  gross_cents: bigint;
  month: string; // JJJJ-MM des Leistungszeitraums
  docs: { id: string; kind: string; filename: string }[];
}

export async function archiveYear(
  sql: Sql,
  year: number,
  q: string | null = null,
  by: 'leistung' | 'datum' = 'leistung',
) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new BusinessError('Jahr ungültig');
  const rows = await sql<ArchiveRow[]>`
    select i.id, i.number, i.kind::text, i.issue_date, i.period_start, i.period_end, c.name as customer_name,
           c.customer_no, s.name as site_name, i.net_cents, i.gross_cents,
           to_char(${by === 'datum' ? sql`i.issue_date` : sql`coalesce(i.period_start, i.issue_date)`}, 'YYYY-MM') as month,
           coalesce((select json_agg(json_build_object('id', d.id, 'kind', d.kind, 'filename', d.filename) order by d.kind)
                       from app.invoice_documents d where d.invoice_id = i.id and d.kind <> 'validation_report'), '[]') as docs
      from app.invoices i join app.customers c on c.id = i.customer_id left join app.sites s on s.id = i.site_id
     where i.status = 'issued'
       and extract(year from ${by === 'datum' ? sql`i.issue_date` : sql`coalesce(i.period_start, i.issue_date)`}) = ${year}
       and (${q}::text is null or c.name ilike ${'%' + (q ?? '') + '%'} or i.number ilike ${'%' + (q ?? '') + '%'}
            or coalesce(s.name, '') ilike ${'%' + (q ?? '') + '%'})
     order by month desc, i.number desc`;
  const months = new Map<string, { month: string; rows: ArchiveRow[]; net: bigint; gross: bigint }>();
  for (const r of rows) {
    const m = months.get(r.month) ?? { month: r.month, rows: [], net: 0n, gross: 0n };
    m.rows.push(r);
    m.net += r.net_cents;
    m.gross += r.gross_cents;
    months.set(r.month, m);
  }
  const years = await sql<{ y: number }[]>`
    select distinct extract(year from coalesce(period_start, issue_date))::int as y
      from app.invoices where status = 'issued' order by y desc`;
  return { months: [...months.values()], years: years.map((y) => y.y) };
}

/** ZIP eines Leistungsmonats: je Rechnung PDF, ZUGFeRD, XRechnung und Anlagen; Integritätsprüfung je Datei. */
export async function archiveMonthZip(deps: Deps, month: string): Promise<Uint8Array> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new BusinessError('Monat ungültig');
  const docs = await deps.sql<
    { number: string; kind: string; filename: string; storage_path: string; sha256: string }[]
  >`
    select i.number, d.kind::text, d.filename, d.storage_path, d.sha256
      from app.invoices i join app.invoice_documents d on d.invoice_id = i.id
     where i.status = 'issued' and to_char(coalesce(i.period_start, i.issue_date), 'YYYY-MM') = ${month}
       and d.kind <> 'validation_report'
     order by i.number, d.kind, d.filename`;
  if (!docs.length) throw new BusinessError('Keine Belege in diesem Monat');
  const files: Record<string, Uint8Array> = {};
  for (const d of docs) {
    const bytes = await deps.archive.get(d.storage_path);
    if (sha256(bytes) !== d.sha256) throw new Error(`Integritätsfehler: ${d.filename} wurde verändert`);
    files[`${d.number}/${d.filename}`] = bytes;
  }
  // bereits komprimierte PDFs nicht erneut packen (schneller, gleich groß)
  return zipSync(files, { level: 0 });
}
