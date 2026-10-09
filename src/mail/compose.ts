import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Sql } from '../db/client.js';
import type { OutgoingMail } from './mailer.js';

/*
 * Kunden-E-Mails (Rechnung, Mahnung, Test) einheitlich: Text + HTML mit der Viva-Deluxe-Signatur (Ahmed 09.10.:
 * Person, Logo, Zentrale München, Niederlassung, Siegel, Pflichtangaben, Umwelt- und Vertraulichkeitshinweis).
 * Felder unter Einstellungen → E-Mail-Versand änderbar (`company.mail_signature` als JSON). Geschäftsbriefe einer
 * GmbH – auch E-Mails – brauchen die Pflichtangaben nach § 35a GmbHG (Rechtsform, Sitz, Registergericht, HRB,
 * alle Geschäftsführer); die Fußzeile kommt deshalb immer aus den Firmendaten.
 */

const asset = (f: string) => fileURLToPath(new URL(`../../assets/mail/${f}`, import.meta.url));
const IMG = {
  logo: { file: 'sig-logo.png', cid: 'sig-logo@viva-deluxe-reinigung.de', w: 283, h: 80 },
  badges: { file: 'sig-badges.png', cid: 'sig-badges@viva-deluxe-reinigung.de', w: 454, h: 40 },
} as const;
const cache = new Map<string, Uint8Array>();
const bytes = (f: string) => {
  let b = cache.get(f);
  if (!b) cache.set(f, (b = new Uint8Array(readFileSync(asset(f)))));
  return b;
};

export interface SignatureSettings {
  person_name: string;
  person_title: string;
  person_mobile: string;
  person_email: string;
  branch_title: string;
  branch_address: string;
  branch_email: string;
  show_badges: boolean;
  eco_note: boolean;
  disclaimer: boolean;
}

export const SIGNATURE_DEFAULTS: SignatureSettings = {
  // Ahmed 09.10.: ohne Namen, allgemein mit der Buchhaltungs-Adresse
  person_name: 'Buchhaltung',
  person_title: '',
  person_mobile: '',
  person_email: 'buchhaltung@viva-deluxe-reinigung.de',
  branch_title: 'Niederlassung Stuttgart',
  branch_address: 'Königstr. 5 · 70173 Stuttgart',
  branch_email: 'stuttgart@viva-deluxe-reinigung.de',
  show_badges: true,
  eco_note: true,
  disclaimer: true,
};

const ECO =
  'Denken Sie an unsere Umwelt, bevor Sie diese E-Mail ausdrucken. / Please consider the environment before printing this email.';
const DISCLAIMER_DE =
  'Diese E-Mail enthält vertrauliche und/oder rechtlich geschützte Informationen. Wenn Sie nicht der richtige Adressat sind oder diese E-Mail irrtümlich erhalten haben, informieren Sie bitte sofort den Absender und vernichten Sie diese E-Mail. Das unerlaubte Kopieren sowie die unbefugte Weitergabe dieser E-Mail sind nicht gestattet.';
const DISCLAIMER_EN =
  'This email and any files transmitted with it are confidential. Please notify the sender immediately if you have received this email by mistake and delete it from your system. If you are not the intended recipient, you are notified that disclosing, copying, distributing or taking any action in reliance on the contents of this information is strictly prohibited.';

export interface CompanySig {
  legal_name: string;
  street: string | null;
  postal_code: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  register_court: string | null;
  register_number: string | null;
  managing_director: string | null;
  vat_id: string | null;
}

/** Gespeicherte Signatur-Einstellungen (JSON) mit Vorgaben ergänzt; alter Freitext wird ignoriert. */
export function parseSignature(raw: string | null | undefined): SignatureSettings {
  try {
    const j = raw ? (JSON.parse(raw) as Partial<SignatureSettings>) : {};
    return { ...SIGNATURE_DEFAULTS, ...(j && typeof j === 'object' ? j : {}) };
  } catch {
    return { ...SIGNATURE_DEFAULTS };
  }
}

/** Pflichtangaben § 35a GmbHG (Fußzeile der Signatur). */
export function legalLines(c: CompanySig): string[] {
  const reg = c.register_number
    ? `${c.register_court ? `${/amtsgericht/i.test(c.register_court) ? '' : 'Amtsgericht '}${c.register_court}, ` : ''}${c.register_number}`
    : null;
  return [
    [c.legal_name, c.city ? `Sitz der Gesellschaft: ${c.city}` : null, reg].filter(Boolean).join(' · '),
    [
      c.managing_director ? `Geschäftsführer: ${c.managing_director}` : null,
      c.vat_id ? `USt-ID: ${c.vat_id}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  ].filter((x) => x);
}

export interface MailSignature {
  text: string;
  html: string;
  inline: NonNullable<OutgoingMail['inline']>;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const BORDEAUX = '#7D1435';
const a = (href: string, label: string) =>
  `<a href="${esc(href)}" style="color:${BORDEAUX};text-decoration:underline">${esc(label)}</a>`;
const mail = (e: string) => a(`mailto:${e}`, e);
const tel = (t: string) =>
  `<a href="tel:${esc(t.replace(/\(0\)|[^\d+]/g, ''))}" style="color:#222;text-decoration:underline">${esc(t)}</a>`;
const web = (w: string) => a(w.startsWith('http') ? w : `https://${w}`, w.replace(/^https?:\/\//, ''));
const head = (t: string) =>
  `<div style="color:${BORDEAUX};font-weight:700;letter-spacing:.06em;text-transform:uppercase;font-size:14px;margin-bottom:2px">${esc(t)}</div>`;

/** Signatur als Text und HTML (mit eingebetteten Bildern). */
export function buildSignature(c: CompanySig, s: SignatureSettings): MailSignature {
  const hq = [c.street, [c.postal_code, c.city].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  const legal = legalLines(c);
  const text = [
    s.person_name,
    s.person_title,
    s.person_mobile ? `Mobil: ${s.person_mobile}` : '',
    s.person_email ? `E-Mail: ${s.person_email}` : '',
    '',
    `ZENTRALE ${(c.city ?? '').toUpperCase()}`.trim(),
    c.legal_name,
    hq,
    c.phone ? `Telefon: ${c.phone}` : '',
    c.email ? `E-Mail: ${c.email}` : '',
    c.website ? `Web: ${c.website}` : '',
    '',
    s.branch_title ? s.branch_title.toUpperCase() : '',
    s.branch_title ? s.branch_address : '',
    s.branch_title && s.branch_email ? `E-Mail: ${s.branch_email}` : '',
    '',
    ...legal,
    s.eco_note ? `\n${ECO}` : '',
    s.disclaimer ? `\n${DISCLAIMER_DE}\n\n${DISCLAIMER_EN}` : '',
  ]
    .filter((x, i, arr) => x !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .trim();

  const line = (v: string | null | undefined, label?: string, fmt: (x: string) => string = esc) =>
    v ? `${label ? `${esc(label)}: ` : ''}${fmt(v)}<br>` : '';
  const img = (k: keyof typeof IMG, alt: string) =>
    `<img src="cid:${IMG[k].cid}" alt="${esc(alt)}" width="${IMG[k].w}" height="${IMG[k].h}" style="display:block;border:0;max-width:100%;height:auto">`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#222">
${s.person_name ? `<div style="color:${BORDEAUX};font-weight:700;font-size:17px;margin-bottom:2px">${esc(s.person_name)}</div>` : ''}
<div style="color:#444">${line(s.person_title)}${line(s.person_mobile, 'Mobil', tel)}${line(s.person_email, 'E-Mail', mail)}</div>
<div style="margin:16px 0 18px">${img('logo', `${c.legal_name} – Gebäudedienstleister · Meisterbetrieb`)}</div>
${head(`Zentrale ${c.city ?? ''}`.trim())}
<div>${line(c.legal_name)}${line(hq)}${line(c.phone, 'Telefon', tel)}${line(c.email, 'E-Mail', mail)}${line(c.website, 'Web', web)}</div>
${
  s.branch_title
    ? `<div style="border-top:1px solid #d9d9d9;margin:14px 0;max-width:640px"></div>${head(s.branch_title)}<div>${line(s.branch_address)}${line(s.branch_email, 'E-Mail', mail)}</div>`
    : ''
}
${
  s.show_badges
    ? `<table cellpadding="0" cellspacing="0" style="margin:16px 0 0"><tr><td style="font-size:10px;letter-spacing:.08em;color:#777;font-weight:700;padding-right:14px;white-space:nowrap">ZERTIFIZIERT &amp; MITGLIED</td><td>${img('badges', 'Gebäudereiniger-Handwerk Meisterbetrieb · ISO 9001 · ISO 14001 · Die Gebäudedienstleister · Umwelt- und Klimapakt Bayern')}</td></tr></table>`
    : ''
}
<div style="border-top:2px solid ${BORDEAUX};margin:14px 0 10px;max-width:640px"></div>
<div style="color:#444;font-size:13px">${legal.map(esc).join('<br>')}</div>
${s.eco_note ? `<div style="color:#3b7a3b;margin-top:12px;font-size:13px">&#127807; ${esc(ECO)}</div>` : ''}
${
  s.disclaimer
    ? `<div style="color:#888;font-size:11px;margin-top:10px">${esc(DISCLAIMER_DE)}</div><div style="color:#888;font-size:11px;margin-top:8px">${esc(DISCLAIMER_EN)}</div>`
    : ''
}
</div>`;
  const inline = (['logo', ...(s.show_badges ? (['badges'] as const) : [])] as (keyof typeof IMG)[]).map(
    (k) => ({
      filename: IMG[k].file,
      content: bytes(IMG[k].file),
      contentType: 'image/png',
      cid: IMG[k].cid,
    }),
  );
  return { text, html, inline };
}

export async function loadSignatureSettings(sql: Sql) {
  const [c] = await sql<(CompanySig & { mail_signature: string | null })[]>`
    select legal_name, street, postal_code, city, phone, email, website, register_court, register_number,
           managing_director, vat_id, mail_signature from app.company where id = 1`;
  const company: CompanySig = c ?? {
    legal_name: 'Viva-Deluxe Gebäudereinigung GmbH',
    street: null,
    postal_code: null,
    city: null,
    phone: null,
    email: null,
    website: null,
    register_court: null,
    register_number: null,
    managing_director: null,
    vat_id: null,
  };
  return { company, settings: parseSignature(c?.mail_signature) };
}

export async function loadSignature(sql: Sql): Promise<MailSignature> {
  const { company, settings } = await loadSignatureSettings(sql);
  return buildSignature(company, settings);
}

const linkify = (s: string) =>
  esc(s).replace(/([\w.+-]+@[\w-]+\.[\w.-]+)/g, `<a href="mailto:$1" style="color:${BORDEAUX}">$1</a>`);

/** E-Mail aus Text + Signatur. Hinweis (z. B. Testversand) steht oben, im HTML gelb hervorgehoben. */
export function composeMail(p: {
  notice?: string | null;
  body: string;
  greeting?: string;
  signature: MailSignature;
}): Pick<OutgoingMail, 'text' | 'html' | 'inline'> {
  const greeting = p.greeting ?? 'Mit freundlichen Grüßen';
  const text = [p.notice ? `${p.notice}\n` : null, p.body.trim(), '', greeting, '', '-- ', p.signature.text]
    .filter((x) => x != null)
    .join('\n');
  const paras = p.body
    .trim()
    .split(/\n{2,}/)
    .map((x) => `<p style="margin:0 0 12px">${linkify(x).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff">
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:700px;padding:16px">
${p.notice ? `<div style="background:#fff4cc;border:1px solid #e6c34d;padding:8px 10px;margin-bottom:14px;font-size:13px">${esc(p.notice).replace(/\n/g, '<br>')}</div>` : ''}
${paras}
<p style="margin:16px 0 18px">${esc(greeting)}</p>
${p.signature.html}
</div></body></html>`;
  return { text, html, inline: p.signature.inline };
}
