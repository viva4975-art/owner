import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import {
  CHUNK_SIZE,
  completeUpload,
  filePath,
  listFiles,
  putChunk,
  startUpload,
  uploadStatus,
  type UploadConfig,
} from './uploads.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Große Uploads', () => {
  let sql: Sql;
  let cfg: UploadConfig;
  beforeAll(async () => {
    sql = await freshDatabase();
    cfg = { dir: await mkdtemp(join(tmpdir(), 'viva-files-')), maxBytes: 5 * 1024 ** 3 };
  });
  afterAll(async () => {
    await sql?.end();
  });

  const chunksOf = (data: Buffer) =>
    Array.from({ length: Math.ceil(data.length / CHUNK_SIZE) }, (_, i) =>
      data.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
    );

  it('setzt Stücke in beliebiger Reihenfolge korrekt zusammen (SHA-256 identisch)', async () => {
    const data = randomBytes(CHUNK_SIZE * 3 + 12345);
    const id = randomUUID();
    await startUpload(
      sql,
      cfg,
      {
        id,
        name: 'Ausschreibung LHM 2026.zip',
        size: data.length,
        type: 'application/zip',
        link: { type: 'customer', id: DEMO.authority },
        category: 'Ausschreibung',
      },
      'test',
    );
    const parts = chunksOf(data);
    for (const i of [3, 0, 2, 1]) await putChunk(sql, cfg, id, i, parts[i]!);
    await putChunk(sql, cfg, id, 2, parts[2]!); // doppelt (Wiederholung nach Zeitüberschreitung)
    const f = await completeUpload(sql, cfg, id);
    expect(f.status).toBe('complete');
    expect(f.sha256).toBe(createHash('sha256').update(data).digest('hex'));
    const stored = await readFile(filePath(cfg, f));
    expect(stored.equals(data)).toBe(true);
    expect(((await stat(filePath(cfg, f))).mode & 0o222) === 0).toBe(true); // schreibgeschützt
    expect(
      (await listFiles(sql, { type: 'customer', id: DEMO.authority })).map((x) => x.original_name),
    ).toEqual(['Ausschreibung LHM 2026.zip']);
  });

  it('Abbruch und Fortsetzen: Server meldet vorhandene Stücke, Abschluss erst wenn vollständig', async () => {
    const data = randomBytes(CHUNK_SIZE * 2 + 1);
    const id = randomUUID();
    await startUpload(
      sql,
      cfg,
      { id, name: 'gross.zip', size: data.length, type: 'application/zip', link: null, category: null },
      'test',
    );
    const parts = chunksOf(data);
    await putChunk(sql, cfg, id, 0, parts[0]!);
    await expect(completeUpload(sql, cfg, id)).rejects.toThrow(/fehlen noch 2 Teile/);
    // „Seite neu geladen“: gleiche ID erneut anmelden → vorhandene Stücke kommen zurück
    const again = await startUpload(
      sql,
      cfg,
      { id, name: 'gross.zip', size: data.length, type: 'application/zip', link: null, category: null },
      'test',
    );
    expect(again.received).toEqual([0]);
    await putChunk(sql, cfg, id, 1, parts[1]!);
    await putChunk(sql, cfg, id, 2, parts[2]!);
    expect((await completeUpload(sql, cfg, id)).sha256).toBe(createHash('sha256').update(data).digest('hex'));
    expect((await uploadStatus(sql, cfg, id)).status).toBe('complete');
  });

  it('lehnt falsche Stückgröße, fremde Datei unter gleicher ID und Übergröße ab', async () => {
    const id = randomUUID();
    await startUpload(
      sql,
      cfg,
      { id, name: 'a.zip', size: 100, type: 'application/zip', link: null, category: null },
      'test',
    );
    await expect(putChunk(sql, cfg, id, 0, new Uint8Array(99))).rejects.toThrow(/statt 100 Bytes/);
    await expect(
      startUpload(sql, cfg, { id, name: 'b.zip', size: 100, type: '', link: null, category: null }, 'test'),
    ).rejects.toThrow(/anderen Datei/);
    await expect(
      startUpload(
        sql,
        { ...cfg, maxBytes: 1000 },
        { id: randomUUID(), name: 'c.zip', size: 2000, type: '', link: null, category: null },
        'test',
      ),
    ).rejects.toThrow(/zu groß/);
  });

  it('abgeschlossene Datei ist unveränderbar', async () => {
    const id = randomUUID();
    await startUpload(
      sql,
      cfg,
      { id, name: 'leer.txt', size: 3, type: 'text/plain', link: null, category: null },
      'test',
    );
    await putChunk(sql, cfg, id, 0, new TextEncoder().encode('abc'));
    await completeUpload(sql, cfg, id);
    await expect(sql`update app.files set original_name = 'x' where id = ${id}`).rejects.toThrow(
      /unveränderbar/,
    );
    await expect(sql`delete from app.files where id = ${id}`).rejects.toThrow(/nicht gelöscht/);
  });

  it('200 MB in Stücken: schnell und speicherschonend', async () => {
    const size = 200 * 1024 * 1024;
    const id = randomUUID();
    const t0 = Date.now();
    await startUpload(
      sql,
      cfg,
      {
        id,
        name: 'Vergabeunterlagen_komplett.zip',
        size,
        type: 'application/zip',
        link: null,
        category: null,
      },
      'test',
    );
    const hash = createHash('sha256');
    const n = Math.ceil(size / CHUNK_SIZE);
    for (let i = 0; i < n; i += 4) {
      await Promise.all(
        Array.from({ length: Math.min(4, n - i) }, (_, k) => {
          const len = i + k === n - 1 ? size - (i + k) * CHUNK_SIZE : CHUNK_SIZE;
          const part = Buffer.alloc(len, (i + k) % 251);
          return { part, idx: i + k };
        })
          .map((x) => (hash.update(x.part), x))
          .map((x) => putChunk(sql, cfg, id, x.idx, x.part)),
      );
    }
    const f = await completeUpload(sql, cfg, id);
    const ms = Date.now() - t0;
    expect(f.sha256).toBe(hash.digest('hex'));
    expect(ms).toBeLessThan(20_000);
    console.log(`200 MB hochgeladen und zusammengesetzt in ${ms} ms`);
  }, 60_000);
});
