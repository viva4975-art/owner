import { createHash } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import type { BuyerSnapshot } from '../domain/invoice/types.js';
import { formatAddressBlock } from '../domain/letter/address-block.js';
import { contactGreeting, personGreeting } from '../domain/letter/greeting.js';
import { renderLetterPdf } from '../pdf/invoice-pdf.js';
import { BusinessError } from './errors.js';
import { buildBuyerSnapshot, getSeller } from './masterdata.js';
import { nextYearNumber } from './purchasing.js';
import { storeFile, type UploadConfig } from './uploads.js';

/*
 * Schriftverkehr: freier Brief auf dem Briefpapier an Kunde, Lieferant/Nachunternehmer oder Mitarbeiter. Das PDF wird
 * write-once in der jeweiligen Akte unter „Schriftverkehr“ abgelegt (feste ID je Formular → doppelt absenden legt
 * nichts doppelt ab). Kündigungen/Aufhebungen von Arbeitsverhältnissen: ausdrucken und eigenhändig unterschreiben
 * (§ 623 BGB, Schriftform) – elektronisch versenden reicht nicht.
 */

export type LetterTarget = 'kunde' | 'objekt' | 'lieferant' | 'mitarbeiter';
const LINK = { kunde: 'customer', objekt: 'site', lieferant: 'supplier', mitarbeiter: 'employee' } as const;

/** Anrede für einen Kunden-Brief: Ansprechpartner (Text) – Anrede notfalls aus den Kontakten des Kunden. */
export async function customerGreeting(
  sql: Sql,
  customerId: string,
  contactName: string | null,
): Promise<string> {
  if (!contactName?.trim()) return contactGreeting(null);
  const known = await sql<{ salutation: string | null; first_name: string | null; last_name: string }[]>`
    select salutation, first_name, last_name from app.contacts where customer_id = ${customerId}`;
  return contactGreeting(contactName, known);
}

export async function letterRecipient(
  sql: Sql,
  target: LetterTarget,
  id: string,
): Promise<{ buyer: BuyerSnapshot; label: string; refs: [string, string][]; greeting: string }> {
  if (target === 'kunde') {
    const buyer = await buildBuyerSnapshot(sql, id, null);
    return {
      buyer,
      label: buyer.name,
      refs: [['Kundennr.', buyer.customerNo]],
      greeting: await customerGreeting(sql, id, buyer.contactName),
    };
  }
  if (target === 'objekt') {
    // Brief zum Objekt geht an den Kunden (Rechnungsanschrift des Objekts), abgelegt beim Objekt
    const [s] = await sql<{ customer_id: string; site_no: string; name: string; customer_no: string }[]>`
      select s.customer_id, s.site_no, s.name, c.customer_no
        from app.sites s join app.customers c on c.id = s.customer_id where s.id = ${id}`;
    if (!s) throw new BusinessError('Objekt nicht gefunden');
    const buyer = await buildBuyerSnapshot(sql, s.customer_id, id);
    return {
      buyer,
      label: `${buyer.name} (Objekt ${s.name})`,
      refs: [
        ['Objekt', `${s.name} (Nr. ${s.site_no})`],
        ['Kundennr.', s.customer_no],
      ],
      greeting: await customerGreeting(sql, s.customer_id, buyer.contactName),
    };
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
      refs: [['Lieferantennr.', s.supplier_no]],
      greeting: contactGreeting(s.contact_name),
    };
  }
  const [e] = await sql<
    {
      personnel_no: string;
      first_name: string;
      last_name: string;
      salutation: string | null;
      street: string | null;
      postal_code: string | null;
      city: string | null;
    }[]
  >`
    select e.personnel_no, e.first_name, e.last_name, e.salutation, p.street, p.postal_code, p.city
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
    refs: [['Personalnr.', e.personnel_no]],
    greeting: personGreeting(e),
  };
}

const uuidFrom = (s: string) => {
  const h = createHash('md5').update(s).digest('hex').split('');
  h[12] = '4';
  h[16] = '89ab'[parseInt(h[16]!, 16) % 4]!;
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

export interface LetterAddress {
  name: string;
  name2: string | null;
  contactName: string | null;
  street: string;
  postalCode: string;
  city: string;
}

/**
 * Brief erzeugen. Anschrift: aus Kunde/Objekt/Lieferant/Mitarbeiter, im Formular frei änderbar (`address`), bei
 * „frei“ nur aus dem Formular. Jeder Brief bekommt eine Nummer BR-JJJJ-NNNN und steht im Briefarchiv
 * (Verwaltung → Briefe); Briefe an Mitarbeitende nur in der Personalakte (Personaldaten). Feste ID je Formular →
 * doppelt absenden legt nichts doppelt an.
 */
export async function writeLetter(
  sql: Sql,
  cfg: UploadConfig,
  p: {
    formId: string;
    target: LetterTarget | 'frei';
    id: string | null;
    address?: LetterAddress | null;
    subject: string;
    greeting: string;
    body: string;
    date: string | null;
    actor: string;
    /** „Unser Zeichen“, „Ihr Zeichen“, Ansprechpartner (Name unter dem Gruß) – statt Briefnummer im Brief */
    ourRef?: string | null;
    yourRef?: string | null;
    sender?: string | null;
  },
): Promise<{ pdf: Uint8Array; fileId: string; letterId: string; letterNo: string }> {
  if (!p.subject.trim()) throw new BusinessError('Bitte Betreff angeben');
  if (!p.body.trim()) throw new BusinessError('Bitte Text eingeben');
  if (p.target !== 'frei' && !(p.target in LINK)) throw new BusinessError('Empfänger ungültig');
  const letterId = uuidFrom(`brieflog:${p.formId}`);
  const fileId = uuidFrom(`brief:${p.formId}`);
  const [done] = await sql<{ letter_no: string }[]>`select letter_no from app.letters where id = ${letterId}`;
  const base = await (async () => {
    if (p.target !== 'frei') return letterRecipient(sql, p.target, p.id ?? '');
    return {
      buyer: {
        customerNo: '',
        name: '',
        name2: null,
        street: '',
        postalCode: '',
        city: '',
        countryCode: 'DE',
        vatId: null,
        leitwegId: null,
        supplierNo: null,
        email: null,
        contactName: null,
        site: null,
      } as BuyerSnapshot,
      label: '',
      refs: [] as [string, string][],
      greeting: contactGreeting(p.address?.contactName ?? null),
    };
  })();
  const buyer: BuyerSnapshot = p.address ? { ...base.buyer, ...p.address } : base.buyer;
  if (!buyer.name || !buyer.street || !buyer.postalCode || !buyer.city)
    throw new BusinessError('Anschrift des Empfängers unvollständig (Name, Straße, PLZ Ort)');
  const date = p.date && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : todayBerlin();
  const archived = p.target !== 'mitarbeiter';
  const letterNo =
    done?.letter_no ??
    (archived ? await sql.begin((tx) => nextYearNumber(tx, 'letter', 'BR-', date.slice(0, 4), 4)) : '');
  const clip = (v: string | null | undefined, n: number) => (v ?? '').trim().slice(0, n) || null;
  const ourRef = clip(p.ourRef, 60);
  const yourRef = clip(p.yourRef, 60);
  const sender = clip(p.sender, 120);
  const paras = p.body
    .split(/\n\s*\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  const pdf = await renderLetterPdf({
    title: p.subject.trim().slice(0, 90),
    date,
    info: [
      ['Datum', formatDateDe(date)],
      ...(ourRef ? ([['Unser Zeichen', ourRef]] as [string, string][]) : []),
      ...(yourRef ? ([['Ihr Zeichen', yourRef]] as [string, string][]) : []),
      ...(sender ? ([['Ansprechpartner', sender]] as [string, string][]) : []),
      ...base.refs,
    ],
    seller: await getSeller(sql),
    buyer,
    greeting: p.greeting.trim() || null,
    intro: paras[0] ?? '',
    columns: [],
    rows: [],
    sums: [],
    total: null,
    paragraphs: [
      ...paras.slice(1),
      'Mit freundlichen Grüßen',
      ...(sender ? [sender] : []),
      'Viva-Deluxe Gebäudereinigung GmbH',
    ],
  });
  const link = p.target === 'frei' ? null : { type: LINK[p.target], id: p.id ?? '' };
  const file = await storeFile(
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
      link,
      category: link ? 'Schriftverkehr' : null,
    },
    p.actor,
  );
  if (archived && !done) {
    let customerId: string | null = null;
    let siteId: string | null = null;
    if (p.target === 'kunde') customerId = p.id;
    if (p.target === 'objekt') {
      siteId = p.id;
      const [s] = await sql<{ customer_id: string }[]>`select customer_id from app.sites where id = ${p.id}`;
      customerId = s?.customer_id ?? null;
    }
    await sql`insert into app.letters (id, letter_no, letter_date, target, customer_id, site_id, supplier_id,
                recipient, subject, greeting, body, file_id, created_by, our_ref, your_ref, sender)
              values (${letterId}, ${letterNo}, ${date}, ${p.target}, ${customerId}, ${siteId},
                ${p.target === 'lieferant' ? p.id : null}, ${formatAddressBlock(buyer)}, ${p.subject.trim()},
                ${p.greeting.trim() || null}, ${p.body}, ${file.id}, ${p.actor}, ${ourRef}, ${yourRef}, ${sender})
              on conflict (id) do nothing`;
  }
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${p.actor}, 'letter', ${link ? link.type : 'letter'}, ${link ? link.id : letterId},
                    ${sql.json({ subject: p.subject, file: fileId, letter_no: letterNo || null })})`;
  return { pdf, fileId, letterId, letterNo };
}

export interface LetterRow {
  id: string;
  letter_no: string;
  letter_date: string;
  target: string;
  recipient: string;
  subject: string;
  file_id: string;
  created_by: string;
  customer_id: string | null;
  customer_no: string | null;
  site_id: string | null;
  site_no: string | null;
  our_ref: string | null;
  sender: string | null;
  site_name: string | null;
}

export async function listLetters(sql: Sql, q: string | null, limit = 300): Promise<LetterRow[]> {
  const like = q?.trim() ? `%${q.trim()}%` : null;
  return sql<LetterRow[]>`
    select l.id, l.letter_no, l.letter_date::text, l.target, l.recipient, l.subject, l.file_id, l.created_by,
           l.our_ref, l.sender,
           l.customer_id, c.customer_no, l.site_id, s.site_no, s.name as site_name
      from app.letters l
      left join app.customers c on c.id = l.customer_id
      left join app.sites s on s.id = l.site_id
     where ${like}::text is null
        or concat_ws(' ', l.letter_no, l.subject, l.recipient, l.body, l.our_ref, l.your_ref, l.sender, c.customer_no, s.site_no, s.name) ilike ${like}
     order by l.letter_date desc, l.letter_no desc
     limit ${limit}`;
}
