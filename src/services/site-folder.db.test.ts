import { strToU8, zipSync } from 'fflate';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { DEMO } from './seed.js';
import { buildFolderPdf, saveFolderInfo, savePackage } from './site-folder.js';
import { dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const ok = await dbAvailable();
const tc = (t: string) => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
const docx = (body: string) =>
  zipSync({
    'word/document.xml': strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`,
    ),
  });

describe.skipIf(!ok)('Objektordner als ein PDF', () => {
  let sql: Sql;
  let deps: Deps;
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Deckblatt, Inhaltsverzeichnis, Vorlagen ausgefüllt, ohne Lücken, Unterschriften und Leerformulare', async () => {
    const notruf = docx(
      `<w:p><w:r><w:rPr><w:sz w:val="32"/></w:rPr><w:t>Notruf und Meldekette</w:t></w:r></w:p>` +
        `<w:tbl><w:tr>${tc('Ersthelfer im Objekt')}${tc('____________')}</w:tr>` +
        `<w:tr>${tc('Ansprechpartner Kunde')}${tc('____________')}</w:tr>` +
        `<w:tr>${tc('Nächstes Krankenhaus')}${tc('____________')}</w:tr>` +
        `<w:tr>${tc('Brandmelderzentrale')}${tc('____________')}</w:tr></w:tbl>` +
        `<w:tbl><w:tr>${tc('')}${tc('')}</w:tr><w:tr>${tc('Datum, Objektleitung')}${tc('Datum, Geschäftsführung')}</w:tr></w:tbl>` +
        `<w:p><w:r><w:t>6  Kenntnisnahme</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t xml:space="preserve">München, den </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> DATE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>13.08.2026</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
    );
    const quelle = docx(`<w:p><w:r><w:t>Aus der Word-Quelle</w:t></w:r></w:p>`);
    const pkg = zipSync({
      'Paket/01_Aushang-Putzraum/B_Objektbezogen-ausfuellen/VD-AH-03_Notruf.docx': notruf,
      'Paket/01_Aushang-Putzraum/C_Word-Quellen/VD-AH-04_Putzraum.docx': quelle,
      'Paket/03_Objektunterlagen/VD-FB-03_Reklamationsmeldung.docx': docx(
        `<w:p><w:r><w:t>Leeres Reklamationsformular</w:t></w:r></w:p>`,
      ),
    });
    await savePackage(deps, pkg, 'paket.zip', 'test');
    await saveFolderInfo(
      sql,
      DEMO.siteSchool,
      {
        ersthelfer: 'Erna Erst',
        ansprechpartner: 'Hausmeister Maier',
        ansprechpartner_tel: '089 111',
        krankenhaus: 'Klinikum Großhadern',
      },
      'test',
    );
    const r = await buildFolderPdf(deps, DEMO.siteSchool);
    expect(r.name).toMatch(/^Objektordner_.*\.pdf$/);
    const doc = await getDocumentProxy(r.pdf);
    const { text } = await extractText(doc, { mergePages: false });
    const all = text.join('\n');
    expect(text[0]).toContain('OBJEKTORDNER');
    expect(text[1]).toContain('Inhaltsverzeichnis');
    expect(text[1]).toContain('Notruf und Meldekette');
    expect(all).toContain('Erna Erst');
    expect(all).toContain('Hausmeister Maier, 089 111');
    expect(all).not.toContain('13.08.2026');
    expect(all).toContain('Aus der Word-Quelle');
    expect(all).toContain('Klinikum Großhadern');
    // ohne Angabe: Zeile fällt weg statt Linie zum Ausfüllen; Unterschriften, Kenntnisnahme, Leerformulare weg
    expect(all).not.toContain('Brandmelderzentrale');
    expect(all).not.toContain('___');
    expect(all).not.toContain('Datum, Objektleitung');
    expect(all).not.toContain('Kenntnisnahme');
    expect(all).not.toContain('Leeres Reklamationsformular');
    expect(all).not.toContain('Stundennachweis');
    expect(all).toContain('Anwesenheitsliste');
  });
});
