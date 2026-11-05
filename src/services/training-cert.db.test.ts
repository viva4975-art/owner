import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { RATING_TOPICS, TRAINING_MODULES, trainingCertPdf } from './training-cert.js';

const ok = await dbAvailable();

describe.skipIf(!ok)('Schulungsnachweis Objektleitung', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Module, Ergebnis, interne Beurteilung, Unterschrift Gebäudereinigermeister', async () => {
    const emp = '00000000-0000-4000-8000-00000000e001';
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, salutation, entry_date)
              values (${emp}, '8802', 'Olga', 'Leitung', 'Frau', '2025-01-01')`;
    await sql`update app.company set managing_director = 'Ahmed Chomontek' where id = 1`;
    const { pdf, name } = await trainingCertPdf(sql, emp, {
      from: '2026-11-03',
      to: '2026-11-04',
      hours: '16',
      place: '',
      trainer: '',
      trainerTitle: '',
      modules: TRAINING_MODULES.map((m) => m.key),
      extra: 'Winterdienst',
      result: 'mit gutem Erfolg teilgenommen',
      ratings: { [RATING_TOPICS[0]]: 'sehr gut', [RATING_TOPICS[2]]: 'gut' },
      remark: 'Übernimmt eigenständig mehrere Objekte.',
      date: '2026-11-05',
    });
    expect(name).toMatch(/^Schulungsnachweis_Objektleitung_8802_/);
    const all = (await extractText(await getDocumentProxy(pdf.slice()), { mergePages: true })).text.replace(
      /\s+/g,
      ' ',
    );
    expect(all).toContain('Frau Leitung hat an der internen Schulung');
    expect(all).toContain('mit gutem Erfolg teilgenommen');
    expect(all).toContain('Ahmed Chomontek');
    expect(all).toContain('Gebäudereinigermeister');
    expect(all).toContain('Winterdienst');
    expect(all).toContain('sehr gut');
    if (process.env.SN_OUT) (await import('node:fs/promises')).writeFile(process.env.SN_OUT, pdf);
  });
});
