import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { FormDoc } from '../pdf/form-doc.js';
import { BusinessError } from './errors.js';
import { countsAsActual } from './site-times.js';
import { clock, hm, listEntries, netMinutes } from './time.js';
import { type Deps, addAttachment } from './workflow.js';

/*
 * Geschwärzter Stundennachweis zur Rechnung (Ahmed 20.10.: „bei manchen Objekten muss eine geschwärzte
 * Stundenaufzeichnung mit der Rechnung übermittelt werden“). Je Leistung ankreuzbar (site_services.attach_timesheet,
 * z. B. Unterhaltsreinigung). Beim Ausstellen hängt je Objekt ein PDF an der Rechnung: Datum, Beginn, Ende, Pause,
 * Stunden; Namen geschwärzt. Am Ende der Hinweis, dass Quartals-/Jahresarbeiten von Sonderreinigern erledigt werden.
 */

export const SPECIAL_STAFF_NOTE =
  'Quartals- und Jahresarbeiten werden mit zusätzlichem Personal ausgeführt. ' +
  'Diese Arbeiten übernehmen unsere Sonderreiniger; sie sind dem Objekt nicht fest zugeordnet und daher in ' +
  'diesem Nachweis nicht enthalten.';

const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const weekday = (iso: string) => WD[new Date(`${iso}T12:00:00Z`).getUTCDay()]!;

export interface TimesheetSite {
  site_id: string;
  site_no: string;
  site_name: string;
  address: string;
  from: string;
  to: string;
}

/** Objekte einer Rechnung, deren Leistungen „Stundennachweis anhängen“ haben, mit Leistungszeitraum. */
export async function timesheetSitesOf(sql: Sql, invoiceId: string): Promise<TimesheetSite[]> {
  return sql<TimesheetSite[]>`
    select s.id as site_id, s.site_no, s.name as site_name,
           concat_ws(', ', s.street, nullif(concat_ws(' ', s.postal_code, s.city), '')) as address,
           min(coalesce(l.period_start, i.period_start))::text as "from",
           max(coalesce(l.period_end, l.period_start, i.period_end, i.period_start))::text as "to"
      from app.invoice_lines l
      join app.invoices i on i.id = l.invoice_id
      join app.site_services ss on ss.id = l.source_service_id and ss.attach_timesheet
      join app.sites s on s.id = ss.site_id
     where l.invoice_id = ${invoiceId} and coalesce(l.period_start, i.period_start) is not null
     group by s.id, s.site_no, s.name, s.street, s.postal_code, s.city
     order by s.site_no`;
}

/** Dateiname je Objekt + Zeitraum; berichtigte Fassung mit Zeitstempel (je Formular fest → nichts doppelt). */
export const timesheetFilename = (t: TimesheetSite, revision?: string) =>
  `Stundennachweis_${t.site_no}_${t.from}_${t.to}${revision ? `_berichtigt_${revision}` : ''}.pdf`.replace(
    /[^\w.-]+/g,
    '_',
  );

/** PDF für ein Objekt und einen Zeitraum – nur erfasste/freigegebene Zeiten, Namen geschwärzt. */
export async function redactedTimesheetPdf(
  sql: Sql,
  t: TimesheetSite,
  invoice: { number: string | null; customer: string },
  revisedOn?: string,
): Promise<Uint8Array> {
  const entries = (await listEntries(sql, { siteId: t.site_id, from: t.from, to: t.to }))
    .filter(countsAsActual)
    .sort((a, b) => a.work_date.localeCompare(b.work_date) || a.start_at.getTime() - b.start_at.getTime());
  const total = entries.reduce((s, e) => s + netMinutes(e), 0);
  const d = await FormDoc.create({
    title: `Stundennachweis ${t.site_name}`,
    sideRef: `Stundennachweis · ${t.site_name} (${t.site_no}) · ${formatDateDe(t.from)}–${formatDateDe(t.to)}`,
    date: todayBerlin(),
    author: 'Viva-Deluxe Gebäudereinigung GmbH',
  });
  d.title(revisedOn ? 'Stundennachweis (berichtigt)' : 'Stundennachweis', t.site_no);
  d.infoGrid([
    ['Objekt', t.site_name],
    ['Adresse', t.address || '–'],
    ['Zeitraum', `${formatDateDe(t.from)} – ${formatDateDe(t.to)}`],
    ['Kunde', invoice.customer],
    ['Zur Rechnung', invoice.number ?? 'Entwurf'],
    ['Stunden gesamt', `${hm(total)} Std.`],
    ...(revisedOn
      ? ([
          ['Fassung', `berichtigt am ${formatDateDe(revisedOn)} – ersetzt den früher übermittelten Nachweis`],
        ] as [string, string][])
      : []),
  ]);
  d.table(
    [
      { label: 'Datum', width: 92 },
      { label: 'Mitarbeiter/in', width: 140, redact: true },
      { label: 'Beginn', width: 62, align: 'right' },
      { label: 'Ende', width: 62, align: 'right' },
      { label: 'Pause', width: 62, align: 'right' },
      { label: 'Stunden', width: 80, align: 'right' },
    ],
    entries.length
      ? [
          ...entries.map((e) => [
            `${weekday(e.work_date)} ${formatDateDe(e.work_date)}`,
            'x',
            clock(e.start_at),
            clock(e.end_at),
            e.break_minutes ? hm(e.break_minutes) : '–',
            hm(netMinutes(e)),
          ]),
          { sum: ['Summe', '', '', '', '', hm(total)], strong: true },
        ]
      : [['Keine erfassten Zeiten im Zeitraum', '', '', '', '', '']],
  );
  d.muted('Namen der Mitarbeitenden aus Datenschutzgründen geschwärzt.');
  d.para(SPECIAL_STAFF_NOTE, { size: 8.5 });
  return d.save();
}

async function invoiceHead(sql: Sql, invoiceId: string) {
  const [inv] = await sql<{ number: string | null; customer: string }[]>`
    select i.number, c.name as customer from app.invoices i join app.customers c on c.id = i.customer_id
     where i.id = ${invoiceId}`;
  if (!inv) throw new BusinessError('Rechnung nicht gefunden');
  return inv;
}

/** Vorschau (ein PDF, alle Objekte hintereinander) – speichert nichts. */
export async function previewRedactedTimesheet(sql: Sql, invoiceId: string): Promise<Uint8Array | null> {
  const sites = await timesheetSitesOf(sql, invoiceId);
  if (!sites.length) return null;
  const inv = await invoiceHead(sql, invoiceId);
  if (sites.length === 1) return redactedTimesheetPdf(sql, sites[0]!, inv);
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const out = await PDFDocument.create();
  for (const t of sites) {
    const src = await PDFDocument.load(await redactedTimesheetPdf(sql, t, inv));
    for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
  }
  return out.save();
}

/**
 * Stundennachweise als Anlage an die Rechnung hängen (je Objekt eine Datei). Schon angehängte (gleicher Dateiname)
 * bleiben – erneut aufrufen hängt nichts doppelt an. Rückgabe: Anzahl neu angehängter Dateien.
 */
export async function attachRedactedTimesheets(
  deps: Deps,
  invoiceId: string,
  actor: string,
  /** Berichtigte Fassung (z. B. „2026-10-25_1430“): neue Datei zusätzlich zur alten, alte bleibt (write-once). */
  revision?: string,
) {
  const sites = await timesheetSitesOf(deps.sql, invoiceId);
  if (!sites.length) return 0;
  const inv = await invoiceHead(deps.sql, invoiceId);
  const have = new Set(
    (
      await deps.sql<{ filename: string }[]>`
        select filename from app.invoice_documents where invoice_id = ${invoiceId} and kind = 'attachment'`
    ).map((r) => r.filename),
  );
  let n = 0;
  for (const t of sites) {
    const name = timesheetFilename(t, revision);
    if (have.has(name)) continue;
    const pdf = await redactedTimesheetPdf(deps.sql, t, inv, revision ? todayBerlin() : undefined);
    await addAttachment(deps, invoiceId, name, 'application/pdf', pdf, actor);
    n++;
  }
  return n;
}
