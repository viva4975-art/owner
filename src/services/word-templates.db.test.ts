import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { type FileRow, filePath } from './uploads.js';
import { generateFromWordTemplate, importWordTemplates, listWordTemplates } from './word-templates.js';

const available = await dbAvailable();
const docx = (text: string) =>
  zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(
      `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ),
  });

describe.skipIf(!available)('Word-Vorlagen (Datenbank)', () => {
  let sql: Sql;
  let dir: string;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    dir = await mkdtemp(join(tmpdir(), 'wt-'));
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date)
              values (${emp}, '5501', 'Rosa', 'Vorlage', '2025-02-01')`;
    await sql`insert into app.employee_private (employee_id, street, postal_code, city) values (${emp}, 'Hauptstr. 1', '81375', 'München')`;
  });
  afterAll(async () => {
    await sql?.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('ZIP importieren (ohne Dubletten) und Arbeitsvertrag ausfüllen', async () => {
    const cfg = { dir, maxBytes: 10_000_000 };
    const zip = zipSync({
      'X/00_ANLEITUNG.docx': docx('Anleitung'),
      'X/01_Vorlagen_Mitarbeiter/VD-AV-2026-V2_Arbeitsvertrag-Reinigungskraft.docx': docx(
        'Zwischen ${Firma.Name} und ${Mitarbeiter.Vorname} ${Mitarbeiter.Nachname}, ${Mitarbeiter.Straße}, geb. ${Mitarbeiter.Geburtsdatum}, ab ${Mitarbeiter.Eintrittsdatum}',
      ),
      'X/01_Vorlagen_Mitarbeiter/._VD-AV-2026-V2_Arbeitsvertrag-Reinigungskraft.docx': strToU8('mac'),
      'X/02_Vorlagen_Kunden/VD-AKQ-01_Akquise-Anschreiben-Vorlage.docx': docx('Sehr geehrte ${Kunde.Name}'),
    });
    const r = await importWordTemplates(sql, cfg, [{ name: 'v.zip', data: zip }], 't');
    expect(r.created.sort()).toEqual(['Akquise Anschreiben Vorlage', 'Arbeitsvertrag Reinigungskraft']);
    expect(r.skipped).toEqual(['00_ANLEITUNG.docx']);
    expect((await importWordTemplates(sql, cfg, [{ name: 'v.zip', data: zip }], 't')).existing.length).toBe(
      2,
    );
    const [av] = await listWordTemplates(sql, 'mitarbeiter');
    expect(av).toMatchObject({ code: 'VD-AV-2026-V2', category: 'Arbeitsvertrag' });

    const fileId = randomUUID();
    const { file, missing } = await generateFromWordTemplate(
      sql,
      cfg,
      { templateId: av!.id, target: { type: 'employee', id: emp }, fileId, actorName: 'Ahmed' },
      't',
    );
    expect(missing).toEqual(['Mitarbeiter.Geburtsdatum']);
    expect(file.original_name).toMatch(/^Arbeitsvertrag-Reinigungskraft_\d{4}-\d{2}-\d{2}_Vorlage\.docx$/);
    const out = strFromU8(unzipSync(await readFile(filePath(cfg, file as FileRow)))['word/document.xml']!);
    expect(out).toContain('und Rosa Vorlage, Hauptstr. 1, geb. __________, ab 01.02.2025');
    const [link] =
      await sql`select category from app.file_links where file_id = ${fileId} and entity_type = 'employee'`;
    expect(link?.category).toBe('Arbeitsvertrag');
    // Kundenvorlage passt nicht zum Mitarbeiter
    const [kd] = await listWordTemplates(sql, 'kunde');
    await expect(
      generateFromWordTemplate(
        sql,
        cfg,
        { templateId: kd!.id, target: { type: 'employee', id: emp }, fileId: randomUUID(), actorName: 'A' },
        't',
      ),
    ).rejects.toThrow(/für Kunde/);
  });
});
