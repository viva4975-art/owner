import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { type FileRow, filePath } from './uploads.js';
import {
  generateFromWordTemplate,
  importWordTemplates,
  listWordTemplates,
  templateValues,
} from './word-templates.js';

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
    expect(link?.category).toBe('Entwurf (aus Vorlage)'); // zählt erst als Scan der unterschriebenen Fassung
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

  it('Neue Fassung ersetzt die alte; Daten auf der Ausfüll-Seite wählbar; Word-Datumsfeld wird fest', async () => {
    const cfg = { dir, maxBytes: 10_000_000 };
    const body =
      '<w:p><w:r><w:t>Gilt ab ${Vertrag.Beginn}, neu ${Neu.Wochenstunden} Std., München, den ${Dokument.Unterschriftsdatum}</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">Datum: </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> DATE \\@ "dd.MM.yyyy" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>13.08.2026</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
    const v3 = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'word/document.xml': strToU8(`<w:document><w:body>${body}</w:body></w:document>`),
    });
    const r = await importWordTemplates(
      sql,
      cfg,
      [{ name: 'VD-AV-2026-V3_Arbeitsvertrag-Reinigungskraft.docx', data: v3 }],
      't',
    );
    expect(r.created).toEqual(['Arbeitsvertrag Reinigungskraft']);
    expect(r.replaced).toEqual(['Arbeitsvertrag Reinigungskraft']);
    const active = await listWordTemplates(sql, 'mitarbeiter');
    expect(active.map((t) => t.code)).toEqual(['VD-AV-2026-V3']);
    const { file } = await generateFromWordTemplate(
      sql,
      cfg,
      {
        templateId: active[0]!.id,
        target: { type: 'employee', id: emp },
        fileId: randomUUID(),
        actorName: 'Ahmed',
        overrides: {
          'Vertrag.Beginn': '2026-11-01',
          'Neu.Wochenstunden': '30',
          'Dokument.Unterschriftsdatum': '2026-10-20',
          'Dokument.Datum': '2026-10-19',
        },
      },
      't',
    );
    const out = strFromU8(unzipSync(await readFile(filePath(cfg, file as FileRow)))['word/document.xml']!);
    expect(out).toContain('Gilt ab 01.11.2026, neu 30 Std., München, den 20.10.2026');
    expect(out).toContain('19.10.2026');
    expect(out).not.toContain('fldChar');
    expect(out).not.toContain('13.08.2026');
  });

  it('Paket V5 deaktiviert entfallene Vorlagen (Befristung, Anwesenheitsliste)', async () => {
    const cfg = { dir, maxBytes: 10_000_000 };
    await importWordTemplates(
      sql,
      cfg,
      [{ name: 'VD-VB-2026-V4_Verlaengerung-Befristung.docx', data: docx('Befristung ${Vertrag.Ende}') }],
      't',
    );
    expect((await listWordTemplates(sql, undefined)).some((t) => t.code === 'VD-VB-2026-V4')).toBe(true);
    const r = await importWordTemplates(
      sql,
      cfg,
      [{ name: 'VD-UA-2026-V5_Urlaubsantrag.docx', data: docx('Urlaub ${Mitarbeiter.Nachname}') }],
      't',
    );
    expect(r.replaced).toContain('Verlängerung Befristung');
    expect((await listWordTemplates(sql, undefined)).some((t) => t.code === 'VD-VB-2026-V4')).toBe(false);
  });

  it('Briefanrede Kunde/Mitarbeiter und AÜ-Erlaubnis aus den Firmendaten', async () => {
    const cust = randomUUID();
    await sql`insert into app.customers (id, customer_no, name, street, postal_code, city, contact_name)
              values (${cust}, '29977', 'Anrede GmbH', 'Weg 1', '80331', 'München', 'Anna Berger')`;
    await sql`insert into app.contacts (customer_id, salutation, first_name, last_name)
              values (${cust}, 'Frau', 'Anna', 'Berger')`;
    await sql`update app.employees set salutation = 'Herr' where id = ${emp}`;
    await sql`update app.company set aue_permit_date = '2025-03-01', aue_permit_file_no = 'AÜ 123',
                     aue_permit_unlimited = false, aue_permit_valid_until = '2026-02-28' where id = 1`;
    const k = await templateValues(
      sql,
      { type: 'customer', id: cust },
      { actorName: 't', fileId: randomUUID() },
    );
    expect(k.values['Kunde.Briefanrede']).toBe('Sehr geehrte Frau Berger');
    expect(k.values['Firma.AÜ_Erlaubnis_Datum']).toBe('01.03.2025');
    expect(k.values['Firma.AÜ_Erlaubnis_Aktenzeichen']).toBe('AÜ 123');
    expect(k.values['Firma.AÜ_Erlaubnis_Behörde']).toBe('die Bundesagentur für Arbeit');
    expect(k.values['Firma.AÜ_Erlaubnis_gültig_bis']).toBe('28.02.2026');
    const m = await templateValues(
      sql,
      { type: 'employee', id: emp },
      {
        actorName: 't',
        fileId: randomUUID(),
      },
    );
    expect(m.values['Mitarbeiter.Briefanrede']).toBe('Sehr geehrter Herr Vorlage');
  });
});
