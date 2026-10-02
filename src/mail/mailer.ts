import nodemailer from 'nodemailer';
import type { Env } from '../config/env.js';

export interface OutgoingMail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  attachments: { filename: string; content: Uint8Array; contentType: string }[];
  /** Feste Message-ID → Empfänger-Server erkennen Duplikate. */
  messageId: string;
}

export interface Mailer {
  send(mail: OutgoingMail): Promise<{ messageId: string }>;
}

export function createMailer(env: Env): Mailer {
  if (!env.SMTP_HOST) {
    throw new Error('SMTP_HOST fehlt – kein Mailversand möglich');
  }
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } } : {}),
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
  return {
    async send(mail) {
      const info = await transport.sendMail({
        from: mail.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        messageId: mail.messageId,
        attachments: mail.attachments.map((a) => ({
          filename: a.filename,
          content: Buffer.from(a.content),
          contentType: a.contentType,
        })),
      });
      return { messageId: info.messageId };
    },
  };
}

/**
 * Empfänger bestimmen. Außerhalb des Live-Betriebs (oder mit gesetzter Testadresse) gehen
 * Mails AUSSCHLIESSLICH an die Testadresse – die eigentlichen Empfänger stehen im Text.
 */
export function resolveRecipients(
  env: Pick<Env, 'APP_ENV' | 'MAIL_TEST_RECIPIENT'>,
  intended: string[],
): { actual: string[]; redirected: boolean } {
  if (env.APP_ENV !== 'live' || env.MAIL_TEST_RECIPIENT) {
    if (!env.MAIL_TEST_RECIPIENT) throw new Error('Testadresse fehlt – Versand gesperrt');
    return { actual: [env.MAIL_TEST_RECIPIENT], redirected: true };
  }
  if (intended.length === 0) throw new Error('Keine Rechnungs-E-Mail-Adresse beim Kunden hinterlegt');
  return { actual: intended, redirected: false };
}
