import { PDFDocument } from '@cantoo/pdf-lib';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { renderAttendancePdf } from '../pdf/attendance.js';
import { Icon } from './icons.js';

/*
 * Anwesenheitsliste (zwei Monate je Seite) zum Drucken – am Objekt und beim Kunden unter Dokumente
 * (Ahmed 29.10.: „auch für Kunde drucken können“). Beim Kunden ein Objekt oder alle aktiven in einer PDF.
 */

export function AttendanceForm(p: {
  action: string;
  sites?: { id: string; site_no: string; name: string }[];
  title?: string;
}) {
  return (
    <form
      method="get"
      action={p.action}
      target="_blank"
      class="actions"
      style="margin-bottom:0;align-items:flex-end"
    >
      {p.sites && (
        <label>
          Objekt
          <select name="objekt">
            <option value="kunde">nur Kunde (ohne Objekt)</option>
            {p.sites.length > 1 && <option value="alle">alle aktiven Objekte ({p.sites.length})</option>}
            {p.sites.map((s) => (
              <option value={s.id}>
                {s.site_no} · {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {p.title ?? 'Anwesenheitsliste ab Monat'}
        <input type="month" name="monat" value={todayBerlin().slice(0, 7)} required />
      </label>
      <label>
        Seiten (je 2 Monate)
        <select name="seiten">
          <option value="1">1 – zwei Monate</option>
          <option value="2">2 – vier Monate</option>
          <option value="3">3 – sechs Monate</option>
          <option value="6">6 – ganzes Jahr</option>
        </select>
      </label>
      <button class="btn sec" type="submit">
        <Icon name="download" /> Anwesenheitsliste (PDF)
      </button>
    </form>
  );
}

/** Anwesenheitsliste nur für den Kunden – Kopf mit Kundenname und Anschrift, ohne Objekt. */
export async function attendancePdfForCustomer(
  sql: Sql,
  customerId: string,
  month: string,
  pages: number,
): Promise<Uint8Array> {
  const [c] = await sql<
    {
      name: string;
      customer_no: string | null;
      street: string | null;
      postal_code: string | null;
      city: string | null;
    }[]
  >`select name, customer_no, street, postal_code, city from app.customers where id = ${customerId}`;
  if (!c) throw new Error('Kunde nicht gefunden');
  const addr = [c.street, [c.postal_code, c.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return renderAttendancePdf({
    site: { name: c.name, site_no: c.customer_no ?? '', address: addr || null },
    customer: null,
    month,
    pages,
    company: 'Viva-Deluxe Gebäudereinigung GmbH',
  });
}

export function attendanceQuery(q: (k: string) => string | undefined) {
  const m = q('monat') ?? '';
  return {
    month: /^\d{4}-\d{2}$/.test(m) ? m : todayBerlin().slice(0, 7),
    pages: Math.min(6, Math.max(1, Number(q('seiten')) || 1)),
  };
}

/** Eine PDF für mehrere Objekte (je Objekt die gewählten Seiten). */
export async function attendancePdfForSites(
  sql: Sql,
  siteIds: string[],
  month: string,
  pages: number,
): Promise<Uint8Array> {
  const rows = await sql<
    {
      id: string;
      name: string;
      site_no: string;
      street: string | null;
      postal_code: string | null;
      city: string | null;
      customer: string;
    }[]
  >`select s.id, s.name, s.site_no, s.street, s.postal_code, s.city, c.name as customer
      from app.sites s join app.customers c on c.id = s.customer_id
     where s.id = any(${siteIds}::uuid[]) order by s.site_no`;
  const parts: Uint8Array[] = [];
  for (const s of rows) {
    const addr = [s.street, [s.postal_code, s.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    parts.push(
      await renderAttendancePdf({
        site: { name: s.name, site_no: s.site_no, address: addr || null },
        customer: s.customer,
        month,
        pages,
        company: 'Viva-Deluxe Gebäudereinigung GmbH',
      }),
    );
  }
  if (parts.length === 1) return parts[0]!;
  const out = await PDFDocument.create();
  out.setTitle(`Anwesenheitslisten ${month}`);
  const fixed = new Date(`${month}-01T12:00:00Z`);
  out.setCreationDate(fixed);
  out.setModificationDate(fixed);
  for (const b of parts) {
    const doc = await PDFDocument.load(b);
    for (const pg of await out.copyPages(doc, doc.getPageIndices())) out.addPage(pg);
  }
  return out.save();
}
