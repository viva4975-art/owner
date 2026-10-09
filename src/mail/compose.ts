import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Sql } from '../db/client.js';
import type { OutgoingMail } from './mailer.js';

/*
 * Kunden-E-Mails (Rechnung, Mahnung, Test) einheitlich: Text + HTML mit Logo und Signatur. Signatur aus den
 * Firmendaten oder eigener Text (Einstellungen → E-Mail-Versand). Geschäftsbriefe einer GmbH – auch E-Mails – brauchen
 * die Pflichtangaben nach § 35a GmbHG (Rechtsform, Sitz, Registergericht, HRB, alle Geschäftsführer).
 */

const LOGO_PATH = fileURLToPath(new URL('../../assets/web/logo-transparent.png', import.meta.url));
const LOGO_CID = 'logo@viva-deluxe-reinigung.de';
let logo: Uint8Array | null = null;
const logoBytes = () => (logo ??= new Uint8Array(readFileSync(LOGO_PATH)));

interface CompanySig {
  legal_name: string;
  street: string | null;
  postal_code: string | null;
  city: string | null;
  phone: string | null;
  fax: string | null;
  email: string | null;
  website: string | null;
  register_court: string | null;
  register_number: string | null;
  managing_director: string | null;
  vat_id: string | null;
  mail_signature: string | null;
}

/** Signatur aus den Firmendaten (ohne Grußformel). */
export function autoSignature(c: Omit<CompanySig, 'mail_signature'>): string {
  const line = (...p: (string | null | undefined)[]) => p.filter((x) => x && x.trim()).join(' · ');
  const reg = c.register_number
    ? `${c.register_court ? `${/amtsgericht/i.test(c.register_court) ? '' : 'Amtsgericht '}${c.register_court} ` : ''}${c.register_number}`
    : null;
  return [
    c.legal_name,
    line(c.street, [c.postal_code, c.city].filter(Boolean).join(' ')),
    line(c.phone ? `Tel. ${c.phone}` : null, c.fax ? `Fax ${c.fax}` : null),
    line(c.email, c.website),
    '',
    line(
      c.managing_director ? `Geschäftsführer: ${c.managing_director}` : null,
      c.city ? `Sitz: ${c.city}` : null,
    ),
    line(reg, c.vat_id ? `USt-IdNr. ${c.vat_id}` : null),
  ]
    .filter((x, i, a) => x !== '' || (i > 0 && a[i - 1] !== ''))
    .join('\n')
    .trim();
}

export async function loadSignature(sql: Sql): Promise<{ text: string; custom: boolean; auto: string }> {
  const [c] = await sql<CompanySig[]>`
    select legal_name, street, postal_code, city, phone, fax, email, website, register_court, register_number,
           managing_director, vat_id, mail_signature from app.company where id = 1`;
  const auto = c ? autoSignature(c) : 'Viva-Deluxe Gebäudereinigung GmbH';
  const custom = c?.mail_signature?.trim();
  return { text: custom || auto, custom: !!custom, auto };
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const linkify = (s: string) =>
  esc(s)
    .replace(
      /([\w.+-]+@[\w-]+\.[\w.-]+)/g,
      '<a href="mailto:$1" style="color:#7D1435;text-decoration:none">$1</a>',
    )
    .replace(
      /(^|[\s·])((?:https?:\/\/)?www\.[\w.-]+\.[a-z]{2,}[^\s·]*)/gi,
      (_m, pre: string, url: string) =>
        `${pre}<a href="${url.startsWith('http') ? url : `https://${url}`}" style="color:#7D1435;text-decoration:none">${url}</a>`,
    );

/**
 * E-Mail an Kunden aus Absätzen (Text) + Signatur. Hinweis (z. B. Testversand) steht oben, im HTML gelb hervorgehoben.
 */
export function composeMail(p: {
  notice?: string | null;
  body: string;
  greeting?: string;
  signature: string;
}): Pick<OutgoingMail, 'text' | 'html' | 'inline'> {
  const greeting = p.greeting ?? 'Mit freundlichen Grüßen';
  const text = [p.notice ? `${p.notice}\n` : null, p.body.trim(), '', greeting, '', '-- ', p.signature]
    .filter((x) => x != null)
    .join('\n');
  const paras = p.body
    .trim()
    .split(/\n{2,}/)
    .map((x) => `<p style="margin:0 0 12px">${linkify(x).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const [first, ...rest] = p.signature.split('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff">
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:640px;padding:16px">
${p.notice ? `<div style="background:#fff4cc;border:1px solid #e6c34d;padding:8px 10px;margin-bottom:14px;font-size:13px">${esc(p.notice).replace(/\n/g, '<br>')}</div>` : ''}
${paras}
<p style="margin:16px 0 18px">${esc(greeting)}</p>
<table cellpadding="0" cellspacing="0" style="border-top:2px solid #7D1435;padding-top:10px;font-size:12px;line-height:1.5;color:#444">
<tr><td style="padding:10px 0 6px"><img src="cid:${LOGO_CID}" alt="Viva-Deluxe" width="168" height="38" style="display:block;border:0"></td></tr>
<tr><td><b style="color:#7D1435;font-size:13px">${esc(first ?? '')}</b><br>${rest.map((l) => (l.trim() ? linkify(l) : '')).join('<br>')}</td></tr>
</table>
</div></body></html>`;
  return {
    text,
    html,
    inline: [{ filename: 'logo.png', content: logoBytes(), contentType: 'image/png', cid: LOGO_CID }],
  };
}
