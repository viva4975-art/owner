import nodemailer from 'nodemailer';
import type { Env } from '../config/env.js';

export interface OutgoingMail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  /** HTML-Fassung (mit Logo/Signatur); Text bleibt für Programme ohne HTML */
  html?: string;
  /** im HTML eingebettete Bilder (cid) */
  inline?: { filename: string; content: Uint8Array; contentType: string; cid: string }[];
  attachments: { filename: string; content: Uint8Array; contentType: string }[];
  /** Feste Message-ID → Empfänger-Server erkennen Duplikate. */
  messageId: string;
}

export interface Mailer {
  send(mail: OutgoingMail): Promise<{ messageId: string }>;
  /** false = kein SMTP-Zugang hinterlegt; Versand wird vorab abgelehnt (App startet trotzdem). */
  configured?: boolean;
}

export const MAILER_MISSING =
  'Mailversand ist noch nicht eingerichtet (SMTP-Zugang fehlt) – bitte PDF herunterladen und selbst senden.';

/** Mailer für Glückwünsche: eigener Zugang (GREETING_SMTP_USER/PASS), sonst der normale. */
export function createGreetingMailer(env: Env): Mailer {
  if (!env.GREETING_SMTP_USER) return createMailer(env);
  return createMailer({ ...env, SMTP_USER: env.GREETING_SMTP_USER, SMTP_PASS: env.GREETING_SMTP_PASS ?? '' });
}

export function createMailer(env: Env): Mailer {
  if (!env.SMTP_HOST) {
    return {
      configured: false,
      send: () => Promise.reject(new Error(MAILER_MISSING)),
    };
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
  // Drosselung (Fund 20.10.: IONOS Exchange lehnte den Sammelversand ab – „421 4.4.2 Message submission rate …
  // exceeded“): Mails nacheinander mit Mindestabstand; bei Rate-Limit warten und denselben Versuch wiederholen.
  // Abgelehnt beim MAIL FROM/RCPT TO = noch nichts übertragen → Wiederholung kann nichts doppelt senden.
  let queue: Promise<unknown> = Promise.resolve();
  let last = 0;
  const transmit = async (mail: OutgoingMail) => {
    for (let attempt = 0; ; attempt++) {
      const wait = last + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      try {
        return await sendOnce(mail);
      } catch (err) {
        if (attempt >= RATE_RETRIES || !isRateLimited(err)) throw err;
        await sleep(RATE_WAIT_MS * (attempt + 1));
      }
    }
  };
  const sendOnce = async (mail: OutgoingMail) => {
    const info = await transport.sendMail({
      from: mail.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
      messageId: mail.messageId,
      attachments: [
        ...mail.attachments.map((a) => ({
          filename: a.filename,
          content: Buffer.from(a.content),
          contentType: a.contentType,
        })),
        ...(mail.html
          ? (mail.inline ?? []).map((a) => ({
              filename: a.filename,
              content: Buffer.from(a.content),
              contentType: a.contentType,
              cid: a.cid,
            }))
          : []),
      ],
    });
    return { messageId: info.messageId };
  };
  return {
    send(mail) {
      const run = queue.then(() => transmit(mail));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

const MIN_INTERVAL_MS = 2500; // ≤ 24 Mails/Minute (Exchange-Standard: 30)
const RATE_WAIT_MS = 60_000;
const RATE_RETRIES = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mailserver bremst (zu viele Mails in kurzer Zeit) – nur vor der Übertragung abgelehnt. */
export function isRateLimited(err: unknown): boolean {
  const e = err as { responseCode?: number; message?: string };
  return (
    !!e &&
    [421, 450, 451, 452].includes(e.responseCode ?? 0) &&
    /rate|limit|too many|try again later/i.test(e.message ?? '') &&
    notTransmitted(e.message ?? '')
  );
}

/**
 * Fehlertext eines Versands, bei dem die Mail sicher NICHT übertragen wurde (Ablehnung vor DATA, Anmeldung,
 * Verbindung). Nur dann darf ein fehlgeschlagener Versand ohne Rückfrage erneut gesendet werden.
 */
export function notTransmitted(error: string | null | undefined): boolean {
  return /^(Versand fehlgeschlagen: )?(Mail command failed|Recipient command failed|Can't send mail - all recipients were rejected|Invalid login|Connection timeout|Greeting never received|connect E|getaddrinfo|Mailversand ist noch nicht eingerichtet)/i.test(
    error ?? '',
  );
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
