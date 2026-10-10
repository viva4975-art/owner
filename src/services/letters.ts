import { createHash } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import type { BuyerSnapshot } from '../domain/invoice/types.js';
import { renderLetterPdf } from '../pdf/invoice-pdf.js';
import { BusinessError } from './errors.js';
import { buildBuyerSnapshot, getSeller } from './masterdata.js';
import { storeFile, type UploadConfig } from './uploads.js';

/*
 * Schriftverkehr: freier Brief auf dem Briefpapier an Kunde, Lieferant/Nachunternehmer oder Mitarbeiter. Das PDF wird
 * write-once in der jeweiligen Akte unter „Schriftverkehr“ abgelegt (feste ID je Formular → doppelt absenden legt
 * nichts doppelt ab). Kündigungen/Aufhebungen von Arbeitsverhältnissen: ausdrucken und eigenhändig unterschreiben
 * (§ 623 BGB, Schriftform) – elektronisch versenden reicht nicht.
 */

export type LetterTarget = 'kunde' | 'objekt' | 'lieferant' | 'mitarbeiter';
const LINK = { kunde: 'customer', objekt: 'site', lieferant: 'supplier', mitarbeiter: 'employee' } as const;

export async function letterRecipient(
  sql: Sql,
  target: LetterTarget,
  id: string,
): Promise<{ buyer: BuyerSnapshot; label: string; ref: [string, string] | null }> {
  if (target === 'kunde') {
    const buyer = await buildBuyerSnapshot(sql, id, null);
    return { buyer, label: buyer.name, ref: ['Kundennr.', buyer.customerNo] };
  }
  if (target === 'objekt') {
    // Brief zum Objekt geht an den Kunden (Rechnungsanschrift des Objekts), abgelegt beim Objekt
    const [s] = await sql<{ customer_id: string; site_no: string; name: string }[]>`
      select customer_id, site_no, name from app.sites where id = ${id}`;
    if (!s) throw new BusinessError('Objekt nicht gefunden');
    const buyer = await buildBuyerSnapshot(sql, s.customer_id, id);
    return { buyer, label: `${buyer.name} (Objekt ${s.name})`, ref: ['Objekt', `${s.name} (${s.site_no})`] };
  }
  const base = {
    countryCode: 'DE',
    vatId: null,
    leitwegId: null,
    supplierNo: null,
    email: null,
    site: null,
    name2: null,
  };
  if (target === 'lieferant') {
    const [s] = await sql<
      {
        supplier_no: string;
        name: string;
        street: string | null;
        postal_code: string | null;
        city: string | null;
        contact_name: string | null;
      }[]
    >`
      select supplier_no, name, street, postal_code, city, contact_name from app.suppliers where id = ${id}`;
    if (!s) throw new BusinessError('Lieferant nicht gefunden');
    return {
      buyer: {
        ...base,
        customerNo: s.supplier_no,
        name: s.name,
        street: s.street ?? '',
        postalCode: s.postal_code ?? '',
        city: s.city ?? '',
        contactName: s.contact_name,
      },
      label: s.name,
      ref: ['Lieferantennr.', s.supplier_no],
    };
  }
  const [e] = await sql<
    {
      personnel_no: string;
      first_name: string;
      last_name: string;
      street: string | null;
      postal_code: string | null;
      city: string | null;
    }[]
  >`
    select e.personnel_no, e.first_name, e.last_name, p.street, p.postal_code, p.city
      from app.employees e left join app.employee_private p on p.employee_id = e.id where e.id = ${id}`;
  if (!e) throw new BusinessError('Mitarbeiter nicht gefunden');
  return {
    buyer: {
      ...base,
      customerNo: e.personnel_no,
      name: `${e.first_name} ${e.last_name}`,
      street: e.street ?? '',
      postalCode: e.postal_code ?? '',
      city: e.city ?? '',
      contactName: null,
    },
    label: `${e.first_name} ${e.last_name}`,
    ref: ['Personalnr.', e.personnel_no],
  };
}

const uuidFrom = (s: string) => {
  const h = createHash('md5').update(s).digest('hex').split('');
  h[12] = '4';
  h[16] = '89ab'[parseInt(h[16]!, 16) % 4]!;
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

export async function writeLetter(
  sql: Sql,
  cfg: UploadConfig,
  p: {
    formId: string;
    target: LetterTarget;
    id: string;
    subject: string;
    greeting: string;
    body: string;
    date: string | null;
    actor: string;
  },
): Promise<{ pdf: Uint8Array; fileId: string }> {
  if (!p.subject.trim()) throw new BusinessError('Bitte Betreff angeben');
  if (!p.body.trim()) throw new BusinessError('Bitte Text eingeben');
  if (!(p.target in LINK)) throw new BusinessError('Empfänger ungültig');
  const r = await letterRecipient(sql, p.target, p.id);
  if (!r.buyer.street || !r.buyer.postalCode || !r.buyer.city)
    throw new BusinessError('Anschrift des Empfängers unvollständig');
  const date = p.date && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : todayBerlin();
  const paras = p.body
    .split(/\n\s*\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  const pdf = await renderLetterPdf({
    title: p.subject.trim().slice(0, 90),
    date,
    info: [['Datum', formatDateDe(date)], ...(r.ref ? [r.ref] : [])],
    seller: await getSeller(sql),
    buyer: r.buyer,
    greeting: p.greeting.trim() || null,
    intro: paras[0] ?? '',
    columns: [],
    rows: [],
    sums: [],
    total: null,
    paragraphs: [...paras.slice(1), 'Mit freundlichen Grüßen', 'Viva-Deluxe Gebäudereinigung GmbH'],
  });
  const fileId = uuidFrom(`brief:${p.formId}`);
  await storeFile(
    sql,
    cfg,
    {
      id: fileId,
      name: `Brief_${date}_${p.subject
        .trim()
        .replace(/[^\wäöüÄÖÜß -]+/g, '')
        .slice(0, 40)}.pdf`,
      type: 'application/pdf',
      data: pdf,
      link: { type: LINK[p.target], id: p.id },
      category: 'Schriftverkehr',
    },
    p.actor,
  );
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${p.actor}, 'letter', ${LINK[p.target]}, ${p.id}, ${sql.json({ subject: p.subject, file: fileId })})`;
  return { pdf, fileId };
}
