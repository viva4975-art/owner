import { readdir, readFile, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { Env } from '../config/env.js';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import type { Mailer } from '../mail/mailer.js';
import { resolveRecipients } from '../mail/mailer.js';

/**
 * Systemwächter (Ahmed 10.10.: „Meldung, wenn der Server ausfällt“): prüft alle 5 Minuten Datenbank, KoSIT,
 * Speicherplatz, Sicherung und Mailzugang. Bei einer Störung (rot) geht eine Mail an die Erinnerungs-Empfänger
 * (sonst Firmen-E-Mail) – höchstens einmal je Störung und Tag, dazu „wieder in Ordnung“. Fällt der ganze Server
 * aus, kann er sich nicht selbst melden – dafür prüft ein externer Dienst /health/voll (docs/anleitung-ueberwachung).
 */

export interface CheckResult {
  key: string;
  label: string;
  ok: boolean;
  /** rot = Störung (Mail), gelb = Hinweis (nur Anzeige) */
  level: 'rot' | 'gelb';
  detail: string;
}

export interface WatchdogDeps {
  sql: Sql;
  env: Env;
  mailer: Mailer;
}

const GB = 1024 ** 3;
const fmtGb = (b: number) => `${(b / GB).toFixed(1).replace('.', ',')} GB`;

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        t = setTimeout(() => rej(new Error(`${what}: keine Antwort nach ${ms / 1000} s`)), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function checkDatabase(sql: Sql): Promise<CheckResult> {
  const base = { key: 'datenbank', label: 'Datenbank', level: 'rot' as const };
  try {
    await withTimeout(sql`select 1`, 10_000, 'Datenbank');
    return { ...base, ok: true, detail: 'erreichbar' };
  } catch (e) {
    return { ...base, ok: false, detail: msg(e) };
  }
}

/** KoSIT-Prüfdienst: ohne ihn lassen sich keine Rechnungen ausstellen (E-Rechnung wird vorher geprüft). */
export async function checkKosit(url: string): Promise<CheckResult> {
  const base = { key: 'kosit', label: 'E-Rechnungs-Prüfung (KoSIT)', level: 'rot' as const };
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/server/health`, { signal: AbortSignal.timeout(8000) });
    await r.arrayBuffer();
    if (r.status >= 500) return { ...base, ok: false, detail: `antwortet mit Fehler ${r.status}` };
    return { ...base, ok: true, detail: 'erreichbar' };
  } catch (e) {
    return {
      ...base,
      ok: false,
      detail: `nicht erreichbar – Rechnungen können nicht ausgestellt werden (${msg(e)})`,
    };
  }
}

/** Freier Speicher: rot unter 5 GB oder 5 %, gelb unter 15 GB oder 15 %. */
export function diskVerdict(free: number, total: number): Pick<CheckResult, 'ok' | 'level' | 'detail'> {
  const pct = total > 0 ? (free / total) * 100 : 0;
  const detail = `${fmtGb(free)} frei von ${fmtGb(total)} (${Math.round(pct)} %)`;
  if (free < 5 * GB || pct < 5) return { ok: false, level: 'rot', detail: `nur noch ${detail}` };
  if (free < 15 * GB || pct < 15) return { ok: false, level: 'gelb', detail: `wird knapp: ${detail}` };
  return { ok: true, level: 'rot', detail };
}

export async function checkDisk(dir: string): Promise<CheckResult> {
  const base = { key: 'speicher', label: 'Speicherplatz' };
  try {
    const s = await statfs(dir);
    return { ...base, ...diskVerdict(s.bavail * s.bsize, s.blocks * s.bsize) };
  } catch (e) {
    return { ...base, ok: false, level: 'gelb', detail: `nicht prüfbar (${msg(e)})` };
  }
}

/**
 * Tägliche Sicherung (deploy/backup.sh, 02:30): neueste Datenbank-Sicherung höchstens 26 Std. alt.
 * Im Container ist nur /opt/viva-sicherung/status (Statusdatei) schreibgeschützt als BACKUP_DIR eingebunden.
 */
export async function checkBackup(dir: string | undefined, now = new Date()): Promise<CheckResult | null> {
  const base = { key: 'sicherung', label: 'Tägliche Sicherung' };
  if (!dir) return null;
  try {
    // backup.sh schreibt status/letzte-sicherung.txt (Größe der Datenbank-Sicherung in Bytes); lokal auch die Dumps selbst
    const files = (await readdir(dir)).filter((f) => /^datenbank_.*\.dump$|^letzte-sicherung\.txt$/.test(f));
    let newest = 0;
    let size = 0;
    for (const f of files) {
      const s = await stat(join(dir, f));
      if (s.mtimeMs > newest) {
        newest = s.mtimeMs;
        size = f.endsWith('.txt') ? Number((await readFile(join(dir, f), 'utf8')).trim()) || 0 : s.size;
      }
    }
    if (!newest) return { ...base, ok: false, level: 'rot', detail: 'keine Datenbank-Sicherung gefunden' };
    const hours = (now.getTime() - newest) / 3_600_000;
    const when = new Date(newest).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
    if (hours > 26)
      return {
        ...base,
        ok: false,
        level: 'rot',
        detail: `letzte Sicherung vom ${when} (${Math.floor(hours)} Std. alt)`,
      };
    if (size < 10_000)
      return {
        ...base,
        ok: false,
        level: 'rot',
        detail: `letzte Sicherung vom ${when} ist verdächtig klein (${size} Bytes)`,
      };
    return { ...base, ok: true, level: 'rot', detail: `letzte Sicherung ${when}` };
  } catch (e) {
    return { ...base, ok: false, level: 'rot', detail: `Sicherungsordner nicht lesbar (${msg(e)})` };
  }
}

export function checkMail(env: Env, mailer: Mailer): CheckResult | null {
  if (env.APP_ENV !== 'live') return null;
  const base = { key: 'mail', label: 'Mailversand', level: 'gelb' as const };
  if (mailer.configured === false)
    return {
      ...base,
      ok: false,
      detail: 'kein SMTP-Zugang – Rechnungen und Störungsmeldungen gehen nicht per Mail',
    };
  if (env.MAIL_TEST_RECIPIENT)
    return {
      ...base,
      ok: false,
      detail: `MAIL_TEST_RECIPIENT gesetzt – alle Mails gehen nur an ${env.MAIL_TEST_RECIPIENT}`,
    };
  return { ...base, ok: true, detail: 'eingerichtet' };
}

/** Zusätzliche Prüfungen anderer Module (z. B. Archiv-Kopie) melden sich hier an. */
type ExtraCheck = (deps: WatchdogDeps) => Promise<CheckResult | null>;
const extraChecks: ExtraCheck[] = [];
export function registerCheck(c: ExtraCheck) {
  extraChecks.push(c);
}

export async function runChecks(deps: WatchdogDeps, now = new Date()): Promise<CheckResult[]> {
  const { sql, env, mailer } = deps;
  const list = await Promise.all([
    checkDatabase(sql),
    checkKosit(env.KOSIT_VALIDATOR_URL),
    checkDisk(env.ARCHIVE_DIR),
    checkBackup(env.BACKUP_DIR, now),
    Promise.resolve(checkMail(env, mailer)),
    ...extraChecks.map((c) =>
      c(deps).catch((e): CheckResult => ({
        key: 'extra',
        label: 'Prüfung',
        ok: false,
        level: 'gelb',
        detail: msg(e),
      })),
    ),
  ]);
  return list.filter((c): c is CheckResult => !!c);
}

/** Letztes Ergebnis für /health/voll (eine Minute zwischengespeichert, damit Abfragen von außen nichts belasten). */
let cache: { at: number; list: CheckResult[] } | null = null;
export async function cachedChecks(deps: WatchdogDeps): Promise<CheckResult[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.list;
  const list = await runChecks(deps);
  cache = { at: Date.now(), list };
  return list;
}

async function alertRecipients(sql: Sql): Promise<string[]> {
  const [r] = await sql<{ emails: string[]; email: string | null }[]>`
    select coalesce((select emails from app.reminder_settings where id = 1), '{}') as emails,
           (select email from app.company where id = 1) as email`;
  if (r?.emails.length) return r.emails;
  return r?.email ? [r.email] : [];
}

/**
 * Prüft, speichert den Zustand und meldet Änderungen per Mail. Rückgabe: Anzahl verschickter Mails.
 * Ist die Datenbank weg, wird nur gemailt (ohne Zustand → höchstens einmal je Prozess-Stunde).
 */
let dbDownMailAt = 0;
export async function watch(deps: WatchdogDeps, now = new Date()): Promise<number> {
  const { sql, env, mailer } = deps;
  const list = await runChecks(deps, now);
  cache = { at: Date.now(), list };
  const today = todayBerlin(now);
  const db = list.find((c) => c.key === 'datenbank');
  const send = async (to: string[], subject: string, text: string, id: string) => {
    if (mailer.configured === false || !to.length) return 0;
    const { actual, redirected } = resolveRecipients(env, to);
    try {
      await mailer.send({
        from: env.MAIL_FROM,
        to: actual,
        subject: `${redirected ? '[TEST] ' : ''}${subject}`,
        text,
        attachments: [],
        messageId: `<${id}@viva-deluxe-app>`,
      });
    } catch (e) {
      console.error('Systemwächter: Mail nicht gesendet:', e);
      return -1;
    }
    return 1;
  };
  const url = env.PUBLIC_URL ?? 'die App';
  if (db && !db.ok) {
    if (now.getTime() - dbDownMailAt < 3_600_000 || !env.ALERT_EMAIL) return 0;
    dbDownMailAt = now.getTime();
    return Math.max(
      0,
      await send(
        [env.ALERT_EMAIL],
        'STÖRUNG Viva-Deluxe App: Datenbank nicht erreichbar',
        `${db.detail}\n\nDie App kann nichts speichern. Siehe Server-Anleitung → Notfall.\n${url}`,
        `stoerung-datenbank-${now.getTime()}`,
      ),
    );
  }
  const prev = new Map(
    (
      await sql<{ key: string; ok: boolean; alerted_on: string | null }[]>`
        select key, ok, alerted_on::text from app.system_checks`
    ).map((r) => [r.key, r]),
  );
  const to = env.ALERT_EMAIL ? [env.ALERT_EMAIL] : await alertRecipients(sql);
  let mails = 0;
  const failing = list.filter((c) => !c.ok && c.level === 'rot');
  const fresh = failing.filter((c) => prev.get(c.key)?.alerted_on !== today);
  const recovered = list.filter((c) => c.ok && prev.get(c.key)?.alerted_on);
  for (const c of list) {
    const p = prev.get(c.key);
    const alerted = !c.ok && c.level === 'rot' ? (fresh.includes(c) ? today : (p?.alerted_on ?? null)) : null;
    await sql`
      insert into app.system_checks (key, label, ok, level, detail, since, checked_at, alerted_on)
      values (${c.key}, ${c.label}, ${c.ok}, ${c.level}, ${c.detail}, now(), now(), ${alerted})
      on conflict (key) do update set label = excluded.label, level = excluded.level, detail = excluded.detail,
        checked_at = now(), alerted_on = excluded.alerted_on,
        since = case when app.system_checks.ok = excluded.ok then app.system_checks.since else now() end,
        ok = excluded.ok`;
  }
  if (fresh.length) {
    const r = await send(
      to,
      `STÖRUNG Viva-Deluxe App: ${fresh.map((c) => c.label).join(', ')}`,
      [
        'Der Systemwächter hat eine Störung festgestellt:',
        '',
        ...failing.map((c) => `!! ${c.label}: ${c.detail}`),
        '',
        `Stand in der App: Übersicht → Erinnerungen (${url}). Hilfe: Server-Anleitung → Notfall.`,
        'Diese Meldung kommt höchstens einmal am Tag je Störung; bei Behebung kommt eine Entwarnung.',
      ].join('\n'),
      `stoerung-${today}-${fresh.map((c) => c.key).join('-')}`,
    );
    // Mail ging nicht raus → beim nächsten Durchlauf erneut versuchen
    if (r < 0)
      await sql`update app.system_checks set alerted_on = null where key in ${sql(fresh.map((c) => c.key))}`;
    else mails += r;
  }
  if (recovered.length) {
    mails += Math.max(
      0,
      await send(
        to,
        `Entwarnung Viva-Deluxe App: ${recovered.map((c) => c.label).join(', ')} wieder in Ordnung`,
        recovered.map((c) => `OK ${c.label}: ${c.detail}`).join('\n'),
        `entwarnung-${now.getTime()}`,
      ),
    );
  }
  return mails;
}

export async function storedChecks(sql: Sql) {
  return sql<(CheckResult & { since: string; checked_at: string })[]>`
    select key, label, ok, level, detail, since::text, checked_at::text from app.system_checks order by key`;
}
