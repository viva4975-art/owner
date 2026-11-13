import { createHash } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import type { BuyerSnapshot } from '../domain/invoice/types.js';
import { AddressBlockError, formatAddressBlock, parseAddressBlock } from '../domain/letter/address-block.js';
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
 * Anschrift aus dem freien Textfeld (Ahmed 13.11.: keine Pflicht). Leer = Brief ohne Anschrift; passt der Text auf
 * Name/Straße/„PLZ Ort“, wird er aufgeteilt, sonst bleiben die Zeilen wie eingegeben (z. B. „Botschaft …\nTirana“).
 */
export function addressFromText(text: string | null | undefined): LetterAddress {
  const lines = (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 8);
  const empty = { name: '', name2: null, contactName: null, street: '', postalCode: '', city: '' };
  if (!lines.length) return empty;
  try {
    return parseAddressBlock(lines.join('\n'));
  } catch (e) {
    if (!(e instanceof AddressBlockError)) throw e;
    return { ...empty, name: lines[0]!, name2: lines.slice(1).join('\n') || null };
  }
}

/** Betreff: Zeilenumbrüche bleiben (höchstens 4 Zeilen), sonst wie eingegeben. */
const cleanSubject = (t: string) =>
  t
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 4)
    .join('\n')
    .slice(0, 300);
const cleanClosing = (t: string | null | undefined) => {
  const v = (t ?? '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
    .slice(0, 600);
  return v.trim() ? v : null;
};
/** Vorschlag für die Grußformel (Formular vorbelegt). */
export const defaultClosing = (sender: string | null | undefined) =>
  [
    'Mit freundlichen Grüßen',
    ...(sender?.trim() ? [sender.trim()] : []),
    'Viva-Deluxe Gebäudereinigung GmbH',
  ].join('\n');

interface LetterContent {
  buyer: BuyerSnapshot;
  date: string;
  subject: string;
  greeting: string | null;
  info: [string, string][];
  paras: string[];
  sender: string | null;
  /** Grußformel mit Zeilenumbrüchen (leer = „Mit freundlichen Grüßen“ + Ansprechpartner + Firma) */
  closing: string;
}

/** Inhalt eines Briefs wie gedruckt (für PDF und Word gleich). */
async function letterContent(
  sql: Sql,
  p: {
    target: LetterTarget | 'frei';
    id: string | null;
    address?: LetterAddress | null;
    addressText?: string | null;
    subject: string;
    greeting: string;
    body: string;
    date: string | null;
    ourRef?: string | null;
    yourRef?: string | null;
    sender?: string | null;
    closing?: string | null;
  },
): Promise<LetterContent & { refsBase: [string, string][] }> {
  const empty: BuyerSnapshot = {
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
  };
  const base =
    p.target !== 'frei'
      ? await letterRecipient(sql, p.target, p.id ?? '')
      : { buyer: empty, refs: [] as [string, string][] };
  const addr = p.addressText !== undefined ? addressFromText(p.addressText) : (p.address ?? null);
  const buyer: BuyerSnapshot = addr ? { ...base.buyer, ...addr } : base.buyer;
  const date = p.date && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : todayBerlin();
  const clip = (v: string | null | undefined, n: number) => (v ?? '').trim().slice(0, n) || null;
  const ourRef = clip(p.ourRef, 60);
  const yourRef = clip(p.yourRef, 60);
  const sender = clip(p.sender, 120);
  return {
    buyer,
    date,
    subject: cleanSubject(p.subject),
    greeting: p.greeting.trim() || null,
    info: [
      ['Datum', formatDateDe(date)],
      ...(ourRef ? ([['Unser Zeichen', ourRef]] as [string, string][]) : []),
      ...(yourRef ? ([['Ihr Zeichen', yourRef]] as [string, string][]) : []),
      ...(sender ? ([['Ansprechpartner', sender]] as [string, string][]) : []),
      ...base.refs,
    ],
    paras: p.body
      .split(/\n\s*\n/)
      .map((x) => x.trim())
      .filter(Boolean),
    sender,
    closing: cleanClosing(p.closing) ?? defaultClosing(sender),
    refsBase: base.refs,
  };
}

async function contentPdf(sql: Sql, k: LetterContent): Promise<Uint8Array> {
  return renderLetterPdf({
    title: k.subject,
    date: k.date,
    info: k.info,
    seller: await getSeller(sql),
    buyer: k.buyer,
    greeting: k.greeting,
    intro: k.paras[0] ?? '',
    columns: [],
    rows: [],
    sums: [],
    total: null,
    paragraphs: [...k.paras.slice(1), k.closing],
  });
}

/** Brief als Word-Datei (schlicht, zum Weiterbearbeiten in Word). */
async function contentDocx(sql: Sql, k: LetterContent): Promise<Uint8Array> {
  const seller = await getSeller(sql);
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const run = (t: string, o: { b?: boolean; sz?: number; color?: string } = {}) =>
    t
      .split('\n')
      .map(
        (line, i) =>
          `${i ? '<w:r><w:br/></w:r>' : ''}<w:r><w:rPr><w:rFonts w:ascii="Inter" w:hAnsi="Inter" w:cs="Arial"/>${o.b ? '<w:b/>' : ''}${o.color ? `<w:color w:val="${o.color}"/>` : ''}<w:sz w:val="${o.sz ?? 21}"/></w:rPr><w:t xml:space="preserve">${esc(line)}</w:t></w:r>`,
      )
      .join('');
  const par = (inner: string, after = 160, jc?: string) =>
    `<w:p><w:pPr>${jc ? `<w:jc w:val="${jc}"/>` : ''}<w:spacing w:after="${after}"/></w:pPr>${inner}</w:p>`;
  const sellerLine = [seller.legalName, seller.street, `${seller.postalCode} ${seller.city}`]
    .filter(Boolean)
    .join(' · ');
  const addr = formatAddressBlock(k.buyer);
  const cell = (inner: string, w: number) =>
    `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>${inner || '<w:p/>'}</w:tc>`;
  const none = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((x) => `<w:${x} w:val="nil"/>`)
    .join('');
  // Anschrift links, Datum/Zeichen rechts – wie im PDF
  const head =
    `<w:tbl><w:tblPr><w:tblW w:w="9638" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${none}</w:tblBorders><w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="5660"/><w:gridCol w:w="3978"/></w:tblGrid><w:tr>` +
    cell(par(run(sellerLine, { sz: 13, color: '6B6266' }), 100) + (addr ? par(run(addr), 0) : ''), 5660) +
    cell(k.info.map(([x, v]) => par(run(`${x}: ${v}`, { sz: 17, color: '6B6266' }), 20)).join(''), 3978) +
    '</w:tr></w:tbl>';
  const body =
    head +
    par('', 480) +
    par(run(k.subject, { b: true, sz: 23 }), 240) +
    (k.greeting ? par(run(k.greeting)) : '') +
    k.paras.map((x) => par(run(x))).join('') +
    par(run(k.closing), 0) +
    // Briefpapier (Logo, Kopf, Fußzeile mit Bank/Siegeln) liegt als Seitenbild in der Kopfzeile hinter dem Text
    '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="2780" w:right="1134" w:bottom="2900" w:left="1134" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>';
  const NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}</w:body></w:document>`;
  const cx = 7560310; // A4 in EMU
  const cy = 10692130;
  const header =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}><w:p><w:r><w:drawing>` +
    `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="0" behindDoc="1" locked="1" layoutInCell="1" allowOverlap="1">` +
    `<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="1" name="Briefpapier"/><wp:cNvGraphicFramePr/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="Briefpapier"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p></w:hdr>`;
  const { readFile } = await import('node:fs/promises');
  const img = await readFile(new URL('../../assets/briefpapier/viva-deluxe-a4.jpg', import.meta.url));
  const { strToU8, zipSync } = await import('fflate');
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    'word/_rels/document.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdH" Type="${REL}/header" Target="header1.xml"/></Relationships>`,
    ),
    'word/_rels/header1.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="${REL}/image" Target="media/briefpapier.jpg"/></Relationships>`,
    ),
    'word/document.xml': strToU8(xml),
    'word/header1.xml': strToU8(header),
    'word/media/briefpapier.jpg': new Uint8Array(img),
  });
}

const fileBase = (date: string, subject: string) =>
  `Brief_${date}_${subject
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[^\wäöüÄÖÜß -]+/g, '')
    .slice(0, 40)}`;

/**
 * Brief erzeugen. Anschrift: aus Kunde/Objekt/Lieferant/Mitarbeiter, im Formular frei änderbar, keine Pflicht
 * (Ahmed 13.11.). Jeder Brief bekommt eine Nummer BR-JJJJ-NNNN und steht im Briefarchiv (Verwaltung → Briefe);
 * Briefe an Mitarbeitende nur in der Personalakte (Personaldaten). Feste ID je Formular und Inhalt → doppelt
 * absenden legt nichts doppelt an, geänderter Text = neuer Brief. `basedOn` = bearbeitete Fassung eines älteren
 * Briefs (der bleibt unverändert). Ergebnis zusätzlich als Word (`docx`).
 */
export async function writeLetter(
  sql: Sql,
  cfg: UploadConfig,
  p: {
    formId: string;
    target: LetterTarget | 'frei';
    id: string | null;
    address?: LetterAddress | null;
    addressText?: string | null;
    subject: string;
    greeting: string;
    body: string;
    date: string | null;
    actor: string;
    /** „Unser Zeichen“, „Ihr Zeichen“, Ansprechpartner (Name unter dem Gruß) – statt Briefnummer im Brief */
    ourRef?: string | null;
    yourRef?: string | null;
    sender?: string | null;
    closing?: string | null;
    basedOn?: string | null;
    docx?: boolean;
  },
): Promise<{
  pdf: Uint8Array;
  docx: Uint8Array | null;
  name: string;
  fileId: string;
  letterId: string;
  letterNo: string;
}> {
  if (!p.subject.trim()) throw new BusinessError('Bitte Betreff angeben');
  if (!p.body.trim()) throw new BusinessError('Bitte Text eingeben');
  if (p.target !== 'frei' && !(p.target in LINK)) throw new BusinessError('Empfänger ungültig');
  const k = await letterContent(sql, p);
  const sig = createHash('sha256')
    .update(JSON.stringify([formatAddressBlock(k.buyer), k.subject, k.greeting, p.body, k.info, k.closing]))
    .digest('hex')
    .slice(0, 16);
  const letterId = uuidFrom(`brieflog:${p.formId}:${sig}`);
  const fileId = uuidFrom(`brief:${p.formId}:${sig}`);
  const [done] = await sql<{ letter_no: string }[]>`select letter_no from app.letters where id = ${letterId}`;
  const archived = p.target !== 'mitarbeiter';
  const letterNo =
    done?.letter_no ??
    (archived ? await sql.begin((tx) => nextYearNumber(tx, 'letter', 'BR-', k.date.slice(0, 4), 4)) : '');
  const pdf = await contentPdf(sql, k);
  const name = fileBase(k.date, p.subject);
  const link = p.target === 'frei' ? null : { type: LINK[p.target], id: p.id ?? '' };
  const file = await storeFile(
    sql,
    cfg,
    {
      id: fileId,
      name: `${name}.pdf`,
      type: 'application/pdf',
      data: pdf,
      link,
      category: link ? (link.type === 'employee' ? 'Arbeitsvertrag' : 'Schriftverkehr') : null,
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
    const basedOn = p.basedOn && /^[0-9a-f-]{36}$/.test(p.basedOn) ? p.basedOn : null;
    const info = Object.fromEntries(k.info);
    await sql`insert into app.letters (id, letter_no, letter_date, target, customer_id, site_id, supplier_id,
                recipient, subject, greeting, body, file_id, created_by, our_ref, your_ref, sender, based_on, closing)
              values (${letterId}, ${letterNo}, ${k.date}, ${p.target}, ${customerId}, ${siteId},
                ${p.target === 'lieferant' ? p.id : null}, ${formatAddressBlock(k.buyer)}, ${k.subject},
                ${k.greeting}, ${p.body}, ${file.id}, ${p.actor}, ${info['Unser Zeichen'] ?? null},
                ${info['Ihr Zeichen'] ?? null}, ${k.sender}, ${basedOn}, ${k.closing})
              on conflict (id) do nothing`;
  }
  if (!done)
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${p.actor}, 'letter', ${link ? link.type : 'letter'}, ${link ? link.id : letterId},
                      ${sql.json({ subject: p.subject, file: fileId, letter_no: letterNo || null, based_on: p.basedOn ?? null })})`;
  return {
    pdf,
    docx: p.docx ? await contentDocx(sql, k) : null,
    name,
    fileId,
    letterId,
    letterNo,
  };
}

export interface LetterDetail {
  id: string;
  letter_no: string;
  letter_date: string;
  target: string;
  customer_id: string | null;
  site_id: string | null;
  supplier_id: string | null;
  recipient: string;
  subject: string;
  greeting: string | null;
  body: string;
  our_ref: string | null;
  your_ref: string | null;
  sender: string | null;
  closing: string | null;
}

export async function getLetter(sql: Sql, id: string): Promise<LetterDetail | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const [l] = await sql<LetterDetail[]>`
    select id, letter_no, letter_date::text, target, customer_id, site_id, supplier_id, recipient, subject, greeting,
           body, our_ref, your_ref, sender, closing
      from app.letters where id = ${id}`;
  return l ?? null;
}

/** Archivierten Brief als Word – Inhalt wie gespeichert (Anschrift, Text, Zeichen). */
export async function archivedLetterDocx(sql: Sql, l: LetterDetail) {
  const target = (['kunde', 'objekt', 'lieferant'] as const).find((t) => t === l.target);
  const refId = target === 'objekt' ? l.site_id : target === 'kunde' ? l.customer_id : l.supplier_id;
  const k = await letterContent(sql, {
    target: target && refId ? target : 'frei',
    id: refId,
    addressText: l.recipient,
    subject: l.subject,
    greeting: l.greeting ?? '',
    body: l.body,
    date: l.letter_date,
    ourRef: l.our_ref,
    yourRef: l.your_ref,
    sender: l.sender,
    closing: l.closing,
  });
  return { data: await contentDocx(sql, k), name: `${fileBase(l.letter_date, l.subject)}.docx` };
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
  based_on_no: string | null;
}

export async function listLetters(sql: Sql, q: string | null, limit = 300): Promise<LetterRow[]> {
  const like = q?.trim() ? `%${q.trim()}%` : null;
  return sql<LetterRow[]>`
    select l.id, l.letter_no, l.letter_date::text, l.target, l.recipient, l.subject, l.file_id, l.created_by,
           l.our_ref, l.sender,
           l.customer_id, c.customer_no, l.site_id, s.site_no, s.name as site_name, o.letter_no as based_on_no
      from app.letters l
      left join app.letters o on o.id = l.based_on
      left join app.customers c on c.id = l.customer_id
      left join app.sites s on s.id = l.site_id
     where ${like}::text is null
        or concat_ws(' ', l.letter_no, l.subject, l.recipient, l.body, l.our_ref, l.your_ref, l.sender, c.customer_no, s.site_no, s.name) ilike ${like}
     order by l.letter_date desc, l.letter_no desc
     limit ${limit}`;
}
