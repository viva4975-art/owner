import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { analyzeRooms, applyRooms } from './room-import.js';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { storeRoomBookPdf } from './room-pdf.js';
import { storeFile } from './uploads.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Raumbuch im Fortytools-Format + PDF in den Dokumenten', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('„Größe in m²“, Gebäudeteil + Etage, Beschreibung; 0 m² übersprungen; PDF einmal abgelegt', async () => {
    const csv = [
      'Kundennummer *;für dieses Objekt *;Name *;Nummer *;Gebäudeteil;Etage;Nutzungsart;Revier;Größe in m²;Bodenbelag;Beschreibung',
      '20198;20198001;Flur;A 0.01;A;UG;Flur;;12,76;Parkett;',
      '20198;20198001;Kriechkeller;A 0.09;A;UG;Nebenraum;;0,0;Anstrich;',
      '20198;20198001;Klasse 1a;B 1.01;B;EG;Klassenzimmer;;58,21;Linoleum;Tafel nass wischen',
    ].join('\n');
    const a = await analyzeRooms(sql, DEMO.siteSchool, new TextEncoder().encode(csv));
    const flur = a.rows.find((r) => r.roomNo === 'A 0.01')!;
    expect([flur.floor, flur.areaCenti, flur.covering]).toEqual(['A · UG', 1276n, 'Parkett']);
    expect(a.rows.find((r) => r.roomNo === 'A 0.09')!.errors[0]).toMatch(/0 m²/);
    expect(a.rows.find((r) => r.roomNo === 'B 1.01')!.notes).toBe('Tafel nass wischen');
    expect(a.buildings).toEqual([]); // Gebäudeteile A/B = ein Objekt
    const r = await applyRooms(sql, DEMO.siteSchool, 'ft', a, { update: true }, 't');
    expect([r.created, r.skipped]).toEqual([2, 1]);
    const cfg = { dir: await mkdtemp(join(tmpdir(), 'rb-')), maxBytes: 1e8 };
    const f1 = await storeRoomBookPdf(sql, cfg, DEMO.siteSchool, 't');
    const f2 = await storeRoomBookPdf(sql, cfg, DEMO.siteSchool, 't');
    expect(f2.id).toBe(f1.id);
    const links =
      await sql`select 1 from app.file_links where entity_type = 'site' and entity_id = ${DEMO.siteSchool}
                              and category = 'Raumbuch' and archived_at is null`;
    expect(links.length).toBe(1);
  }, 30_000);

  it('Raumbuch als PDF (Textebene) lesen; hochgeladenes Raumbuch wird von der App-PDF nicht archiviert', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([842, 595]);
    const put = (s: string, x: number, y: number) => p.drawText(s, { x, y, size: 7, font });
    put('Raumname *', 221, 531);
    put('Raumnummer *', 325, 531);
    put('Etage', 423, 531);
    put('Größe in m²', 548, 531);
    [
      ['Flur', 'C 0.01', 'EG', '12,76'],
      ['Lehrerzimmer', 'C 0.02', 'EG', '44,10'],
      ['Kriechkeller', 'C 0.03', 'UG', '0,00'],
    ].forEach((r, i) => {
      const y = 521 - i * 10;
      put(r[0]!, 221, y);
      put(r[1]!, 325, y);
      put(r[2]!, 423, y);
      put(r[3]!, 580 - font.widthOfTextAtSize(r[3]!, 7), y);
    });
    const bytes = await doc.save();
    const a = await analyzeRooms(sql, DEMO.siteSchool, bytes);
    const ok = a.rows.filter((r) => !r.errors.length);
    expect(ok.map((r) => [r.roomNo, r.areaCenti])).toEqual([
      ['C 0.01', 1276n],
      ['C 0.02', 4410n],
    ]);
    const cfg = { dir: await mkdtemp(join(tmpdir(), 'rb-')), maxBytes: 1e8 };
    const up = await storeFile(
      sql,
      cfg,
      {
        id: '00000000-0000-4000-8000-00000000f0a1',
        name: 'Raumbuch_Grundschule_Musterweg.pdf',
        type: 'application/pdf',
        data: bytes,
        link: { type: 'site', id: DEMO.siteSchool },
        category: 'Raumbuch',
      },
      't',
    );
    await applyRooms(sql, DEMO.siteSchool, 'pdf', a, { update: true }, 't');
    await storeRoomBookPdf(sql, cfg, DEMO.siteSchool, 't');
    const [l] = await sql<{ archived_at: Date | null }[]>`
      select archived_at from app.file_links where file_id = ${up.id}`;
    expect(l!.archived_at).toBeNull();
  }, 30_000);
});
