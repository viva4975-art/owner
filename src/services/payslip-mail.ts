import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from '@cantoo/pdf-lib';
import type { Sql } from '../db/client.js';
import type { Env } from '../config/env.js';
import { personGreeting } from '../domain/letter/greeting.js';
import { composeMail, loadSignature, withDataUris, type MailSignature } from '../mail/compose.js';
import { MAILER_MISSING, resolveRecipients, type Mailer } from '../mail/mailer.js';
import { BusinessError } from './errors.js';
import { monthLabel } from './payslips.js';
import { filePath, type FileRow, type UploadConfig } from './uploads.js';

/*
 * Lohnabrechnungen per E-Mail (Ahmed 05.11.): Personen auswählen, das PDF wird mit dem Geburtsdatum (TTMMJJ) als
 * Passwort verschlüsselt (AES-256) und von der Buchhaltungs-Adresse (MAIL_FROM) gesendet. Das Passwort steht nicht in
 * der Mail, nur die Regel. Je Abrechnung genau ein Versand (feste ID); „erneut senden“ nur ausdrücklich.
 */

const uuidFrom = (s: string) => {
  const h = createHash('md5').update(s).digest('hex').split('');
  h[12] = '4';
  h[16] = '89ab'[parseInt(h[16]!, 16) % 4]!;
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

/** Geburtsdatum „1990-01-31“ → Passwort „310190“ */
export function birthPassword(birth: string | Date | null | undefined): string | null {
  if (!birth) return null;
  const iso = typeof birth === 'string' ? birth.slice(0, 10) : birth.toISOString().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}${m[2]}${m[1]!.slice(2)}` : null;
}

/** PDF mit Passwort zum Öffnen; Besitzer-Passwort zufällig (Drucken erlaubt, Ändern nicht). */
export async function encryptPdf(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  doc.encrypt({
    userPassword: password,
    ownerPassword: randomBytes(24).toString('base64url'),
    algorithm: 'AES-256',
    permissions: {
      printing: 'highResolution',
      modifying: false,
      copying: false,
      annotating: false,
      fillingForms: false,
      contentAccessibility: true,
      documentAssembly: false,
    },
  });
  return doc.save({ useObjectStreams: false });
}

const fromAddress = (env: Pick<Env, 'MAIL_FROM'>) => {
  const addr = /<([^>]+)>/.exec(env.MAIL_FROM)?.[1] ?? env.MAIL_FROM.trim();
  return `Viva-Deluxe Buchhaltung <${addr}>`;
};

export const payslipSubject = (label: string) => `Ihre Lohnabrechnung ${label}`;

/** Text der Lohn-Mail (Versand und Vorschau gleich). `testFor` = Testversand, eigentlicher Empfänger. */
export function payslipMailText(
  p: { salutation: string | null; first_name: string; last_name: string },
  label: string,
  signature: MailSignature,
  testFor?: string | null,
) {
  const body = [
    personGreeting(p),
    '',
    `anbei erhalten Sie Ihre Lohnabrechnung für ${label}.`,
    '',
    'Die PDF-Datei ist mit einem Passwort geschützt. Das Passwort ist Ihr Geburtsdatum im Format TTMMJJ ' +
      '(Tag, Monat, Jahr – jeweils zweistellig, ohne Punkte). Beispiel: Geburtstag 05.03.1985 → 050385.',
    '',
    'Bei Fragen zur Abrechnung melden Sie sich bitte bei der Buchhaltung.',
  ].join('\n');
  return composeMail({ notice: testFor ? `TESTVERSAND – eigentlich an ${testFor}` : null, body, signature });
}

/** Vorschau für eine Abrechnung bzw. eine Beispielperson: Kopfzeilen + HTML mit eingebetteten Bildern. */
export async function payslipMailPreview(sql: Sql, env: Env, fileId?: string) {
  const [p] = fileId
    ? await sql<
        {
          salutation: string | null;
          first_name: string;
          last_name: string;
          email: string | null;
          month: string;
          personnel_no: string;
        }[]
      >`select e.salutation, e.first_name, e.last_name, nullif(trim(e.email), '') as email, p.month, e.personnel_no
          from app.payslips p join app.employees e on e.id = p.employee_id where p.file_id = ${fileId}`
    : [];
  const person = p ?? {
    salutation: 'Frau',
    first_name: 'Maria',
    last_name: 'Beispiel',
    email: 'maria.beispiel@example.org',
    month: new Date().toISOString().slice(0, 7),
    personnel_no: '1001',
  };
  const label = monthLabel(person.month);
  const sig = await loadSignature(sql);
  const m = payslipMailText(person, label, sig);
  return {
    from: fromAddress(env),
    to: person.email ?? '(keine E-Mail-Adresse)',
    subject: payslipSubject(label),
    attachment: `Lohnabrechnung_${person.month}_${person.personnel_no}.pdf (mit Passwort)`,
    html: withDataUris(m.html ?? '', m.inline ?? []),
    example: !p,
  };
}

export interface PayslipMailRow {
  file_id: string;
  status: string;
  sent_to: string | null;
  error: string | null;
  at: Date;
}

/** letzter Versand je Abrechnung */
export async function payslipMailStatus(sql: Sql, fileIds: string[]) {
  if (!fileIds.length) return new Map<string, PayslipMailRow>();
  const rows = await sql<PayslipMailRow[]>`
    select distinct on (file_id) file_id, status, sent_to, error, coalesce(sent_at, created_at) as at
      from app.payslip_mails where file_id = any(${fileIds}::uuid[])
     order by file_id, created_at desc`;
  return new Map(rows.map((r) => [r.file_id, r]));
}

/** Angaben zum Versand je Abrechnung (E-Mail, Geburtsdatum vorhanden?) */
export async function payslipRecipients(sql: Sql, fileIds: string[]) {
  if (!fileIds.length) return new Map<string, { email: string | null; has_birth: boolean }>();
  const rows = await sql<{ file_id: string; email: string | null; has_birth: boolean }[]>`
    select p.file_id, nullif(trim(e.email), '') as email, ep.birth_date is not null as has_birth
      from app.payslips p join app.employees e on e.id = p.employee_id
      left join app.employee_private ep on ep.employee_id = e.id
     where p.file_id = any(${fileIds}::uuid[])`;
  return new Map(rows.map((r) => [r.file_id, { email: r.email, has_birth: r.has_birth }]));
}

/**
 * Eine Abrechnung senden. `again` (Formular-ID) = bewusst erneut senden; ohne geht jede Abrechnung höchstens
 * einmal raus (läuft oder gesendet → nichts). Ein fehlgeschlagener Versand darf wiederholt werden.
 */
export async function sendPayslip(
  deps: { sql: Sql; env: Env; mailer: Mailer },
  cfg: UploadConfig,
  fileId: string,
  actor: string,
  again?: string,
): Promise<void> {
  const { sql, env, mailer } = deps;
  if (mailer.configured === false) throw new BusinessError(MAILER_MISSING);
  const [p] = await sql<
    {
      employee_id: string;
      month: string;
      first_name: string;
      last_name: string;
      salutation: string | null;
      personnel_no: string;
      email: string | null;
      birth_date: string | null;
      mail_skip_reason: string | null;
      mail_skip_at: Date | null;
    }[]
  >`
    select p.employee_id, p.month, e.first_name, e.last_name, e.salutation, e.personnel_no,
           nullif(trim(e.email), '') as email, to_char(ep.birth_date, 'YYYY-MM-DD') as birth_date,
           p.mail_skip_reason, p.mail_skip_at
      from app.payslips p join app.employees e on e.id = p.employee_id
      left join app.employee_private ep on ep.employee_id = e.id
     where p.file_id = ${fileId}`;
  if (!p) throw new BusinessError('Lohnabrechnung nicht gefunden');
  const name = `${p.first_name} ${p.last_name}`;
  if (!p.email) throw new BusinessError(`${name}: keine E-Mail-Adresse in den Stammdaten`);
  if (p.mail_skip_at)
    throw new BusinessError(
      `${name}: ausgeblendet – kein E-Mail-Versand${p.mail_skip_reason ? ` (${p.mail_skip_reason})` : ''}`,
    );
  const pw = birthPassword(p.birth_date);
  if (!pw) throw new BusinessError(`${name}: Geburtsdatum fehlt – ohne Passwort wird nicht gesendet`);
  const [prev] = await sql<{ status: string }[]>`
    select status from app.payslip_mails where file_id = ${fileId} order by created_at desc limit 1`;
  const sentBefore = !!prev && prev.status !== 'fehler';
  // „noch einmal senden“ gilt nur für schon gesendete; alles andere ist der erste Versand
  if (!sentBefore) again = undefined;
  else if (!again) throw new BusinessError(`${name}: ${monthLabel(p.month)} wurde schon gesendet`);
  const [f] = await sql<FileRow[]>`select * from app.files where id = ${fileId} and status = 'complete'`;
  if (!f) throw new BusinessError(`${name}: Datei nicht gefunden`);
  const pdf = await encryptPdf(new Uint8Array(await readFile(filePath(cfg, f))), pw);

  // feste ID: erster Versand je Abrechnung bzw. je „erneut senden“-Formular → doppelt absenden sendet nichts doppelt;
  // nach einem Fehler wird derselbe Eintrag wieder übernommen
  const id = uuidFrom(`lohnmail:${fileId}:${again ?? 'erst'}`);
  const claimed = await sql`
    insert into app.payslip_mails (id, file_id, employee_id, month, sent_to, sent_by)
    values (${id}, ${fileId}, ${p.employee_id}, ${p.month}, ${p.email}, ${actor})
    on conflict (id) do update set status = 'laeuft', error = null, sent_to = excluded.sent_to,
                                   sent_by = excluded.sent_by, created_at = now()
     where app.payslip_mails.status = 'fehler'
    returning id`;
  if (!claimed.length) return;

  const label = monthLabel(p.month);
  const { actual, redirected } = resolveRecipients(env, [p.email]);
  const mail = payslipMailText(p, label, await loadSignature(sql), redirected ? p.email : null);
  try {
    await mailer.send({
      from: fromAddress(env),
      to: actual,
      subject: `${redirected ? '[TEST] ' : ''}${payslipSubject(label)}`,
      ...mail,
      attachments: [
        {
          filename: `Lohnabrechnung_${p.month}_${p.personnel_no}.pdf`,
          content: pdf,
          contentType: 'application/pdf',
        },
      ],
      messageId: `<lohn-${id}@viva-deluxe-app>`,
    });
  } catch (e) {
    await sql`update app.payslip_mails set status = 'fehler', error = ${String((e as Error).message ?? e).slice(0, 500)}
               where id = ${id}`;
    throw new BusinessError(`${name}: ${(e as Error).message}`);
  }
  await sql`update app.payslip_mails set status = 'gesendet', sent_at = now() where id = ${id}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'payslip_mail', 'employee', ${p.employee_id},
                    ${sql.json({ month: p.month, file_id: fileId, to: p.email, again: !!again })})`;
}

/** Abrechnungen vom Versand ausnehmen bzw. wieder einblenden (Grund optional, Protokoll). */
export async function setPayslipMailSkip(
  sql: Sql,
  fileIds: string[],
  skip: boolean,
  actor: string,
  reason?: string | null,
): Promise<number> {
  if (!fileIds.length) return 0;
  const why = reason?.trim().slice(0, 200) || null;
  const r = skip
    ? await sql`update app.payslips set mail_skip_reason = ${why}, mail_skip_at = now(), mail_skip_by = ${actor}
                 where file_id = any(${fileIds}::uuid[]) and mail_skip_at is null returning file_id`
    : await sql`update app.payslips set mail_skip_reason = null, mail_skip_at = null, mail_skip_by = null
                 where file_id = any(${fileIds}::uuid[]) and mail_skip_at is not null returning file_id`;
  if (r.length)
    await sql`insert into app.audit_log (actor, action, entity, details)
              values (${actor}, ${skip ? 'payslip_mail_skip' : 'payslip_mail_unskip'}, 'payslips',
                      ${sql.json({ files: r.map((x) => x.file_id), reason: why })})`;
  return r.length;
}

/** Monate mit Lohnabrechnungen: gesamt, noch offen (nicht gesendet, nicht ausgeblendet), neueste zuerst. */
export async function payslipMonths(sql: Sql) {
  return sql<{ month: string; total: number; open: number }[]>`
    select p.month, count(*)::int as total,
           count(*) filter (where p.mail_skip_at is null and coalesce(m.status, 'fehler') = 'fehler')::int as open
      from app.payslips p
      left join lateral (select status from app.payslip_mails x where x.file_id = p.file_id
                          order by x.created_at desc limit 1) m on true
     group by p.month order by p.month desc`;
}
