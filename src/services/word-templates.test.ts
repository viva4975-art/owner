import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { categoryFor, fillDocx, fillXml, nameFromFile, placeholdersOf } from './word-templates.js';

const para = (...runs: string[]) =>
  `<w:p><w:pPr/>${runs.map((r, i) => `<w:r><w:rPr>${i === 0 ? '<w:b/>' : ''}</w:rPr><w:t>${r}</w:t></w:r>`).join('')}</w:p>`;

describe('Word-Vorlagen: Platzhalter', () => {
  it('ersetzt auch über mehrere Läufe zerteilte Platzhalter und behält die Formatierung', () => {
    const missing = new Set<string>();
    const xml = para('Sehr geehrte/r ${Mitar', 'beiter.Vorname} ${Mitarbeiter.Nachname}, ', 'Nr. ${X.Y}');
    const out = fillXml(
      xml,
      (k) => ({ 'Mitarbeiter.Vorname': 'Ana', 'Mitarbeiter.Nachname': 'Ö & Co' })[k] ?? null,
      missing,
    );
    const text = out.replace(/<[^>]+>/g, '');
    expect(text).toBe('Sehr geehrte/r Ana Ö &amp; Co, Nr. __________');
    expect([...missing]).toEqual(['X.Y']);
    expect(out).toContain('<w:b/>'); // Formatierung bleibt
  });

  it('füllt eine .docx (Dokument + Kopfzeile) und listet Platzhalter', () => {
    const docx = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'word/document.xml': strToU8(
        `<w:document><w:body>${para('${Mitarbeiter.Personalnummer}')}</w:body></w:document>`,
      ),
      'word/header1.xml': strToU8(`<w:hdr>${para('${Dokument.Datum}')}</w:hdr>`),
    });
    expect(placeholdersOf(docx)).toEqual(['Dokument.Datum', 'Mitarbeiter.Personalnummer']);
    const { data, missing } = fillDocx(docx, (k) =>
      k === 'Mitarbeiter.Personalnummer' ? '1004' : '07.10.2026',
    );
    const files = unzipSync(data);
    expect(strFromU8(files['word/document.xml']!)).toContain('>1004<');
    expect(strFromU8(files['word/header1.xml']!)).toContain('>07.10.2026<');
    expect(missing).toEqual([]);
  });

  it('Name und Kategorie aus dem Dateinamen', () => {
    expect(nameFromFile('01_Vorlagen_Mitarbeiter/VD-AV-2026-V2_Arbeitsvertrag-Reinigungskraft.docx')).toEqual(
      {
        code: 'VD-AV-2026-V2',
        name: 'Arbeitsvertrag Reinigungskraft',
      },
    );
    expect(nameFromFile('VD-KUE-FG-2026-V2_Kuendigung-fristgerecht.docx').name).toBe(
      'Kündigung fristgerecht',
    );
    expect(categoryFor('VD-KUE-FG-2026-V2', 'Kündigung fristgerecht', 'mitarbeiter')).toBe('Beendigung');
    expect(categoryFor('VD-ZV-Vorarbeiter-2026-V1', 'Vorarbeiter', 'mitarbeiter')).toBe('Vertragsänderung');
    expect(categoryFor('VD-NU-TK-2026-V2', 'Tankkarte', 'mitarbeiter')).toBe('Nutzungsüberlassung');
    expect(categoryFor('VD-AVMJ-2026-V2', 'Arbeitsvertrag Minijob', 'mitarbeiter')).toBe('Arbeitsvertrag');
  });
});
