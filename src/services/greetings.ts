import type { Sql } from '../db/client.js';
import type { Env } from '../config/env.js';
import { hourBerlin, todayBerlin } from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import type { Mailer } from '../mail/mailer.js';
import { resolveRecipients } from '../mail/mailer.js';
import { BusinessError } from './errors.js';
import { loadSignature, NO_PERSON, type MailSignature } from '../mail/compose.js';

/*
 * Glückwünsche per E-Mail (Ahmed 22.10.): zum Geburtstag und zum Jahrestag des Eintritts, im Namen des ganzen Teams
 * und der Geschäftsführung, Absender info@. Je Person/Anlass/Jahr genau einmal (Eintrag vor dem Versand). Nur aktive
 * Mitarbeitende mit E-Mail, nicht bei Widerspruch („keine Glückwünsche“). Das Alter wird nie genannt.
 */

export const BIRTHDAY_DEFAULT = `{anrede}

herzlichen Glückwunsch zum Geburtstag!

Wir wünschen Ihnen alles Gute, vor allem Gesundheit, Glück und einen schönen Tag mit den Menschen, die Ihnen wichtig sind. Danke, dass Sie Teil unseres Teams sind.`;

export const JUBILEE_DEFAULT = `{anrede}

heute sind Sie seit {jahre} bei uns – herzlichen Glückwunsch zum Firmenjubiläum!

Vielen Dank für Ihre Arbeit, Ihre Zuverlässigkeit und Ihren Einsatz in dieser Zeit. Wir freuen uns auf die weitere Zusammenarbeit.`;

export const SIGNED_DEFAULT = `Herzliche Grüße
Ihr gesamtes Viva-Deluxe-Team
und die Geschäftsführung`;

export interface GreetingSettings {
  enabled: boolean;
  from_email: string;
  send_hour: number;
  birthday_text: string | null;
  jubilee_text: string | null;
  signed_by: string | null;
}

export async function getGreetingSettings(sql: Sql): Promise<GreetingSettings> {
  const [s] = await sql<GreetingSettings[]>`
    select enabled, from_email, send_hour, birthday_text, jubilee_text, signed_by
      from app.greeting_settings where id = 1`;
  return (
    s ?? {
      enabled: false,
      from_email: 'info@viva-deluxe-reinigung.de',
      send_hour: 8,
      birthday_text: null,
      jubilee_text: null,
      signed_by: null,
    }
  );
}

export async function saveGreetingSettings(
  sql: Sql,
  p: Omit<GreetingSettings, 'birthday_text' | 'jubilee_text' | 'signed_by'> & {
    birthday_text: string;
    jubilee_text: string;
    signed_by: string;
  },
  actor: string,
) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.from_email)) throw new BusinessError('Absender-E-Mail ungültig');
  if (!(p.send_hour >= 0 && p.send_hour <= 23)) throw new BusinessError('Uhrzeit ungültig');
  // gespeichert wird nur, was vom Standardtext abweicht (sonst kommen spätere Verbesserungen nie an)
  const own = (v: string, d: string) => (v.trim() && v.trim() !== d ? v.trim().slice(0, 4000) : null);
  const row = {
    enabled: p.enabled,
    from_email: p.from_email.trim(),
    send_hour: p.send_hour,
    birthday_text: own(p.birthday_text, BIRTHDAY_DEFAULT),
    jubilee_text: own(p.jubilee_text, JUBILEE_DEFAULT),
    signed_by: own(p.signed_by, SIGNED_DEFAULT),
  };
  await sql`insert into app.greeting_settings ${sql({ id: 1, ...row })}
            on conflict (id) do update set ${sql({ ...row, updated_at: sql`now()` } as never)}`;
  await sql`insert into app.audit_log (actor, action, entity, details)
            values (${actor}, 'save', 'greeting_settings', ${sql.json(row)})`;
}

export interface GreetingDue {
  employee_id: string;
  name: string;
  first_name: string;
  last_name: string;
  salutation: string | null;
  email: string | null;
  kind: 'geburtstag' | 'jubilaeum';
  date: string;
  years: number;
  no_greetings: boolean;
}

/** Geburtstag am 29.02. wird in Nicht-Schaltjahren am 28.02. gefeiert */
const occurrence = (md: string, year: number) => {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return md === '02-29' && !leap ? `${year}-02-28` : `${year}-${md}`;
};

/** Anlässe von `from` bis `to` (höchstens innerhalb zweier Jahre) */
export async function greetingsBetween(sql: Sql, from: string, to: string): Promise<GreetingDue[]> {
  const rows = await sql<
    {
      id: string;
      first_name: string;
      last_name: string;
      salutation: string | null;
      email: string | null;
      email_private: string | null;
      entry_date: string;
      birth_date: string | null;
      no_greetings: boolean;
    }[]
  >`
    select e.id, e.first_name, e.last_name, e.salutation, e.email, e.email_private, e.entry_date::text,
           p.birth_date::text, e.no_greetings
      from app.employees e left join app.employee_private p on p.employee_id = e.id
     where e.status = 'aktiv' and (e.exit_date is null or e.exit_date >= ${from})`;
  const out: GreetingDue[] = [];
  const years = [Number(from.slice(0, 4)), Number(to.slice(0, 4))].filter((y, i, l) => l.indexOf(y) === i);
  for (const r of rows) {
    const base = {
      employee_id: r.id,
      name: `${r.first_name} ${r.last_name}`,
      first_name: r.first_name,
      last_name: r.last_name,
      salutation: r.salutation,
      email: r.email || r.email_private || null,
      no_greetings: r.no_greetings,
    };
    for (const y of years) {
      if (r.birth_date) {
        const d = occurrence(r.birth_date.slice(5), y);
        if (d >= from && d <= to) out.push({ ...base, kind: 'geburtstag', date: d, years: 0 });
      }
      const n = y - Number(r.entry_date.slice(0, 4));
      if (n >= 1) {
        const d = occurrence(r.entry_date.slice(5), y);
        if (d >= from && d <= to) out.push({ ...base, kind: 'jubilaeum', date: d, years: n });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'de'));
}

const anrede = (g: Pick<GreetingDue, 'salutation' | 'first_name' | 'last_name'>) =>
  g.salutation === 'Frau'
    ? `Liebe ${g.first_name},`
    : g.salutation === 'Herr'
      ? `Lieber ${g.first_name},`
      : `Hallo ${g.first_name},`;

export function greetingMail(g: GreetingDue, s: GreetingSettings, sig?: MailSignature) {
  const tpl =
    g.kind === 'geburtstag' ? (s.birthday_text ?? BIRTHDAY_DEFAULT) : (s.jubilee_text ?? JUBILEE_DEFAULT);
  const body = tpl
    .replace(/\{anrede\}/g, anrede(g))
    .replace(/\{vorname\}/g, g.first_name)
    .replace(/\{nachname\}/g, g.last_name)
    .replace(/\{jahre\}/g, `${g.years} ${g.years === 1 ? 'Jahr' : 'Jahren'}`);
  const signed = s.signed_by ?? SIGNED_DEFAULT;
  const subject =
    g.kind === 'geburtstag'
      ? `Alles Gute zum Geburtstag, ${g.first_name}!`
      : `${g.years} ${g.years === 1 ? 'Jahr' : 'Jahre'} bei Viva-Deluxe – herzlichen Glückwunsch, ${g.first_name}!`;
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paras = `${body}\n\n${signed}`
    .trim()
    .split(/\n{2,}/)
    .map((x) => `<p style="margin:0 0 14px">${esc(x).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f6f1f3">
<div style="max-width:560px;margin:0 auto;padding:20px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222">
<div style="background:#7D1435;border-radius:12px 12px 0 0;padding:22px;text-align:center;color:#fff;font-size:22px;font-weight:700">${
    g.kind === 'geburtstag'
      ? '🎉 Alles Gute zum Geburtstag!'
      : `🎉 ${g.years} ${g.years === 1 ? 'Jahr' : 'Jahre'} Viva-Deluxe`
  }</div>
<div style="background:#fff;border-radius:0 0 12px 12px;padding:22px">${paras}</div>
${
  sig
    ? `<div style="background:#fff;border-radius:12px;padding:18px 22px;margin-top:14px;font-size:14px">${sig.html}</div>`
    : '<div style="text-align:center;color:#888;font-size:12px;margin-top:10px">Viva-Deluxe Gebäudereinigung GmbH</div>'
}
</div></body></html>`;
  // Signatur wie bei Rechnungs-Mails (Ahmed 25.10.), ohne Kopf „Buchhaltung“ – Pflichtangaben § 35a GmbHG
  const text = `${body}\n\n${signed}${sig ? `\n\n-- \n${sig.text}` : ''}`;
  return { subject, text, html, inline: sig?.inline ?? [] };
}

/**
 * Prüft (alle 15 Min.), ob heute Glückwünsche fällig sind, und sendet sie ab der eingestellten Uhrzeit genau einmal.
 * Fehler beim Versand werden vermerkt (kein zweiter Versuch – lieber eine fehlende als eine doppelte Gratulation).
 */
export async function sendGreetings(
  deps: { sql: Sql; env: Env; mailer: Mailer },
  now = new Date(),
): Promise<number> {
  const { sql, env, mailer } = deps;
  const s = await getGreetingSettings(sql);
  if (!s.enabled || mailer.configured === false) return 0;
  if (hourBerlin(now) < s.send_hour) return 0;
  const today = todayBerlin(now);
  let sig: MailSignature | undefined;
  const due = (await greetingsBetween(sql, today, today)).filter((g) => g.email && !g.no_greetings);
  let n = 0;
  for (const g of due) {
    const year = Number(today.slice(0, 4));
    const claimed = await sql`insert into app.greeting_sent (employee_id, kind, year, sent_to)
                              values (${g.employee_id}, ${g.kind}, ${year}, ${g.email})
                              on conflict do nothing returning employee_id`;
    if (!claimed.length) continue;
    sig ??= await loadSignature(sql, NO_PERSON);
    const m = greetingMail(g, s, sig);
    const { actual, redirected } = resolveRecipients(env, [g.email!]);
    try {
      await mailer.send({
        from: `Viva-Deluxe Gebäudereinigung <${s.from_email}>`,
        to: actual,
        subject: `${redirected ? '[TEST] ' : ''}${m.subject}`,
        text: (redirected ? `*** TESTVERSAND – eigentlich an ${g.email} ***\n\n` : '') + m.text,
        html: m.html,
        inline: m.inline,
        attachments: [],
        messageId: `<gruss-${g.kind}-${year}-${g.employee_id}@viva-deluxe-app>`,
      });
      n++;
    } catch (e) {
      await sql`update app.greeting_sent set status = 'fehler', error = ${String(e).slice(0, 500)}
                 where employee_id = ${g.employee_id} and kind = ${g.kind} and year = ${year}`;
    }
  }
  return n;
}

export async function recentGreetings(sql: Sql, since = addDays(todayBerlin(), -60)) {
  return sql<
    {
      name: string;
      kind: string;
      year: number;
      sent_to: string | null;
      status: string;
      error: string | null;
      created_at: string;
    }[]
  >`
    select e.first_name || ' ' || e.last_name as name, g.kind, g.year, g.sent_to, g.status, g.error,
           to_char(g.created_at at time zone 'Europe/Berlin', 'DD.MM.YYYY HH24:MI') as created_at
      from app.greeting_sent g join app.employees e on e.id = g.employee_id
     where g.created_at >= ${since} order by g.created_at desc limit 100`;
}

export async function setNoGreetings(sql: Sql, employeeId: string, off: boolean, actor: string) {
  await sql`update app.employees set no_greetings = ${off} where id = ${employeeId}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'no_greetings', 'employee', ${employeeId}, ${sql.json({ aus: off })})`;
}
