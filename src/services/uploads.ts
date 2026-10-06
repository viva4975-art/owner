import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Sql } from '../db/client.js';
import { BusinessError } from './errors.js';

/**
 * Große Dateien (z. B. ZIP-Ausschreibungsunterlagen) zuverlässig hochladen:
 *
 *  1. Der Browser meldet die Datei an (feste ID, Name, Größe) → Server legt einen Upload an.
 *  2. Die Datei geht in Stücken à 8 MiB, mehrere parallel. Jedes Stück ist einzeln wiederholbar
 *     (idempotent: gleiches Stück zweimal = einmal gespeichert).
 *  3. Bricht die Verbindung ab, fragt der Browser, welche Stücke schon da sind, und schickt nur den Rest.
 *  4. Abschluss: Stücke werden als Datenstrom zusammengesetzt (kein Laden ins RAM), SHA-256 berechnet,
 *     Datei schreibgeschützt abgelegt, Datensatz unveränderbar.
 *
 * Live-Betrieb: Supabase Storage bietet dasselbe Prinzip (TUS, fortsetzbar) direkt vom Browser in den
 * Speicher – dann läuft der Datenstrom nicht über unseren Server. Die Schnittstelle bleibt gleich.
 */

export const CHUNK_SIZE = 8 * 1024 * 1024;

export interface UploadConfig {
  dir: string;
  maxBytes: number;
}

export interface FileRow {
  id: string;
  original_name: string;
  content_type: string;
  size_bytes: bigint;
  chunk_size: number;
  total_chunks: number;
  status: 'uploading' | 'complete';
  sha256: string | null;
  storage_path: string | null;
  uploaded_by: string;
  created_at: Date;
  completed_at: Date | null;
}

export type LinkTarget = {
  type:
    | 'offer'
    | 'invoice'
    | 'customer'
    | 'site'
    | 'employee'
    | 'supplier'
    | 'incoming_invoice'
    | 'purchase_order'
    | 'order'
    | 'work_report'
    | 'quality_check'
    | 'inbox'
    | 'tender'
    | 'note';
  id: string;
};

function safeName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex -- Steuerzeichen in Dateinamen bewusst ersetzen
    .replace(/[/\\?%*:|"<>\x00-\x1f]/g, '_')
    .replace(/^\.+/, '_')
    .trim()
    .slice(0, 200);
  return cleaned || 'datei';
}

const chunkDir = (cfg: UploadConfig, id: string) => join(resolve(cfg.dir), '.chunks', id);

export async function startUpload(
  sql: Sql,
  cfg: UploadConfig,
  input: {
    id: string;
    name: string;
    size: number;
    type: string;
    link: LinkTarget | null;
    category: string | null;
  },
  actor: string,
): Promise<{ id: string; chunkSize: number; totalChunks: number; received: number[]; status: string }> {
  if (!/^[0-9a-f-]{36}$/.test(input.id)) throw new BusinessError('Ungültige Upload-ID');
  if (!Number.isSafeInteger(input.size) || input.size < 0) throw new BusinessError('Ungültige Dateigröße');
  if (input.size > cfg.maxBytes) {
    throw new BusinessError(`Datei ist zu groß (max. ${Math.round(cfg.maxBytes / 1024 ** 3)} GB)`);
  }
  const totalChunks = Math.ceil(input.size / CHUNK_SIZE);
  await sql.begin(async (tx) => {
    await tx`
      insert into app.files (id, original_name, content_type, size_bytes, chunk_size, total_chunks, uploaded_by)
      values (${input.id}, ${safeName(input.name)}, ${input.type || 'application/octet-stream'}, ${input.size},
              ${CHUNK_SIZE}, ${totalChunks}, ${actor})
      on conflict (id) do nothing`;
    const [f] = await tx<FileRow[]>`select * from app.files where id = ${input.id}`;
    if (!f || f.size_bytes !== BigInt(input.size) || f.original_name !== safeName(input.name)) {
      throw new BusinessError('Upload-ID gehört zu einer anderen Datei');
    }
    if (input.link) {
      await tx`insert into app.file_links (file_id, entity_type, entity_id, category, linked_by)
               values (${input.id}, ${input.link.type}, ${input.link.id}, ${input.category}, ${actor})
               on conflict do nothing`;
    }
  });
  await mkdir(chunkDir(cfg, input.id), { recursive: true });
  return { ...(await uploadStatus(sql, cfg, input.id)), chunkSize: CHUNK_SIZE, totalChunks };
}

export async function uploadStatus(sql: Sql, cfg: UploadConfig, id: string) {
  const [f] = await sql<FileRow[]>`select * from app.files where id = ${id}`;
  if (!f) throw new BusinessError('Upload nicht gefunden');
  if (f.status === 'complete') {
    return {
      id,
      chunkSize: f.chunk_size,
      totalChunks: f.total_chunks,
      received: [...Array(f.total_chunks).keys()],
      status: 'complete',
    };
  }
  let names: string[] = [];
  try {
    names = await readdir(chunkDir(cfg, id));
  } catch {
    /* noch keine Stücke */
  }
  const received = names
    .filter((n) => /^\d+$/.test(n))
    .map(Number)
    .sort((a, b) => a - b);
  return { id, chunkSize: f.chunk_size, totalChunks: f.total_chunks, received, status: f.status };
}

function expectedChunkLength(f: FileRow, index: number): number {
  const size = Number(f.size_bytes);
  return index === f.total_chunks - 1 ? size - index * f.chunk_size : f.chunk_size;
}

/** Ein Stück speichern. Atomar (erst temporär, dann umbenennen) und idempotent. */
export async function putChunk(sql: Sql, cfg: UploadConfig, id: string, index: number, data: Uint8Array) {
  const [f] = await sql<FileRow[]>`select * from app.files where id = ${id}`;
  if (!f) throw new BusinessError('Upload nicht gefunden');
  if (f.status === 'complete') return;
  if (!Number.isInteger(index) || index < 0 || index >= f.total_chunks)
    throw new BusinessError('Ungültige Stücknummer');
  if (data.byteLength !== expectedChunkLength(f, index)) {
    throw new BusinessError(
      `Stück ${index} hat ${data.byteLength} statt ${expectedChunkLength(f, index)} Bytes`,
    );
  }
  const dir = chunkDir(cfg, id);
  await mkdir(dir, { recursive: true });
  const final = join(dir, String(index));
  const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, final);
}

/** Abschluss: zusammensetzen (Datenstrom), Prüfsumme, schreibgeschützt ablegen. */
export async function completeUpload(sql: Sql, cfg: UploadConfig, id: string): Promise<FileRow> {
  const [f] = await sql<FileRow[]>`select * from app.files where id = ${id}`;
  if (!f) throw new BusinessError('Upload nicht gefunden');
  if (f.status === 'complete') return f;
  const st = await uploadStatus(sql, cfg, id);
  if (st.received.length !== f.total_chunks) {
    const missing = f.total_chunks - st.received.length;
    throw new BusinessError(`Es fehlen noch ${missing} Teile – Upload wird fortgesetzt`);
  }
  const now = new Date();
  const rel = join(
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    `${id}_${f.original_name}`,
  );
  const target = join(resolve(cfg.dir), rel);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.part`;
  const hash = createHash('sha256');
  const out = createWriteStream(tmp, { flags: 'w' });
  let writeError: Error | null = null;
  out.on('error', (e) => (writeError = e));
  try {
    for (let i = 0; i < f.total_chunks; i++) {
      for await (const buf of createReadStream(join(chunkDir(cfg, id), String(i)))) {
        hash.update(buf as Buffer);
        if (!out.write(buf)) await once(out, 'drain');
        if (writeError) throw writeError;
      }
    }
  } finally {
    await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
  }
  if (writeError) throw writeError;
  const size = (await stat(tmp)).size;
  if (size !== Number(f.size_bytes)) {
    await rm(tmp, { force: true });
    throw new BusinessError('Größe stimmt nach dem Zusammensetzen nicht – bitte erneut hochladen');
  }
  await rename(tmp, target);
  await chmod(target, 0o444);
  const sha = hash.digest('hex');
  const [done] = await sql<FileRow[]>`
    update app.files set status = 'complete', sha256 = ${sha}, storage_path = ${rel}, completed_at = now()
     where id = ${id} and status = 'uploading' returning *`;
  await rm(chunkDir(cfg, id), { recursive: true, force: true });
  if (!done) {
    // parallel abgeschlossen – den gespeicherten Stand zurückgeben
    const [again] = await sql<FileRow[]>`select * from app.files where id = ${id}`;
    return again!;
  }
  return done;
}

export async function listFiles(sql: Sql, link: LinkTarget) {
  return sql<(FileRow & { category: string | null })[]>`
    select f.*, l.category from app.file_links l join app.files f on f.id = l.file_id
     where l.entity_type = ${link.type} and l.entity_id = ${link.id} and f.status = 'complete'
     order by f.completed_at desc`;
}

export function filePath(cfg: UploadConfig, f: FileRow): string {
  if (!f.storage_path) throw new BusinessError('Datei ist noch nicht vollständig hochgeladen');
  return join(resolve(cfg.dir), f.storage_path);
}

/** Abgebrochene Uploads nach `maxAgeHours` aufräumen (Teilstücke löschen). */
export async function cleanupStaleUploads(sql: Sql, cfg: UploadConfig, maxAgeHours = 72) {
  const stale = await sql<{ id: string }[]>`
    select id from app.files where status = 'uploading' and created_at < now() - make_interval(hours => ${maxAgeHours})`;
  for (const s of stale) {
    await rm(chunkDir(cfg, s.id), { recursive: true, force: true });
    await sql`delete from app.file_links where file_id = ${s.id}`;
    await sql`delete from app.files where id = ${s.id} and status = 'uploading'`;
  }
  return stale.length;
}

/**
 * Serverseitig erzeugte Datei (z. B. Brief aus Vorlage) direkt als fertige Datei ablegen: write-once,
 * SHA-256, mit Verknüpfung. Idempotent über die ID.
 */
export async function storeFile(
  sql: Sql,
  cfg: UploadConfig,
  p: { id: string; name: string; type: string; data: Uint8Array; link: LinkTarget; category: string | null },
  actor: string,
): Promise<FileRow> {
  const [exists] = await sql<FileRow[]>`select * from app.files where id = ${p.id}`;
  if (exists) return exists;
  const name = safeName(p.name);
  const now = new Date();
  const rel = join(
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    `${p.id}_${name}`,
  );
  const target = join(resolve(cfg.dir), rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(`${target}.part`, p.data);
  await rename(`${target}.part`, target);
  await chmod(target, 0o444);
  const sha = createHash('sha256').update(p.data).digest('hex');
  return sql.begin(async (tx) => {
    const [f] = await tx<FileRow[]>`
      insert into app.files (id, original_name, content_type, size_bytes, chunk_size, total_chunks, uploaded_by,
                             status, sha256, storage_path, completed_at)
      values (${p.id}, ${name}, ${p.type}, ${p.data.byteLength}, ${CHUNK_SIZE}, 1, ${actor},
              'complete', ${sha}, ${rel}, now())
      returning *`;
    await tx`insert into app.file_links (file_id, entity_type, entity_id, category, linked_by)
             values (${p.id}, ${p.link.type}, ${p.link.id}, ${p.category}, ${actor}) on conflict do nothing`;
    return f!;
  });
}
