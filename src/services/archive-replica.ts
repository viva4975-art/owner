import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { S3Client } from '../archive/s3.js';
import type { Env } from '../config/env.js';
import type { Sql } from '../db/client.js';
import { type CheckResult, registerCheck } from './watchdog.js';

/**
 * Revisionssichere Archiv-Kopie (GoBD, Ahmed 10.10.): Die App legt Belege write-once auf dem Server ab. Das schützt
 * nicht gegen root, Plattenschaden oder Löschen des Servers. Deshalb wird jede Datei zusätzlich in einen
 * S3-Speicher mit Object Lock im Compliance-Modus kopiert – dort kann sie bis zum Fristende niemand löschen
 * oder überschreiben, auch nicht der Kontoinhaber oder der Anbieter.
 *
 * Kopiert werden: alles unter ARCHIVE_DIR (Rechnungen inkl. E-Rechnung, Storno, Mahnungen, Kassenbuch,
 * Karten-Belege, Kontoauszüge, Arbeitsscheine, unterschriebene Dokumente, Importe …) und aus FILES_DIR nur
 * Buchungsbelege: Dateien an Eingangsrechnungen und Rechnungen, eingelesene E-Rechnungen, Lohnabrechnungen.
 * Sonstige Uploads (Ausschreibungsunterlagen, Fotos, Personalakte) bleiben bewusst draußen – eine 10-Jahres-Sperre
 * ließe sich bei einem DSGVO-Löschanspruch nicht aufheben.
 *
 * Frist: bis 31.12. des 10. Jahres nach dem Ablagejahr (§ 147 AO; Buchungsbelege seit 2025 8 Jahre – 10 ist die
 * sichere Obergrenze für alles im Archiv).
 */

export function s3FromEnv(env: Env): S3Client | null {
  if (!env.S3_ENDPOINT || !env.S3_REGION || !env.S3_BUCKET || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY)
    return null;
  return new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY,
  });
}

/** 31.12. des 10. Folgejahres nach dem Ablagejahr (Berliner Zeit). */
export function retainUntil(stored: Date): string {
  const y = Number(
    new Intl.DateTimeFormat('en', { timeZone: 'Europe/Berlin', year: 'numeric' }).format(stored),
  );
  return `${y + 10}-12-31`;
}

interface Candidate {
  key: string;
  file: string;
  stored: Date;
}

async function walk(root: string, dir = root, out: Candidate[] = []): Promise<Candidate[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw e;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(root, p, out);
    else if (e.isFile() && !/\.(part|tmp)$/.test(e.name)) {
      const s = await stat(p);
      out.push({ key: `archiv/${relative(root, p).split('\\').join('/')}`, file: p, stored: s.mtime });
    }
  }
  return out;
}

/** Alle Dateien, die eine gesperrte Kopie brauchen. */
export async function candidates(sql: Sql, env: Env): Promise<Candidate[]> {
  const list = await walk(resolve(env.ARCHIVE_DIR));
  const files = await sql<{ storage_path: string; completed_at: Date }[]>`
    select f.storage_path, f.completed_at from app.files f
     where f.status = 'complete' and f.storage_path is not null
       and (exists (select 1 from app.file_links l where l.file_id = f.id
                     and l.entity_type in ('invoice', 'incoming_invoice'))
            or exists (select 1 from app.incoming_invoices i where i.einvoice_file_id = f.id)
            or exists (select 1 from app.payslips p where p.file_id = f.id))`;
  const root = resolve(env.FILES_DIR);
  for (const f of files)
    list.push({ key: `dateien/${f.storage_path}`, file: join(root, f.storage_path), stored: f.completed_at });
  return list;
}

export interface ReplicaRun {
  copied: number;
  failed: number;
  pending: number;
  skipped: string | null;
}

let running = false;

/**
 * Kopiert ausstehende Dateien (höchstens maxFiles bzw. maxBytes je Lauf). Fehlgeschlagene werden nach
 * 30 Minuten erneut versucht. Vorher wird geprüft, ob der Bucket Object Lock eingeschaltet hat – sonst wird
 * nichts kopiert (eine Kopie ohne Sperre wäre nicht revisionssicher).
 */
export async function replicate(
  deps: { sql: Sql; env: Env },
  opts: { maxFiles?: number; maxBytes?: number; client?: S3Client } = {},
): Promise<ReplicaRun> {
  const client = opts.client ?? s3FromEnv(deps.env);
  if (!client) return { copied: 0, failed: 0, pending: 0, skipped: 'nicht eingerichtet' };
  if (running) return { copied: 0, failed: 0, pending: 0, skipped: 'läuft bereits' };
  running = true;
  try {
    const { sql, env } = deps;
    const lock = await client.lockConfiguration();
    if (!lock.enabled)
      return { copied: 0, failed: 0, pending: 0, skipped: 'Object Lock im Bucket nicht eingeschaltet' };
    const done = new Map(
      (
        await sql<{ key: string; status: string; recent: boolean }[]>`
          select key, status, updated_at > now() - interval '30 minutes' as recent from app.archive_replicas`
      ).map((r) => [r.key, r]),
    );
    const todo = (await candidates(sql, env)).filter((c) => {
      const d = done.get(c.key);
      return !d || (d.status === 'fehler' && !d.recent);
    });
    const maxFiles = opts.maxFiles ?? 300;
    const maxBytes = opts.maxBytes ?? 2 * 1024 ** 3;
    let bytes = 0;
    let copied = 0;
    let failed = 0;
    let handled = 0;
    for (const c of todo) {
      if (handled >= maxFiles || bytes >= maxBytes) break;
      handled++;
      const until = retainUntil(c.stored);
      try {
        const size = (await stat(c.file)).size;
        if (size > 5 * 1024 ** 3) throw new Error('größer als 5 GB – bitte von Hand sichern');
        bytes += size;
        let head = await client.head(c.key);
        let versionId: string | null = null;
        let sha: string;
        if (head) {
          sha = head.sha256 ?? '';
        } else {
          const put = await client.putLocked(c.key, c.file, until);
          versionId = put.versionId;
          sha = put.sha256;
          head = await client.head(c.key);
        }
        if (!head) throw new Error('nach dem Hochladen nicht auffindbar');
        if (head.lockMode !== 'COMPLIANCE')
          throw new Error(`Sperre fehlt (Modus ${head.lockMode ?? 'keiner'})`);
        if (head.size !== size) throw new Error(`Größe weicht ab (${head.size} statt ${size})`);
        await sql`
          insert into app.archive_replicas (key, sha256, size_bytes, retain_until, status, attempts, version_id,
                                            replicated_at, updated_at, last_error)
          values (${c.key}, ${sha}, ${size}, ${(head.retainUntil ?? until).slice(0, 10)}, 'ok', 1, ${versionId},
                  now(), now(), null)
          on conflict (key) do update set sha256 = excluded.sha256, size_bytes = excluded.size_bytes,
            retain_until = excluded.retain_until, status = 'ok', attempts = app.archive_replicas.attempts + 1,
            version_id = coalesce(excluded.version_id, app.archive_replicas.version_id),
            replicated_at = now(), updated_at = now(), last_error = null`;
        copied++;
      } catch (e) {
        failed++;
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        await sql`
          insert into app.archive_replicas (key, status, attempts, last_error, retain_until, updated_at)
          values (${c.key}, 'fehler', 1, ${msg}, ${until}, now())
          on conflict (key) do update set status = 'fehler', attempts = app.archive_replicas.attempts + 1,
            last_error = excluded.last_error, updated_at = now()`;
      }
    }
    return { copied, failed, pending: todo.length - handled, skipped: null };
  } finally {
    running = false;
  }
}

export async function replicaSummary(sql: Sql, env: Env) {
  const [s] = await sql<{ ok: number; fehler: number; bytes: string | null; last: Date | null }[]>`
    select count(*) filter (where status = 'ok')::int as ok, count(*) filter (where status = 'fehler')::int as fehler,
           sum(size_bytes) filter (where status = 'ok')::text as bytes, max(replicated_at) as last
      from app.archive_replicas`;
  const okKeys = new Set(
    (await sql<{ key: string }[]>`select key from app.archive_replicas where status = 'ok'`).map(
      (r) => r.key,
    ),
  );
  const open = (await candidates(sql, env)).filter((c) => !okKeys.has(c.key));
  const oldest = open.reduce<Date | null>((m, c) => (!m || c.stored < m ? c.stored : m), null);
  const errors = await sql<{ key: string; attempts: number; last_error: string | null; updated_at: Date }[]>`
    select key, attempts, last_error, updated_at from app.archive_replicas where status = 'fehler'
     order by updated_at desc limit 50`;
  return {
    ok: s?.ok ?? 0,
    fehler: s?.fehler ?? 0,
    bytes: Number(s?.bytes ?? 0),
    last: s?.last ?? null,
    open: open.length,
    oldest,
    errors,
  };
}

/** Prüfung für den Systemwächter. */
export async function replicaCheck(
  deps: { sql: Sql; env: Env },
  client = s3FromEnv(deps.env),
): Promise<CheckResult | null> {
  const base = { key: 'archivkopie', label: 'Revisionssichere Archiv-Kopie (S3)' };
  if (!client)
    return deps.env.APP_ENV === 'live'
      ? { ...base, ok: false, level: 'gelb', detail: 'noch nicht eingerichtet (S3 mit Object Lock fehlt)' }
      : null;
  try {
    const lock = await client.lockConfiguration();
    if (!lock.enabled)
      return { ...base, ok: false, level: 'rot', detail: 'Object Lock im Bucket ist nicht eingeschaltet' };
  } catch (e) {
    return {
      ...base,
      ok: false,
      level: 'rot',
      detail: `Speicher nicht erreichbar (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  const s = await replicaSummary(deps.sql, deps.env);
  const hours = s.oldest ? (Date.now() - s.oldest.getTime()) / 3_600_000 : 0;
  if (s.open && hours > 24)
    return {
      ...base,
      ok: false,
      level: 'rot',
      detail: `${s.open} Datei(en) seit über 24 Std. ohne gesperrte Kopie`,
    };
  if (s.fehler)
    return {
      ...base,
      ok: false,
      level: 'gelb',
      detail: `${s.fehler} Datei(en) mit Fehler – wird wiederholt`,
    };
  return {
    ...base,
    ok: true,
    level: 'rot',
    detail: `${s.ok} Datei(en) gesperrt gesichert${s.open ? `, ${s.open} in Arbeit` : ''}`,
  };
}

registerCheck((deps) => replicaCheck(deps));
