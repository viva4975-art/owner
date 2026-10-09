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

  it('Deckblatt, Inhaltsverzeichnis, Vorlagen mit Objektdaten, Word-Quellen der PDF-Aushänge nicht doppelt', async () => {
    const notruf = docx(
      `<w:p><w:r><w:rPr><w:sz w:val="32"/></w:rPr><w:t>Notruf und Meldekette</w:t></w:r></w:p>` +
        `<w:tbl><w:tr>${tc('Ersthelfer im Objekt')}${tc('____________')}</w:tr>` +
        `<w:tr>${tc('Ansprechpartner Kunde')}${tc('____________')}</w:tr></w:tbl>` +
        `<w:p><w:r><w:t xml:space="preserve">München, den </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> DATE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>13.08.2026</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
    );
    const quelle = docx(`<w:p><w:r><w:t>Nur Word-Quelle</w:t></w:r></w:p>`);
    const pkg = zipSync({
      'Paket/01_Aushang-Putzraum/B_Objektbezogen-ausfuellen/VD-AH-03_Notruf.docx': notruf,
      'Paket/01_Aushang-Putzraum/C_Word-Quellen/VD-AH-04_Putzraum.docx': quelle,
    });
    await savePackage(deps, pkg, 'paket.zip', 'test');
    await saveFolderInfo(
      sql,
      DEMO.siteSchool,
      { ersthelfer: 'Erna Erst', ansprechpartner: 'Hausmeister Maier', ansprechpartner_tel: '089 111' },
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
    expect(all).not.toContain('Nur Word-Quelle');
    expect(all).toContain('Anwesenheitsliste');
  });
});
