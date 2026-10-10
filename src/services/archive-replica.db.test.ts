import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3Client } from '../archive/s3.js';
import type { Sql } from '../db/client.js';
import { replicaCheck, replicaSummary, replicate, retainUntil } from './archive-replica.js';
import { dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

// S3-Nachbau mit Object Lock (moto_server -p 5055); ohne ihn wird der Test übersprungen
const MOTO = process.env.S3_TEST_ENDPOINT ?? 'http://127.0.0.1:5055';
const motoUp = await fetch(MOTO, { signal: AbortSignal.timeout(1000) }).then(
  () => true,
  () => false,
);
const available = (await dbAvailable()) && motoUp;

describe('Archiv-Kopie Frist', () => {
  it('bis 31.12. des 10. Folgejahres (Berliner Zeit)', () => {
    expect(retainUntil(new Date('2026-10-10T12:00:00Z'))).toBe('2036-12-31');
    expect(retainUntil(new Date('2026-12-31T23:30:00Z'))).toBe('2037-12-31');
  });
});

describe.skipIf(!available)('Archiv-Kopie in S3 mit Object Lock (moto)', () => {
  let sql: Sql;
  let deps: Deps;
  let dir: string;
  const bucket = `archiv-${Date.now()}`;
  const client = new S3Client({
    endpoint: MOTO,
    region: 'us-east-1',
    bucket,
    accessKey: 'a',
    secretKey: 'b',
  });
  const plain = new S3Client({
    endpoint: MOTO,
    region: 'us-east-1',
    bucket: `${bucket}-ohne`,
    accessKey: 'a',
    secretKey: 'b',
  });
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
    dir = await mkdtemp(join(tmpdir(), 'archiv-'));
    deps.env = { ...deps.env, ARCHIVE_DIR: join(dir, 'a'), FILES_DIR: join(dir, 'f'), APP_ENV: 'live' };
    await mkdir(join(dir, 'a', 'invoices', '2026'), { recursive: true });
    await writeFile(join(dir, 'a', 'invoices', '2026', 'RE 1038400.pdf'), 'pdf-inhalt');
    await writeFile(join(dir, 'a', 'invoices', '2026', 'RE 1038400.xml'), '<Invoice/>');
    await writeFile(join(dir, 'a', 'invoices', '2026', 'halb.pdf.part'), 'x');
    const mk = (b: string, lock: boolean) =>
      fetch(`${MOTO}/${b}`, {
        method: 'PUT',
        headers: lock ? { 'x-amz-bucket-object-lock-enabled': 'true' } : {},
      });
    await mk(bucket, true);
    await mk(`${bucket}-ohne`, false);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await sql?.end();
  });

  it('kopiert nichts in einen Bucket ohne Object Lock', async () => {
    const r = await replicate(deps, { client: plain });
    expect(r.skipped).toMatch(/Object Lock/);
    expect((await replicaCheck(deps, plain))!).toMatchObject({ ok: false, level: 'rot' });
  });

  it('falscher Bucket-Name heißt „nicht gefunden“, nicht „nicht eingeschaltet“', async () => {
    const wrong = new S3Client({
      endpoint: MOTO,
      region: 'us-east-1',
      bucket: 'gibt-es-nicht',
      accessKey: 'a',
      secretKey: 'b',
    });
    await expect(wrong.lockStatus()).rejects.toThrow(/nicht gefunden/);
    expect((await replicaCheck(deps, wrong))!.detail).toMatch(/nicht gefunden/);
  });

  it('Sperre wirksam → Status eingeschaltet', async () => {
    expect(await client.lockStatus()).toMatchObject({ enabled: true });
  });

  it('kopiert gesperrt, bestätigt und kopiert nichts doppelt', async () => {
    const r = await replicate(deps, { client });
    expect(r).toMatchObject({ copied: 2, failed: 0, pending: 0 });
    const h = await client.head('archiv/invoices/2026/RE 1038400.pdf');
    expect(h).toMatchObject({ lockMode: 'COMPLIANCE', size: 10 });
    expect(h!.retainUntil).toMatch(/^20\d\d-12-31/);
    expect(await client.head('archiv/invoices/2026/halb.pdf.part')).toBeNull();
    // zweiter Lauf: nichts zu tun
    expect(await replicate(deps, { client })).toMatchObject({ copied: 0, pending: 0 });
    const s = await replicaSummary(sql, deps.env);
    expect(s).toMatchObject({ ok: 2, fehler: 0, open: 0 });
    expect((await replicaCheck(deps, client))!.ok).toBe(true);
    // neue Datei kommt beim nächsten Lauf dazu
    await writeFile(join(dir, 'a', 'invoices', '2026', 'ST 1038401.pdf'), 'storno');
    expect(await replicate(deps, { client })).toMatchObject({ copied: 1 });
  });

  it('nicht eingerichtet: im Echtbetrieb gelber Hinweis', async () => {
    expect((await replicaCheck(deps, null))!).toMatchObject({ ok: false, level: 'gelb' });
  });
});
