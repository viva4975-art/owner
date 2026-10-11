import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { analyzeRooms, applyRooms } from './room-import.js';
import { storeRoomBookPdf } from './room-pdf.js';
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
});
