import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { saveStampedPhoto, stampLines, uuidFrom } from './photo-stamp.js';
import { deletePhotoGroup, listPhotoGroups, photoGroupsByPdf, savePhotoGroup } from './photo-groups.js';
import { PDFDocument } from '@cantoo/pdf-lib';
import { INBOX_ID } from './documents.js';
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

  it('Gruppe: 12 Fotos → ein PDF im Dokumenteneingang, doppelt absenden nichts doppelt, löschen', async () => {
    const cfg = { dir: await mkdtemp(join(tmpdir(), 'viva-fotogr-')), maxBytes: 50_000_000 };
    const img = new Uint8Array(
      await sharp({ create: { width: 800, height: 600, channels: 3, background: '#cc8844' } })
        .jpeg()
        .toBuffer(),
    );
    const files = Array.from({ length: 12 }, (_, i) => ({
      data: img,
      name: `f${i}.jpg`,
      type: 'image/jpeg',
    }));
    files.push({ data: new Uint8Array([1, 2, 3]), name: 'kaputt.jpg', type: 'image/jpeg' });
    const p = {
      id: uuidFrom('gruppe:1'),
      siteId: null,
      siteLabel: null,
      address: null,
      place: 'Musterstr. 5, Treppenhaus',
      note: 'Urin im Aufzug',
      files,
      by: 'Olga Objekt',
      geo: null,
      distanceM: null,
      accuracy: null,
      lat: null,
      lng: null,
      actor: 'test',
    };
    const r = await savePhotoGroup(sql, cfg, p);
    expect(r.saved).toBe(12);
    expect(r.failed).toHaveLength(1);
    const again = await savePhotoGroup(sql, cfg, p);
    expect(again.pdfId).toBe(r.pdfId);
    const [link] = await sql`select entity_type, entity_id from app.file_links where file_id = ${r.pdfId}`;
    expect(link).toMatchObject({ entity_type: 'inbox', entity_id: INBOX_ID });
    const [f] = await sql<
      { storage_path: string }[]
    >`select storage_path from app.files where id = ${r.pdfId}`;
    const pdf = await PDFDocument.load(
      await import('node:fs/promises').then((fs) => fs.readFile(join(cfg.dir, f!.storage_path))),
    );
    expect(pdf.getPageCount()).toBe(12);
    const g = (await photoGroupsByPdf(sql, [r.pdfId!])).get(r.pdfId!)!;
    expect(g.photos).toHaveLength(12);
    expect((await listPhotoGroups(sql, { createdBy: 'test' })).map((x) => x.id)).toContain(p.id);
    expect(await deletePhotoGroup(sql, p.id, 'test')).toBe(true);
    expect(await sql`select 1 from app.file_links where file_id = ${r.pdfId}`).toHaveLength(0);
    expect((await listPhotoGroups(sql, { createdBy: 'test' })).map((x) => x.id)).not.toContain(p.id);
  });
});
