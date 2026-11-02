import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Env } from '../config/env.js';
import type { Sql } from '../db/client.js';
import { unescapeXml } from '../domain/xml.js';
import { BusinessError } from './errors.js';
import { ntlmPost } from './ntlm.js';

/*
 * Outlook-Kalender (IONOS Exchange) in der App (Ahmed 01.11.): Jede Person verbindet ihr eigenes Postfach (E-Mail +
 * Passwort, verschlüsselt auf dem Server gespeichert) und sieht/pflegt danach ihren Exchange-Kalender in der App –
 * Termine mit Ort, Notiz und Erinnerung. Es wird nichts automatisch eingetragen; die App spricht nur, wenn jemand den
 * Kalender öffnet oder einen Termin speichert. Schnittstelle: Exchange Web Services (EWS, SOAP), Anmeldung per Basic
 * über HTTPS, sonst NTLM (IONOS, `ntlm.ts`). Erinnerungen löst Exchange selbst aus (Outlook, Handy).
 */

export const TZ_ID = 'W. Europe Standard Time';
const IONOS_GUESSES = [
  'https://exchange2019.ionos.de/EWS/Exchange.asmx',
  'https://exchange.ionos.eu/EWS/Exchange.asmx',
  'https://exchange.ionos.de/EWS/Exchange.asmx',
];
const AUTODISCOVER = (domain: string) => [
  `https://autodiscover.${domain}/autodiscover/autodiscover.xml`,
  `https://${domain}/autodiscover/autodiscover.xml`,
  'https://autodiscover.1and1.info/autodiscover/autodiscover.xml',
];

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
let fetcher: Fetcher = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
/** Nur für Tests. */
export function setExchangeFetcher(f: Fetcher | null) {
  fetcher = f ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }));
}

// ---------------------------------------------------------------- Passwort verschlüsselt

function secretKey(env: Pick<Env, 'SESSION_SECRET' | 'APP_BASIC_AUTH'>) {
  return createHash('sha256')
    .update(`exchange:${env.SESSION_SECRET ?? `dev-session:${env.APP_BASIC_AUTH}`}`)
    .digest();
}
export function encryptSecret(env: Pick<Env, 'SESSION_SECRET' | 'APP_BASIC_AUTH'>, s: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secretKey(env), iv);
  const data = Buffer.concat([c.update(s, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}
export function decryptSecret(env: Pick<Env, 'SESSION_SECRET' | 'APP_BASIC_AUTH'>, enc: string) {
  const [iv, tag, data] = enc.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', secretKey(env), iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(data!), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------- Zeit (Ortszeit Berlin ↔ UTC)

function berlinOffsetMs(d: Date) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Berlin',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(d);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return (
    Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second')) - d.getTime()
  );
}
/** Ortszeit Berlin „JJJJ-MM-TT“ + „HH:MM“ → Zeitpunkt (Sommer-/Winterzeit richtig). */
export function berlinToDate(date: string, hm = '00:00'): Date {
  const guess = new Date(`${date}T${hm}:00Z`);
  const first = guess.getTime() - berlinOffsetMs(guess);
  return new Date(guess.getTime() - berlinOffsetMs(new Date(first)));
}
/** Zeitpunkt → Ortszeit Berlin { date, time }. */
export function dateToBerlin(d: Date): { date: string; time: string } {
  const l = new Date(d.getTime() + berlinOffsetMs(d)).toISOString();
  return { date: l.slice(0, 10), time: l.slice(11, 16) };
}
const isoZ = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---------------------------------------------------------------- SOAP

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function envelope(body: string) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"' +
    ' xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"' +
    ' xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">' +
    '<soap:Header><t:RequestServerVersion Version="Exchange2013_SP1"/>' +
    `<t:TimeZoneContext><t:TimeZoneDefinition Id="${TZ_ID}"/></t:TimeZoneContext></soap:Header>` +
    `<soap:Body>${body}</soap:Body></soap:Envelope>`
  );
}

/** Kleiner Leser für EWS-Antworten: Namensraum-Präfixe werden ignoriert. */
function blocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>)`, 'g');
  const out: string[] = [];
  for (const m of xml.matchAll(re)) out.push(m[0]);
  return out;
}
function text(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`);
  const m = re.exec(xml);
  return m ? unescapeXml(m[1]!) : null;
}
function attr(xml: string, tag: string, name: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\s[^>]*?\\b${name}="([^"]*)"`);
  const m = re.exec(xml);
  return m ? unescapeXml(m[1]!) : null;
}

export interface ExchangeCreds {
  url: string;
  user: string;
  password: string;
}

/** Adressen, die nur NTLM annehmen (IONOS), damit nicht jede Anfrage erst an Basic scheitert. */
const ntlmOnly = new Set<string>();

async function call(cr: ExchangeCreds, body: string): Promise<string> {
  const key = `${cr.url}|${cr.user}`;
  let status = 0;
  let xml = '';
  let offered = '';
  const viaNtlm = async () => {
    const r = await ntlmPost(cr.url, cr.user, cr.password, envelope(body), 'text/xml; charset=utf-8');
    status = r.status;
    xml = r.body;
    if (status !== 401) ntlmOnly.add(key);
  };
  try {
    if (ntlmOnly.has(key)) await viaNtlm();
    else {
      const res = await fetcher(cr.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          Authorization: `Basic ${Buffer.from(`${cr.user}:${cr.password}`, 'utf8').toString('base64')}`,
        },
        body: envelope(body),
      });
      status = res.status;
      xml = await res.text();
      offered = res.headers?.get?.('www-authenticate') ?? '';
      // IONOS Exchange nimmt oft nur NTLM an (Ahmed 02.11.) – dann damit noch einmal
      if (status === 401 && /\b(NTLM|Negotiate)\b/i.test(offered)) await viaNtlm();
    }
  } catch (e) {
    throw new BusinessError(
      `Exchange-Server nicht erreichbar (${(e as Error).name === 'TimeoutError' ? 'Zeitüberschreitung' : (e as Error).message})`,
    );
  }
  const res = { status, ok: status >= 200 && status < 300 };
  if (res.status === 401)
    throw new BusinessError(
      `Anmeldung bei Exchange abgelehnt – E-Mail-Adresse oder Passwort falsch${
        offered
          ? ` (Server ${new URL(cr.url).host} bietet: ${offered.replace(/\s+[A-Za-z0-9+/=]{20,}/g, '').slice(0, 80)})`
          : ''
      }`,
      'ews_auth',
    );
  if (res.status === 404) throw new BusinessError('Exchange-Adresse nicht gefunden (EWS)', 'ews_url');
  const fault = text(xml, 'faultstring');
  if (fault) throw new BusinessError(`Exchange meldet: ${fault}`);
  if (!res.ok) throw new BusinessError(`Exchange antwortet mit Fehler ${res.status}`);
  const bad = blocks(xml, '\\w+ResponseMessage').find((b) => /ResponseClass="Error"/.test(b));
  if (bad) {
    const code = text(bad, 'ResponseCode') ?? '';
    const msg = text(bad, 'MessageText') ?? code;
    if (code === 'ErrorItemNotFound') throw new BusinessError('Termin nicht gefunden (inzwischen gelöscht?)');
    if (code === 'ErrorIrresolvableConflict')
      throw new BusinessError('Der Termin wurde inzwischen in Outlook geändert – bitte neu öffnen');
    throw new BusinessError(`Exchange meldet: ${msg}`);
  }
  return xml;
}

// ---------------------------------------------------------------- Konto verbinden

export interface ExchangeAccount {
  user_id: string;
  email: string;
  login: string;
  ews_url: string;
  last_ok_at: Date | null;
  last_error: string | null;
}

async function autodiscover(email: string, login: string, password: string): Promise<string | null> {
  const domain = email.split('@')[1] ?? '';
  const req =
    '<?xml version="1.0" encoding="utf-8"?><Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006">' +
    `<Request><EMailAddress>${esc(email)}</EMailAddress>` +
    '<AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema>' +
    '</Request></Autodiscover>';
  for (const url of AUTODISCOVER(domain)) {
    try {
      const res = await fetcher(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          Authorization: `Basic ${Buffer.from(`${login}:${password}`, 'utf8').toString('base64')}`,
        },
        body: req,
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const ews = text(xml, 'EwsUrl') ?? text(xml, 'ASUrl');
      if (ews?.startsWith('https://')) return ews.trim();
    } catch {
      // nächster Versuch
    }
  }
  return null;
}

/** Kurzer Test: Kalenderordner lesen (bestätigt Adresse + Zugang). */
async function probe(cr: ExchangeCreds) {
  await call(
    cr,
    '<m:GetFolder><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape>' +
      '<m:FolderIds><t:DistinguishedFolderId Id="calendar"/></m:FolderIds></m:GetFolder>',
  );
}

/**
 * Server-Adresse großzügig lesen (Ahmed 02.11.: „muss mit https:// beginnen“): nur Rechnername
 * („exchange2019.ionos.de“), Postausgang/-eingang („smtp.exchange2019.ionos.de“), OWA-Adresse oder volle EWS-Adresse.
 */
export function normalizeEwsUrl(raw: string): string {
  let s = raw.trim();
  if (!s) return '';
  s = s.replace(/^[a-z]+:\/\//i, '');
  const slash = s.indexOf('/');
  let host = (slash < 0 ? s : s.slice(0, slash)).replace(/:\d+$/, '').toLowerCase();
  let path = slash < 0 ? '' : s.slice(slash);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host))
    throw new BusinessError('Server-Adresse ungültig (z. B. exchange2019.ionos.de)');
  if (!/\/ews\//i.test(path)) {
    host = host.replace(/^(smtp|imap|pop3?)\./, '');
    path = '/EWS/Exchange.asmx';
  }
  return `https://${host}${path}`;
}

export async function connectAccount(
  sql: Sql,
  env: Pick<Env, 'SESSION_SECRET' | 'APP_BASIC_AUTH'>,
  p: { userId: string; email: string; login?: string | null; password: string; url?: string | null },
) {
  const email = p.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BusinessError('E-Mail-Adresse ungültig');
  if (!p.password) throw new BusinessError('Passwort fehlt');
  const login = (p.login ?? '').trim() || email;
  const url = normalizeEwsUrl(p.url ?? '');
  const found = url ? url : await autodiscover(email, login, p.password);
  const candidates = [...new Set([...(found ? [found] : []), ...IONOS_GUESSES])];
  let lastErr: unknown = null;
  let authErr: BusinessError | null = null;
  for (const u of candidates) {
    try {
      await probe({ url: u, user: login, password: p.password });
      await sql`
        insert into app.exchange_accounts (user_id, email, login, ews_url, secret_enc, last_ok_at, last_error)
        values (${p.userId}, ${email}, ${login}, ${u}, ${encryptSecret(env, p.password)}, now(), null)
        on conflict (user_id) do update set email = excluded.email, login = excluded.login,
          ews_url = excluded.ews_url, secret_enc = excluded.secret_enc, last_ok_at = now(), last_error = null,
          connected_at = now()`;
      return u;
    } catch (e) {
      lastErr = e;
      // falsches Passwort bei einer erreichbaren Adresse → am Ende genau das melden
      if (e instanceof BusinessError && e.code === 'ews_auth') authErr ??= e;
    }
  }
  if (authErr) throw authErr;
  throw new BusinessError(
    `Verbindung nicht möglich${lastErr instanceof Error ? ` (${lastErr.message})` : ''}. Bitte Server-Adresse aus IONOS eintragen (Exchange → Einstellungen, z. B. https://…/EWS/Exchange.asmx).`,
  );
}

export async function getAccount(sql: Sql, userId: string): Promise<ExchangeAccount | null> {
  const [a] = await sql<ExchangeAccount[]>`
    select user_id, email, login, ews_url, last_ok_at, last_error from app.exchange_accounts where user_id = ${userId}`;
  return a ?? null;
}

export async function disconnectAccount(sql: Sql, userId: string) {
  await sql`delete from app.exchange_accounts where user_id = ${userId}`;
}

async function credsOf(sql: Sql, env: Pick<Env, 'SESSION_SECRET' | 'APP_BASIC_AUTH'>, userId: string) {
  const [a] = await sql<{ ews_url: string; login: string; secret_enc: string }[]>`
    select ews_url, login, secret_enc from app.exchange_accounts where user_id = ${userId}`;
  if (!a) throw new BusinessError('Kein Outlook-Konto verbunden', 'ews_none');
  let password: string;
  try {
    password = decryptSecret(env, a.secret_enc);
  } catch {
    throw new BusinessError('Gespeichertes Passwort nicht lesbar – bitte Konto neu verbinden', 'ews_none');
  }
  return { url: a.ews_url, user: a.login, password } satisfies ExchangeCreds;
}

async function withCreds<T>(
  sql: Sql,
  env: Pick<Env, 'SESSION_SECRET' | 'APP_BASIC_AUTH'>,
  userId: string,
  fn: (cr: ExchangeCreds) => Promise<T>,
): Promise<T> {
  const cr = await credsOf(sql, env, userId);
  try {
    const r = await fn(cr);
    await sql`update app.exchange_accounts set last_ok_at = now(), last_error = null where user_id = ${userId}`;
    return r;
  } catch (e) {
    if (e instanceof BusinessError && e.code === 'ews_auth')
      await sql`update app.exchange_accounts set last_error = ${e.message} where user_id = ${userId}`;
    throw e;
  }
}

// ---------------------------------------------------------------- Termine

export interface CalEvent {
  id: string;
  changeKey: string;
  subject: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location: string;
  reminder: number | null; // Minuten vorher, null = keine
  busy: string;
  recurring: boolean;
  organizer: string;
  body?: string;
}

const PROPS = [
  'item:Subject',
  'calendar:Start',
  'calendar:End',
  'calendar:Location',
  'calendar:IsAllDayEvent',
  'item:ReminderIsSet',
  'item:ReminderMinutesBeforeStart',
  'calendar:LegacyFreeBusyStatus',
  'calendar:IsRecurring',
  'calendar:Organizer',
]
  .map((f) => `<t:FieldURI FieldURI="${f}"/>`)
  .join('');

function parseItem(x: string): CalEvent {
  const remSet = text(x, 'ReminderIsSet') === 'true';
  return {
    id: attr(x, 'ItemId', 'Id') ?? '',
    changeKey: attr(x, 'ItemId', 'ChangeKey') ?? '',
    subject: text(x, 'Subject') ?? '(ohne Betreff)',
    start: new Date(text(x, 'Start') ?? 0),
    end: new Date(text(x, 'End') ?? 0),
    allDay: text(x, 'IsAllDayEvent') === 'true',
    location: text(x, 'Location') ?? '',
    reminder: remSet ? Number(text(x, 'ReminderMinutesBeforeStart') ?? 15) : null,
    busy: text(x, 'LegacyFreeBusyStatus') ?? 'Busy',
    recurring: text(x, 'IsRecurring') === 'true',
    organizer: text(blocks(x, 'Organizer')[0] ?? '', 'Name') ?? '',
    ...(text(x, 'Body') !== null ? { body: text(x, 'Body')! } : {}),
  };
}

/** Termine im Zeitraum [from, to) – Ortszeit Berlin, Serien als einzelne Vorkommen. */
export async function listEvents(
  sql: Sql,
  env: Pick<Env, 'SESSION_SECRET' | 'APP_BASIC_AUTH'>,
  userId: string,
  from: string,
  to: string,
): Promise<CalEvent[]> {
  return withCreds(sql, env, userId, async (cr) => {
    const xml = await call(
      cr,
      '<m:FindItem Traversal="Shallow"><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape>' +
        `<t:AdditionalProperties>${PROPS}</t:AdditionalProperties></m:ItemShape>` +
        `<m:CalendarView MaxEntriesReturned="1000" StartDate="${isoZ(berlinToDate(from))}" EndDate="${isoZ(berlinToDate(to))}"/>` +
        '<m:ParentFolderIds><t:DistinguishedFolderId Id="calendar"/></m:ParentFolderIds></m:FindItem>',
    );
    return blocks(xml, 'CalendarItem')
      .map(parseItem)
      .sort((a, b) => a.start.getTime() - b.start.getTime());
  });
}

export async function getEvent(
  sql: Sql,
  env: Pick<Env, 'SESSION_SECRET' | 'APP_BASIC_AUTH'>,
  userId: string,
  id: string,
): Promise<CalEvent> {
  return withCreds(sql, env, userId, async (cr) => {
    const xml = await call(
      cr,
      '<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:BodyType>Text</t:BodyType>' +
        `<t:AdditionalProperties>${PROPS}<t:FieldURI FieldURI="item:Body"/></t:AdditionalProperties></m:ItemShape>` +
        `<m:ItemIds><t:ItemId Id="${esc(id)}"/></m:ItemIds></m:GetItem>`,
    );
    const it = blocks(xml, 'CalendarItem')[0];
    if (!it) throw new BusinessError('Termin nicht gefunden');
    return parseItem(it);
  });
}

export interface EventInput {
  subject: string;
  date: string; // Beginn (Ortszeit)
  start: string; // HH:MM (ganztägig ignoriert)
  endDate: string;
  end: string;
  allDay: boolean;
  location: string;
  body: string;
  reminder: number | null;
  busy: 'Busy' | 'Free' | 'Tentative' | 'OOF';
}

export const REMINDERS: [number | null, string][] = [
  [null, 'keine Erinnerung'],
  [0, 'zum Beginn'],
  [5, '5 Minuten vorher'],
  [15, '15 Minuten vorher'],
  [30, '30 Minuten vorher'],
  [60, '1 Stunde vorher'],
  [120, '2 Stunden vorher'],
  [1440, '1 Tag vorher'],
  [2880, '2 Tage vorher'],
  [10080, '1 Woche vorher'],
];

/** Prüft die Eingabe und rechnet Beginn/Ende als Zeitpunkte (ganztägig: Mitternacht bis Mitternacht nach Ende). */
export function normalizeEvent(e: EventInput): { start: Date; end: Date } {
  const subject = e.subject.trim();
  if (!subject) throw new BusinessError('Betreff fehlt');
  if (subject.length > 255) throw new BusinessError('Betreff ist zu lang (max. 255 Zeichen)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw new BusinessError('Datum fehlt');
  const endDate = /^\d{4}-\d{2}-\d{2}$/.test(e.endDate) ? e.endDate : e.date;
  if (e.allDay) {
    if (endDate < e.date) throw new BusinessError('Ende liegt vor dem Beginn');
    const next = new Date(`${endDate}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return { start: berlinToDate(e.date), end: berlinToDate(next.toISOString().slice(0, 10)) };
  }
  if (!/^\d{2}:\d{2}$/.test(e.start) || !/^\d{2}:\d{2}$/.test(e.end))
    throw new BusinessError('Uhrzeit von/bis fehlt');
  const start = berlinToDate(e.date, e.start);
  const end = berlinToDate(endDate, e.end);
  if (end <= start) throw new BusinessError('Ende muss nach dem Beginn liegen');
  return { start, end };
}

function itemXml(e: EventInput, t: { start: Date; end: Date }) {
  // Reihenfolge laut EWS-Schema: Item-Felder, dann Kalender-Felder
  return (
    `<t:Subject>${esc(e.subject.trim())}</t:Subject>` +
    `<t:Body BodyType="Text">${esc(e.body)}</t:Body>` +
    `<t:ReminderIsSet>${e.reminder !== null}</t:ReminderIsSet>` +
    (e.reminder !== null
      ? `<t:ReminderMinutesBeforeStart>${e.reminder}</t:ReminderMinutesBeforeStart>`
      : '') +
    `<t:Start>${isoZ(t.start)}</t:Start><t:End>${isoZ(t.end)}</t:End>` +
    `<t:IsAllDayEvent>${e.allDay}</t:IsAllDayEvent>` +
    `<t:LegacyFreeBusyStatus>${e.busy}</t:LegacyFreeBusyStatus>` +
    `<t:Location>${esc(e.location.trim())}</t:Location>` +
    `<t:StartTimeZone Id="${TZ_ID}"/><t:EndTimeZone Id="${TZ_ID}"/>`
  );
}

export async function createEvent(
  sql: Sql,
  env: Pick<Env, 'SESSION_SECRET' | 'APP_BASIC_AUTH'>,
  userId: string,
  e: EventInput,
): Promise<string> {
  const t = normalizeEvent(e);
  return withCreds(sql, env, userId, async (cr) => {
    const xml = await call(
      cr,
      '<m:CreateItem SendMeetingInvitations="SendToNone"><m:SavedItemFolderId>' +
        '<t:DistinguishedFolderId Id="calendar"/></m:SavedItemFolderId>' +
        `<m:Items><t:CalendarItem>${itemXml(e, t)}</t:CalendarItem></m:Items></m:CreateItem>`,
    );
    return attr(xml, 'ItemId', 'Id') ?? '';
  });
}

export async function updateEvent(
  sql: Sql,
  env: Pick<Env, 'SESSION_SECRET' | 'APP_BASIC_AUTH'>,
  userId: string,
  id: string,
  changeKey: string,
  e: EventInput,
) {
  const t = normalizeEvent(e);
  const set = (uri: string, inner: string) =>
    `<t:SetItemField><t:FieldURI FieldURI="${uri}"/><t:CalendarItem>${inner}</t:CalendarItem></t:SetItemField>`;
  const del = (uri: string) => `<t:DeleteItemField><t:FieldURI FieldURI="${uri}"/></t:DeleteItemField>`;
  const changes = [
    set('item:Subject', `<t:Subject>${esc(e.subject.trim())}</t:Subject>`),
    e.body.trim() ? set('item:Body', `<t:Body BodyType="Text">${esc(e.body)}</t:Body>`) : del('item:Body'),
    set('item:ReminderIsSet', `<t:ReminderIsSet>${e.reminder !== null}</t:ReminderIsSet>`),
    e.reminder !== null
      ? set(
          'item:ReminderMinutesBeforeStart',
          `<t:ReminderMinutesBeforeStart>${e.reminder}</t:ReminderMinutesBeforeStart>`,
        )
      : '',
    set('calendar:StartTimeZone', `<t:StartTimeZone Id="${TZ_ID}"/>`),
    set('calendar:EndTimeZone', `<t:EndTimeZone Id="${TZ_ID}"/>`),
    set('calendar:Start', `<t:Start>${isoZ(t.start)}</t:Start>`),
    set('calendar:End', `<t:End>${isoZ(t.end)}</t:End>`),
    set('calendar:IsAllDayEvent', `<t:IsAllDayEvent>${e.allDay}</t:IsAllDayEvent>`),
    set('calendar:LegacyFreeBusyStatus', `<t:LegacyFreeBusyStatus>${e.busy}</t:LegacyFreeBusyStatus>`),
    e.location.trim()
      ? set('calendar:Location', `<t:Location>${esc(e.location.trim())}</t:Location>`)
      : del('calendar:Location'),
  ].join('');
  await withCreds(sql, env, userId, (cr) =>
    call(
      cr,
      '<m:UpdateItem ConflictResolution="AlwaysOverwrite" SendMeetingInvitationsOrCancellations="SendToNone">' +
        `<m:ItemChanges><t:ItemChange><t:ItemId Id="${esc(id)}"${changeKey ? ` ChangeKey="${esc(changeKey)}"` : ''}/>` +
        `<t:Updates>${changes}</t:Updates></t:ItemChange></m:ItemChanges></m:UpdateItem>`,
    ),
  );
}

export async function deleteEvent(
  sql: Sql,
  env: Pick<Env, 'SESSION_SECRET' | 'APP_BASIC_AUTH'>,
  userId: string,
  id: string,
) {
  await withCreds(sql, env, userId, (cr) =>
    call(
      cr,
      '<m:DeleteItem DeleteType="MoveToDeletedItems" SendMeetingCancellations="SendToNone">' +
        `<m:ItemIds><t:ItemId Id="${esc(id)}"/></m:ItemIds></m:DeleteItem>`,
    ),
  );
}
