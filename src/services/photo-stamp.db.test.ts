import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { saveStampedPhoto, stampLines, uuidFrom } from './photo-stamp.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const ok = await dbAvailable();

describe.skipIf(!ok)('Foto mit Stempel', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('stempelt, legt Original ohne Verknüpfung ab, doppelt absenden legt nichts doppelt an', async () => {
    const cfg = { dir: await mkdtemp(join(tmpdir(), 'viva-foto-')), maxBytes: 50_000_000 };
    const img = new Uint8Array(
      await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#88aacc' } })
        .jpeg()
        .toBuffer(),
    );
    const info = {
      site: '2001 · Grundschule',
      address: 'Musterstr. 1, 80000 München',
      at: new Date('2026-10-18T08:15:00Z'),
      by: 'Olga Objekt',
      geo: 'am_objekt',
      distanceM: 35,
      lat: 48.1,
      lng: 11.5,
    };
    expect(stampLines(info)[1]).toBe('18.10.2026 · 10:15 Uhr · Olga Objekt');
    expect(stampLines(info)[2]).toContain('am Objekt (35 m)');
    const id = uuidFrom('test:1');
    const p = {
      id,
      data: img,
      name: 'IMG_1.HEIC.jpg',
      type: 'image/jpeg',
      link: { type: 'site' as const, id: DEMO.siteSchool },
      category: 'Fotos',
      source: 'foto' as const,
      siteId: DEMO.siteSchool,
      info,
      accuracy: 12,
      actor: 'test',
    };
    await saveStampedPhoto(sql, cfg, p);
    await saveStampedPhoto(sql, cfg, p);
    const rows = await sql`select * from app.photo_stamps where file_id = ${id}`;
    expect(rows).toHaveLength(1);
    const links =
      await sql`select entity_type, category from app.file_links where file_id = ${rows[0]!.original_file_id}`;
    expect(links).toHaveLength(0);
    const [f] = await sql<
      { content_type: string; size_bytes: string }[]
    >`select content_type, size_bytes::text from app.files where id = ${id}`;
    expect(f!.content_type).toBe('image/jpeg');
    await expect(sql`update app.photo_stamps set note = 'x' where file_id = ${id}`).rejects.toThrow(
      /unveränderbar/,
    );
  });
});
