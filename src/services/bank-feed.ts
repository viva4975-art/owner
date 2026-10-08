import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto';
import type { Env } from '../config/env.js';
import type { Sql } from '../db/client.js';
import type { StatementLine } from '../domain/bank/statement.js';
import { addDays, hourBerlin, todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from './errors.js';
import { getSeller } from './masterdata.js';
import type { Deps } from './workflow.js';

/*
 * Bankabruf über Enable Banking (lizenzierter Kontoinformationsdienst nach PSD2, Restricted Production = nur eigene
 * Konten). Ablauf: Application-ID + privater Schlüssel (nur auf dem Server, verschlüsselt) → „Bank verbinden“ (Login +
 * TAN im Fenster der Bank) → Rückkehr mit Code → Sitzung mit Konten → Umsätze und Kontostand abrufen. Umsätze landen in
 * denselben Kontoumsätzen wie der CAMT-Import (Vorschläge, Zuordnung). Doppelt abrufen legt nichts doppelt an.
 */

const API = 'https://api.enablebanking.com';
const CONSENT_DAYS = 180;
const FIRST_FETCH_DAYS = 90;
const OVERLAP_DAYS = 10;
const AUTO_EVERY_MS = 4.5 * 60 * 60 * 1000; // PSD2: ohne Anwesenheit höchstens 4 Abrufe je Tag und Konto

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
let fetcher: Fetcher = (url, init) => fetch(url, init);
/** Nur für Tests. */
export function setBankFetcher(f: Fetcher | null) {
  fetcher = f ?? ((url, init) => fetch(url, init));
}

// ---------------------------------------------------------------- Zugang (verschlüsselt)

function secretKey(env: Pick<Env, 'SESSION_SECRET' | 'APP_BASIC_AUTH'>) {
  return createHash('sha256')
    .update(`bank-feed:${env.SESSION_SECRET ?? `dev-session:${env.APP_BASIC_AUTH}`}`)
    .digest();
}
export function encryptKey(env: Pick<Env, 'SESSION_SECRET' | 'APP_BASIC_AUTH'>, pem: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secretKey(env), iv);
  const data = Buffer.concat([c.update(pem, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}
export function decryptKey(env: Pick<Env, 'SESSION_SECRET' | 'APP_BASIC_AUTH'>, enc: string) {
  const [iv, tag, data] = enc.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', secretKey(env), iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(data!), d.final()]).toString('utf8');
}

const fingerprint = (key: KeyObject) =>
  createHash('sha256')
    .update(createPublicKey(key).export({ type: 'spki', format: 'der' }))
    .digest('hex')
    .slice(0, 16)
    .replace(/(.{4})(?!$)/g, '$1:');

export async function saveFeedConfig(deps: Deps, p: { appId: string; pem: string; actor: string }) {
  const appId = p.appId.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId))
    throw new BusinessError('Application ID: bitte die ID aus dem Enable-Banking-Portal (Format 8-4-4-4-12)');
  let key: KeyObject;
  try {
    key = createPrivateKey(p.pem);
  } catch {
    throw new BusinessError(
      'Schlüsseldatei nicht lesbar – bitte die .pem-Datei mit dem PRIVATEN Schlüssel wählen',
    );
  }
  if (key.asymmetricKeyType !== 'rsa') throw new BusinessError('Schlüssel muss ein RSA-Schlüssel sein');
  const fp = fingerprint(key);
  const pem = key.export({ type: 'pkcs8', format: 'pem' }).toString();
  await deps.sql`
    insert into app.bank_feed_config (id, app_id, key_enc, key_fingerprint, updated_by)
    values (1, ${appId}, ${encryptKey(deps.env, pem)}, ${fp}, ${p.actor})
    on conflict (id) do update set app_id = excluded.app_id, key_enc = excluded.key_enc,
      key_fingerprint = excluded.key_fingerprint, updated_by = excluded.updated_by, updated_at = now()`;
  await deps.sql`insert into app.audit_log (actor, action, entity, entity_id, details)
                 values (${p.actor}, 'update', 'bank_feed_config', null, ${deps.sql.json({ app_id: appId, fingerprint: fp })})`;
  return fp;
}

export interface FeedConfigInfo {
  app_id: string;
  key_fingerprint: string;
  updated_by: string;
  updated_at: Date;
}
export async function feedConfigInfo(sql: Sql) {
  const [c] = await sql<FeedConfigInfo[]>`
    select app_id, key_fingerprint, updated_by, updated_at from app.bank_feed_config where id = 1`;
  return c ?? null;
}

async function credentials(deps: Deps) {
  const [c] = await deps.sql<{ app_id: string; key_enc: string }[]>`
    select app_id, key_enc from app.bank_feed_config where id = 1`;
  if (!c) throw new BusinessError('Bankabruf ist noch nicht eingerichtet (Einstellungen → Bankabruf)');
  let pem: string;
  try {
    pem = decryptKey(deps.env, c.key_enc);
  } catch {
    throw new BusinessError(
      'Schlüssel nicht lesbar (SESSION_SECRET auf dem Server geändert?) – bitte unter Einstellungen → Bankabruf neu hochladen',
    );
  }
  return { appId: c.app_id, key: createPrivateKey(pem) };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
/** JWT für die Enable-Banking-API (RS256, kid = Application-ID, höchstens 1 Stunde gültig). */
export function makeJwt(appId: string, key: KeyObject, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const head = b64url(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: appId }));
  const body = b64url(
    JSON.stringify({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat, exp: iat + 3600 }),
  );
  return `${head}.${body}.${b64url(sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key))}`;
}

async function api<T>(
  deps: Deps,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const { appId, key } = await credentials(deps);
  let res: Response;
  try {
    res = await fetcher(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${makeJwt(appId, key)}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new BusinessError(`Enable Banking nicht erreichbar: ${(e as Error).message}`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* kein JSON */
  }
  if (!res.ok) {
    const j = (json ?? {}) as { message?: string; error?: string; detail?: unknown };
    const msg = j.message ?? j.error ?? (typeof j.detail === 'string' ? j.detail : text.slice(0, 200));
    throw new BankApiError(res.status, `Enable Banking ${res.status}: ${msg || res.statusText}`);
  }
  return json as T;
}
export class BankApiError extends BusinessError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Verbindung prüfen (Application-ID + Schlüssel). */
export async function testFeed(deps: Deps) {
  const a = await api<{ name?: string; active?: boolean; environment?: string }>(deps, 'GET', '/application');
  return { name: a?.name ?? '', active: a?.active ?? null, environment: a?.environment ?? '' };
}

// ---------------------------------------------------------------- Banken verbinden

export interface Aspsp {
  name: string;
  country: string;
  maximum_consent_validity?: number;
  psu_types?: string[];
}
export async function listBanks(deps: Deps) {
  const r = await api<{ aspsps: Aspsp[] }>(deps, 'GET', '/aspsps?country=DE');
  return (r.aspsps ?? []).sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

/** Freigabe anfragen → Adresse des Bank-Fensters (Login + TAN). */
export async function startConnect(
  deps: Deps,
  p: { aspsp: string; redirectUrl: string; actor: string; now?: Date },
) {
  const banks = await listBanks(deps);
  const bank = banks.find((b) => b.name === p.aspsp);
  if (!bank) throw new BusinessError('Bank nicht gefunden – bitte aus der Liste wählen');
  const now = p.now ?? new Date();
  const maxSec = bank.maximum_consent_validity ?? CONSENT_DAYS * 86400;
  const validUntil = new Date(now.getTime() + Math.min(maxSec, CONSENT_DAYS * 86400) * 1000 - 60_000);
  const state = randomUUID();
  const id = randomUUID();
  await deps.sql`insert into app.bank_connections (id, aspsp_name, aspsp_country, state, created_by)
                 values (${id}, ${bank.name}, ${bank.country}, ${state}, ${p.actor})`;
  try {
    const r = await api<{ url: string }>(deps, 'POST', '/auth', {
      access: { valid_until: validUntil.toISOString() },
      aspsp: { name: bank.name, country: bank.country },
      state,
      redirect_url: p.redirectUrl,
      psu_type: (bank.psu_types ?? ['business']).includes('business') ? 'business' : 'personal',
    });
    if (!r?.url) throw new BusinessError('Enable Banking hat keine Anmeldeadresse geliefert');
    return r.url;
  } catch (e) {
    await deps.sql`update app.bank_connections set status = 'fehler', error = ${(e as Error).message.slice(0, 500)}
                   where id = ${id}`;
    throw e;
  }
}

interface SessionResponse {
  session_id: string;
  accounts?: { uid: string; account_id?: { iban?: string }; name?: string; currency?: string }[];
  access?: { valid_until?: string };
}

/** Rückkehr aus dem Bank-Fenster: Code gegen Sitzung tauschen, Konten speichern. */
export async function finishConnect(
  deps: Deps,
  p: { state: string; code: string | null; error: string | null; actor: string },
) {
  const { sql } = deps;
  const [conn] = await sql<{ id: string; status: string; aspsp_name: string; created_at: Date }[]>`
    select id, status, aspsp_name, created_at from app.bank_connections where state = ${p.state}`;
  if (!conn) throw new BusinessError('Unbekannte Rückkehr von der Bank – bitte „Bank verbinden“ neu starten');
  if (conn.status === 'aktiv') return { bank: conn.aspsp_name, accounts: 0, already: true };
  if (conn.status !== 'angefragt')
    throw new BusinessError('Diese Anfrage ist nicht mehr offen – bitte neu verbinden');
  if (Date.now() - conn.created_at.getTime() > 60 * 60 * 1000) {
    await sql`update app.bank_connections set status = 'fehler', error = 'Zeit abgelaufen' where id = ${conn.id}`;
    throw new BusinessError('Anmeldung bei der Bank hat zu lange gedauert – bitte neu verbinden');
  }
  if (p.error || !p.code) {
    const msg = p.error ?? 'kein Code';
    await sql`update app.bank_connections set status = 'fehler', error = ${msg.slice(0, 500)} where id = ${conn.id}`;
    throw new BusinessError(`Bank hat die Freigabe nicht erteilt (${msg})`);
  }
  let s: SessionResponse;
  try {
    s = await api<SessionResponse>(deps, 'POST', '/sessions', { code: p.code });
  } catch (e) {
    await sql`update app.bank_connections set status = 'fehler', error = ${(e as Error).message.slice(0, 500)}
              where id = ${conn.id}`;
    throw e;
  }
  const own = new Set((await getSeller(sql)).bankAccounts.map((b) => ibanOf(b.iban)));
  const accounts = s.accounts ?? [];
  await sql.begin(async (tx) => {
    await tx`update app.bank_connections set status = 'aktiv', session_id = ${s.session_id},
               valid_until = ${s.access?.valid_until ?? null}, activated_at = now(), error = null
             where id = ${conn.id}`;
    for (const a of accounts) {
      const iban = ibanOf(a.account_id?.iban) || null;
      await tx`insert into app.bank_feed_accounts (uid, connection_id, iban, name, currency, active)
               values (${a.uid}, ${conn.id}, ${iban}, ${a.name ?? null}, ${a.currency ?? null}, ${!!iban && own.has(iban)})
               on conflict (uid) do nothing`;
      // ältere Freigabe für dasselbe Konto ablösen
      if (iban)
        await tx`update app.bank_feed_accounts set active = false
                  where iban = ${iban} and uid <> ${a.uid} and active`;
    }
    await tx`update app.bank_connections c set status = 'getrennt'
              where c.status = 'aktiv' and c.id <> ${conn.id}
                and not exists (select 1 from app.bank_feed_accounts a where a.connection_id = c.id and a.active)`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${p.actor}, 'connect', 'bank_connection', ${conn.id},
                     ${tx.json({ bank: conn.aspsp_name, accounts: accounts.map((a) => ibanOf(a.account_id?.iban)) })})`;
  });
  return { bank: conn.aspsp_name, accounts: accounts.length, already: false };
}

/** Freigabe beenden (auch bei Enable Banking löschen). */
export async function disconnect(deps: Deps, id: string, actor: string) {
  const [c] = await deps.sql<{ session_id: string | null; status: string }[]>`
    select session_id, status from app.bank_connections where id = ${id}`;
  if (!c) throw new BusinessError('Verbindung nicht gefunden');
  if (c.session_id && c.status === 'aktiv') {
    try {
      await api(deps, 'DELETE', `/sessions/${encodeURIComponent(c.session_id)}`);
    } catch {
      /* bei der Bank ggf. schon abgelaufen – hier trotzdem trennen */
    }
  }
  await deps.sql.begin(async (tx) => {
    await tx`update app.bank_connections set status = 'getrennt' where id = ${id}`;
    await tx`update app.bank_feed_accounts set active = false where connection_id = ${id}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, 'disconnect', 'bank_connection', ${id})`;
  });
}

export interface FeedConnection {
  id: string;
  aspsp_name: string;
  status: string;
  valid_until: Date | null;
  error: string | null;
  created_at: Date;
  activated_at: Date | null;
}
export interface FeedAccount {
  uid: string;
  connection_id: string;
  iban: string | null;
  name: string | null;
  balance_cents: bigint | null;
  balance_date: string | null;
  balance_at: Date | null;
  last_fetch_at: Date | null;
  last_fetch_error: string | null;
  active: boolean;
}
export async function feedStatus(sql: Sql) {
  const [connections, accounts] = await Promise.all([
    sql<FeedConnection[]>`
      select id, aspsp_name, status, valid_until, error, created_at, activated_at from app.bank_connections
       where status in ('aktiv', 'abgelaufen') or created_at > now() - interval '2 days'
       order by created_at desc limit 20`,
    sql<FeedAccount[]>`
      select uid, connection_id, iban, name, balance_cents, balance_date::text, balance_at, last_fetch_at,
             last_fetch_error, active
        from app.bank_feed_accounts where active order by iban`,
  ]);
  return { connections, accounts };
}

// ---------------------------------------------------------------- Umsätze abrufen

export interface EbTransaction {
  entry_reference?: string | null;
  transaction_amount: { amount: string; currency?: string };
  credit_debit_indicator?: 'CRDT' | 'DBIT';
  status?: string;
  booking_date?: string | null;
  value_date?: string | null;
  transaction_date?: string | null;
  creditor?: { name?: string | null } | null;
  creditor_account?: { iban?: string | null } | null;
  debtor?: { name?: string | null } | null;
  debtor_account?: { iban?: string | null } | null;
  remittance_information?: string[] | null;
  end_to_end_id?: string | null;
}

const ibanOf = (s: string | null | undefined) => (s ?? '').replace(/\s/g, '').toUpperCase();

/** "1234.5" / "-12.34" → Cent, ohne Gleitkomma. */
export function decimalToCents(s: string): bigint {
  const m = /^\s*([+-]?)(\d+)(?:[.,](\d{1,2}))?\s*$/.exec(s ?? '');
  if (!m) throw new BusinessError(`Betrag nicht lesbar: ${s}`);
  const cents = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  return m[1] === '-' ? -cents : cents;
}

/** Umsatz von Enable Banking → Zeile wie aus dem Kontoauszug. Nur gebuchte Umsätze. */
export function mapTransaction(t: EbTransaction, accountIban: string): StatementLine | null {
  if (t.status && t.status !== 'BOOK') return null;
  const date = t.booking_date ?? t.value_date ?? t.transaction_date;
  if (!date) return null;
  const raw = decimalToCents(t.transaction_amount.amount);
  const abs = raw < 0n ? -raw : raw;
  const debit = t.credit_debit_indicator ? t.credit_debit_indicator === 'DBIT' : raw < 0n;
  const amount = debit ? -abs : abs;
  if (amount === 0n) return null;
  const party = debit ? t.creditor : t.debtor;
  const acct = debit ? t.creditor_account : t.debtor_account;
  return {
    accountIban,
    bookingDate: date.slice(0, 10),
    valueDate: t.value_date?.slice(0, 10) ?? null,
    amountCents: amount,
    counterpartyName: party?.name?.trim() || null,
    counterpartyIban: ibanOf(acct?.iban) || null,
    purpose: (t.remittance_information ?? []).join(' ').replace(/\s+/g, ' ').trim(),
    endToEndId: t.end_to_end_id && t.end_to_end_id !== 'NOTPROVIDED' ? t.end_to_end_id : null,
    bankRef: t.entry_reference ?? null,
  };
}

const uuidFrom = (s: string) =>
  createHash('md5')
    .update(s)
    .digest('hex')
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

/** Feste ID aus dem Inhalt (nicht aus der Bank-Referenz, die je Abruf wechseln kann). */
export function feedTxIds(lines: StatementLine[]) {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const key = [
      'api',
      l.accountIban,
      l.bookingDate,
      l.amountCents,
      l.counterpartyIban ?? '',
      l.purpose,
    ].join('|');
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return { id: uuidFrom(`${key}|${n}`), l };
  });
}

const BALANCE_ORDER = ['CLBD', 'ITBD', 'XPCD', 'ITAV', 'CLAV', 'OPBD', 'PRCD', 'OTHR'];

let running = false;

/** Alle verbundenen Konten abrufen (Kontostand + Umsätze). `auto`: nur Konten, deren Abruf älter als 4,5 Std. ist. */
export async function fetchAll(deps: Deps, p: { actor: string; auto?: boolean; now?: Date }) {
  if (running) return { accounts: 0, lines: 0, created: 0, errors: ['Abruf läuft bereits'] };
  running = true;
  try {
    return await fetchAllInner(deps, p);
  } finally {
    running = false;
  }
}

async function fetchAllInner(deps: Deps, p: { actor: string; auto?: boolean; now?: Date }) {
  const { sql } = deps;
  const now = p.now ?? new Date();
  const accounts = await sql<
    (FeedAccount & { last_booking_date: string | null; valid_until: Date | null; conn_status: string })[]
  >`
    select a.*, a.last_booking_date::text, c.valid_until, c.status as conn_status
      from app.bank_feed_accounts a join app.bank_connections c on c.id = a.connection_id
     where a.active and c.status = 'aktiv'`;
  const out = { accounts: 0, lines: 0, created: 0, errors: [] as string[] };
  const own = new Set((await getSeller(sql)).bankAccounts.map((b) => ibanOf(b.iban)));
  for (const a of accounts) {
    if (p.auto && a.last_fetch_at && now.getTime() - a.last_fetch_at.getTime() < AUTO_EVERY_MS) continue;
    if (a.valid_until && a.valid_until.getTime() < now.getTime()) {
      await sql`update app.bank_connections set status = 'abgelaufen' where id = ${a.connection_id}`;
      out.errors.push(`${a.iban}: Freigabe abgelaufen – bitte Bank neu verbinden (TAN)`);
      continue;
    }
    if (!a.iban || !own.has(a.iban)) continue;
    try {
      const r = await fetchAccount(deps, a, p.actor, now);
      out.accounts++;
      out.lines += r.lines;
      out.created += r.created;
      await sql`update app.bank_feed_accounts set last_fetch_at = ${now}, last_fetch_error = null where uid = ${a.uid}`;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 500);
      out.errors.push(`${a.iban}: ${msg}`);
      await sql`update app.bank_feed_accounts set last_fetch_at = ${now}, last_fetch_error = ${msg} where uid = ${a.uid}`;
      if (
        e instanceof BankApiError &&
        (e.status === 401 || e.status === 403) &&
        /session|consent|expired|abgelaufen/i.test(msg)
      )
        await sql`update app.bank_connections set status = 'abgelaufen' where id = ${a.connection_id}`;
    }
  }
  return out;
}

async function fetchAccount(
  deps: Deps,
  a: FeedAccount & { last_booking_date: string | null },
  actor: string,
  now: Date,
) {
  const { sql } = deps;
  const iban = a.iban!;
  const uid = encodeURIComponent(a.uid);
  // Kontostand
  const bal = await api<{
    balances?: {
      balance_amount: { amount: string };
      balance_type?: string;
      reference_date?: string | null;
    }[];
  }>(deps, 'GET', `/accounts/${uid}/balances`);
  const rank = (t: string | undefined) => {
    const i = BALANCE_ORDER.indexOf(t ?? 'OTHR');
    return i < 0 ? 99 : i;
  };
  const best = [...(bal?.balances ?? [])].sort((x, y) => rank(x.balance_type) - rank(y.balance_type))[0];
  if (best) {
    await sql`update app.bank_feed_accounts set balance_cents = ${decimalToCents(best.balance_amount.amount)},
                balance_type = ${best.balance_type ?? null}, balance_date = ${best.reference_date ?? todayBerlin(now)},
                balance_at = ${now}
              where uid = ${a.uid}`;
  }
  // Umsätze (mit Überlappung – doppelt schadet nicht)
  const today = todayBerlin(now);
  const from = a.last_booking_date
    ? addDays(a.last_booking_date, -OVERLAP_DAYS)
    : addDays(today, -FIRST_FETCH_DAYS);
  const raw: EbTransaction[] = [];
  let cont: string | null = null;
  for (let page = 0; page < 100; page++) {
    const q = new URLSearchParams({ date_from: from });
    if (cont) q.set('continuation_key', cont);
    const r: { transactions?: EbTransaction[]; continuation_key?: string | null } = await api(
      deps,
      'GET',
      `/accounts/${uid}/transactions?${q}`,
    );
    raw.push(...(r?.transactions ?? []));
    cont = r?.continuation_key ?? null;
    if (!cont) break;
  }
  const lines = raw.map((t) => mapTransaction(t, iban)).filter((l): l is StatementLine => !!l);
  // gleiche Reihenfolge je Abruf → gleiche Vorkommen-Nummer bei gleichen Umsätzen am selben Tag
  lines.sort((x, y) =>
    `${x.bookingDate}|${x.amountCents}|${x.purpose}|${x.bankRef ?? ''}`.localeCompare(
      `${y.bookingDate}|${y.amountCents}|${y.purpose}|${y.bankRef ?? ''}`,
    ),
  );
  const rows = feedTxIds(lines);
  if (!rows.length) return { lines: 0, created: 0 };
  const ids = rows.map((r) => r.id);
  const existing = new Set(
    (await sql<{ id: string }[]>`select id from app.bank_transactions where id = any(${ids}::uuid[])`).map(
      (r) => r.id,
    ),
  );
  const fresh: typeof rows = [];
  for (const r of rows) {
    if (existing.has(r.id)) continue;
    // schon aus einem Kontoauszug (CAMT/CSV) eingelesen?
    const [dup] = await sql`
      select 1 from app.bank_transactions t join app.bank_imports i on i.id = t.import_id
       where i.format <> 'api' and t.account_iban = ${iban} and t.booking_date = ${r.l.bookingDate}
         and t.amount_cents = ${r.l.amountCents}
         and regexp_replace(t.purpose, '\\s', '', 'g') = ${r.l.purpose.replace(/\s/g, '')} limit 1`;
    if (!dup) fresh.push(r);
  }
  const maxDate = rows.reduce((m, r) => (r.l.bookingDate > m ? r.l.bookingDate : m), '0000-00-00');
  if (fresh.length) {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ account: iban, date_from: from, fetched_at: now, transactions: raw }),
    );
    const sha = createHash('sha256').update(bytes).digest('hex');
    const path = `kontoauszuege/${sha.slice(0, 2)}/${sha}.json`;
    await deps.archive.put(path, bytes);
    const importId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`insert into app.bank_imports (id, filename, format, file_path, file_sha256, line_count, new_count, created_by)
               values (${importId}, ${`Bankabruf ${iban} ${today}`}, 'api', ${path}, ${sha}, ${rows.length}, ${fresh.length}, ${actor})`;
      for (const { id, l } of fresh) {
        await tx`
          insert into app.bank_transactions (id, import_id, account_iban, booking_date, value_date, amount_cents,
                                             counterparty_name, counterparty_iban, purpose, end_to_end_id, bank_ref)
          values (${id}, ${importId}, ${l.accountIban}, ${l.bookingDate}, ${l.valueDate}, ${l.amountCents},
                  ${l.counterpartyName}, ${l.counterpartyIban}, ${l.purpose}, ${l.endToEndId}, ${l.bankRef})
          on conflict (id) do nothing`;
      }
    });
  }
  await sql`update app.bank_feed_accounts set last_booking_date = greatest(coalesce(last_booking_date, ${maxDate}::date), ${maxDate}::date)
            where uid = ${a.uid}`;
  return { lines: rows.length, created: fresh.length };
}

/** Zeitplan: alle 30 Min. prüfen, abgerufen wird zwischen 6 und 21 Uhr höchstens alle 4,5 Std. je Konto. */
export async function autoFetch(deps: Deps, now = new Date()) {
  const h = hourBerlin(now);
  if (h < 6 || h > 21) return null;
  const [cfg] = await deps.sql`select 1 from app.bank_feed_config where id = 1`;
  if (!cfg) return null;
  return fetchAll(deps, { actor: 'bankabruf', auto: true, now });
}

// ---------------------------------------------------------------- Konten, Kontostand, Kontoauszug

export interface AccountOverview {
  iban: string;
  name: string;
  balance_cents: bigint | null;
  balance_at: Date | null;
  open: number;
  connected: boolean;
  valid_until: Date | null;
  last_fetch_at: Date | null;
  last_fetch_error: string | null;
}

/** Eigene Konten (Firmendaten) mit Kontostand aus dem Abruf und Anzahl offener Umsätze. */
export async function accountOverview(sql: Sql): Promise<AccountOverview[]> {
  const seller = await getSeller(sql);
  const [feed, open] = await Promise.all([
    sql<(FeedAccount & { valid_until: Date | null })[]>`
      select a.*, a.balance_date::text, c.valid_until from app.bank_feed_accounts a
        join app.bank_connections c on c.id = a.connection_id where a.active`,
    sql<{ account_iban: string; n: number }[]>`
      select account_iban, count(*)::int as n from app.bank_transactions where status = 'offen' group by 1`,
  ]);
  return seller.bankAccounts.map((b) => {
    const iban = ibanOf(b.iban);
    const f = feed.find((x) => x.iban === iban);
    return {
      iban,
      name: b.name ?? 'Konto',
      balance_cents: f?.balance_cents ?? null,
      balance_at: f?.balance_at ?? null,
      open: open.find((o) => o.account_iban === iban)?.n ?? 0,
      connected: !!f,
      valid_until: f?.valid_until ?? null,
      last_fetch_at: f?.last_fetch_at ?? null,
      last_fetch_error: f?.last_fetch_error ?? null,
    };
  });
}

/**
 * Kontoauszug eines Kontos im Zeitraum. Salden „errechnet“ wie Fortytools: vom zuletzt abgerufenen Kontostand
 * rückwärts über die Umsätze (stimmt, solange alle Umsätze seitdem vorliegen). Ohne Abruf keine Salden.
 */
export async function statement(sql: Sql, p: { iban: string; from: string; to: string; q?: string | null }) {
  const iban = ibanOf(p.iban);
  const [f] = await sql<{ balance_cents: bigint | null; balance_date: string | null }[]>`
    select balance_cents, balance_date::text from app.bank_feed_accounts
     where iban = ${iban} and active and balance_cents is not null order by balance_at desc limit 1`;
  const q = p.q?.trim();
  const rows = await sql<
    {
      id: string;
      booking_date: string;
      amount_cents: bigint;
      counterparty_name: string | null;
      counterparty_iban: string | null;
      purpose: string;
      status: string;
      note: string | null;
    }[]
  >`
    select id, booking_date::text, amount_cents, counterparty_name, counterparty_iban, purpose, status, note
      from app.bank_transactions
     where account_iban = ${iban} and booking_date between ${p.from} and ${p.to}
       and ${q ? sql`(coalesce(counterparty_name, '') || ' ' || purpose || ' ' || coalesce(note, '') || ' ' || (amount_cents / 100.0)::text) ilike ${`%${q}%`}` : sql`true`}
     order by booking_date desc, amount_cents desc limit 2000`;
  const sums = await sql<{ inc: bigint; out: bigint }[]>`
    select coalesce(sum(amount_cents) filter (where amount_cents > 0), 0)::bigint as inc,
           coalesce(sum(amount_cents) filter (where amount_cents < 0), 0)::bigint as out
      from app.bank_transactions where account_iban = ${iban} and booking_date between ${p.from} and ${p.to}`;
  let start: bigint | null = null;
  let end: bigint | null = null;
  let trend: { date: string; avg: bigint }[] = [];
  if (f?.balance_cents != null && f.balance_date) {
    end = await balanceAt(sql, iban, f.balance_cents, f.balance_date, p.to);
    start = await balanceAt(sql, iban, f.balance_cents, f.balance_date, addDays(p.from, -1));
    trend = await balanceTrend(sql, iban, f.balance_cents, f.balance_date, p.to);
  }
  return { rows, start, end, income: sums[0]!.inc, outgo: sums[0]!.out, trend, hasBalance: start != null };
}

/** Saldo am Ende des Tages `day` aus einem bekannten Saldo am Ende von `knownDate`. */
async function balanceAt(sql: Sql, iban: string, known: bigint, knownDate: string, day: string) {
  const [r] = await sql<{ d: bigint }[]>`
    select coalesce(sum(case when booking_date > ${day}::date and booking_date <= ${knownDate}::date then -amount_cents
                             when booking_date > ${knownDate}::date and booking_date <= ${day}::date then amount_cents
                             else 0 end), 0)::bigint as d
      from app.bank_transactions where account_iban = ${iban}`;
  return known + r!.d;
}

/** Tagessalden der letzten 12 Monate (bis `to`), geglättet über 30 Tage – nur ab dem ersten vorliegenden Umsatz. */
async function balanceTrend(sql: Sql, iban: string, known: bigint, knownDate: string, to: string) {
  const from = addDays(to, -365);
  const [first] = await sql<{ d: string | null }[]>`
    select min(booking_date)::text as d from app.bank_transactions where account_iban = ${iban}`;
  if (!first?.d) return [];
  const start = first.d > from ? first.d : from;
  const daily = await sql<{ d: string; s: bigint }[]>`
    select booking_date::text as d, sum(amount_cents)::bigint as s from app.bank_transactions
     where account_iban = ${iban} and booking_date > ${start}::date - 30 and booking_date <= ${to}::date group by 1`;
  const byDay = new Map(daily.map((r) => [r.d, r.s]));
  let bal = await balanceAt(sql, iban, known, knownDate, addDays(start, -30));
  const window: bigint[] = [];
  const out: { date: string; avg: bigint }[] = [];
  for (let d = addDays(start, -29); d <= to; d = addDays(d, 1)) {
    bal += byDay.get(d) ?? 0n;
    window.push(bal);
    if (window.length > 30) window.shift();
    if (d >= start) out.push({ date: d, avg: window.reduce((a, b) => a + b, 0n) / BigInt(window.length) });
  }
  return out;
}
