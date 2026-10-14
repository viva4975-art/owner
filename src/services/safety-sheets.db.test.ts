import { PDFDocument } from '@cantoo/pdf-lib';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { DEMO } from './seed.js';
import {
  listSafetySheets,
  removeSafetySheet,
  safetySheetsPdf,
  saveSafetySheet,
  sheetOutdated,
} from './safety-sheets.js';
import { buildFolderPdf, buildFolderZip, folderFacts } from './site-folder.js';
import { dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const ok = await dbAvailable();
const pdf = async (pages: number) => {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([595, 842]);
  return d.save();
};

describe.skipIf(!ok)('Sicherheitsdatenblätter im Objektordner', () => {
  let sql: Sql;
  let deps: Deps;
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('hochladen, neue Fassung ersetzt alte, im PDF und ZIP des Objektordners, entfernen', async () => {
    expect(
      (await folderFacts(sql, DEMO.siteSchool)).missing.some((m) => /Sicherheitsdatenblätter/.test(m.label)),
    ).toBe(true);
    await expect(
      saveSafetySheet(
        deps,
        { product: 'X', bytes: new TextEncoder().encode('kein pdf'), fileName: 'a.txt' },
        't',
      ),
    ).rejects.toThrow(/PDF/);
    await saveSafetySheet(
      deps,
      { product: 'Unterhaltsreiniger', issuedOn: '2020-01-01', bytes: await pdf(1), fileName: 'u.pdf' },
      't',
    );
    await saveSafetySheet(
      deps,
      {
        product: 'unterhaltsreiniger',
        manufacturer: 'mstore',
        issuedOn: '2026-03-01',
        bytes: await pdf(2),
        fileName: 'u2.pdf',
      },
      't',
    );
    const san = await saveSafetySheet(
      deps,
      { product: 'Sanitärreiniger', bytes: await pdf(3), fileName: 's.pdf' },
      't',
    );
    const list = await listSafetySheets(sql);
    expect(list.map((s) => s.product)).toEqual(['Sanitärreiniger', 'unterhaltsreiniger']);
    expect(list[1]!.manufacturer).toBe('mstore');
    expect(sheetOutdated('2020-01-01', '2026-10-14')).toBe(true);
    expect(sheetOutdated('2026-03-01', '2026-10-14')).toBe(false);

    const all = await PDFDocument.load((await safetySheetsPdf(deps))!);
    expect(all.getPageCount()).toBe(5);
    const zip = unzipSync((await buildFolderZip(deps, DEMO.siteSchool)).zip);
    expect(Object.keys(zip).filter((n) => n.startsWith('07_Sicherheitsdatenblaetter/'))).toHaveLength(2);
    const folder = await PDFDocument.load((await buildFolderPdf(deps, DEMO.siteSchool)).pdf);
    expect(folder.getPageCount()).toBeGreaterThan(5);
    expect(
      (await folderFacts(sql, DEMO.siteSchool)).missing.some((m) => /Sicherheitsdatenblätter/.test(m.label)),
    ).toBe(false);

    await removeSafetySheet(sql, san, 't');
    expect(await listSafetySheets(sql)).toHaveLength(1);
  });
});
