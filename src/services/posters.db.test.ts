import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { DEFAULT_POSTERS, fillPlaceholders, mergePosters } from '../pdf/posters.js';
import { DEMO } from './seed.js';
import {
  buildPostersPdf,
  getFolderDefaults,
  getPosters,
  saveFolderDefaults,
  saveFolderInfo,
  savePosters,
} from './site-folder.js';
import { dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

describe('Aushang-Texte', () => {
  it('Platzhalter füllen, leere Zeilen weglassen', () => {
    const v = { hautschutz: 'Stokoderm', putzraum: '' };
    expect(fillPlaceholders('Hautschutz auftragen.\n{hautschutz}', v)).toBe(
      'Hautschutz auftragen.\nStokoderm',
    );
    expect(fillPlaceholders('Hände eincremen.\n{hautpflege}', v)).toBe('Hände eincremen.');
    expect(fillPlaceholders('Putzraum: {putzraum}', v)).toBe('');
    // langer Satz bleibt, nur der leere Platzhalter verschwindet
    expect(fillPlaceholders('Vorsorge beim Betriebsarzt (Termin über das Büro): {betriebsarzt}', v)).toBe(
      'Vorsorge beim Betriebsarzt (Termin über das Büro)',
    );
  });

  it('Änderungen überschreiben die Vorgabe, eigene Aushänge kommen dazu, neue Vorgaben erscheinen', () => {
    const list = mergePosters([
      {
        key: 'wagen',
        title: 'Wagen putzen',
        active: false,
        steps: [{ icon: 'cart', title: 'Nur ein Schritt', text: '' }],
      },
      {
        key: 'eigen-1',
        title: 'Glasreinigung',
        steps: [],
        dos: [],
        donts: [],
        intro: '',
        note: '',
        icon: 'spray',
        active: true,
      },
    ]);
    expect(list).toHaveLength(DEFAULT_POSTERS.length + 1);
    const w = list.find((p) => p.key === 'wagen')!;
    expect(w.title).toBe('Wagen putzen');
    expect(w.active).toBe(false);
    expect(w.steps).toHaveLength(1);
    expect(w.builtin).toBe(true);
    expect(list.at(-1)).toMatchObject({ key: 'eigen-1', builtin: false, kind: 'text' });
  });
});

const ok = await dbAvailable();
describe.skipIf(!ok)('Aushänge als PDF', () => {
  let sql: Sql;
  let deps: Deps;
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  it(
    'alle eingeschalteten Aushänge, je Seite einer, mit Objektdaten; Texte änderbar',
    { timeout: 30_000 },
    async () => {
      await saveFolderInfo(
        sql,
        DEMO.siteSchool,
        { ersthelfer: 'Erna Erst', krankenhaus: 'Klinikum Test' },
        'test',
      );
      let r = await buildPostersPdf(deps, DEMO.siteSchool);
      let text = (await extractText(await getDocumentProxy(r.pdf), { mergePages: false })).text;
      expect(text).toHaveLength(DEFAULT_POSTERS.length);
      expect(text[0]).toContain('112');
      expect(text[0]).toContain('Erna Erst');
      expect(text[0]).toContain('Klinikum Test');
      expect(text.join('\n')).toContain('Reinigungswagen pflegen und bestücken');

      // Text ändern, Aushang ausschalten – andere Objektordner-Angaben bleiben erhalten
      await saveFolderDefaults(sql, { betriebsarzt: 'Dr. Test' }, 'test');
      const list = await getPosters(sql);
      await savePosters(
        sql,
        list.map((p) =>
          p.key === 'wagen'
            ? {
                ...p,
                steps: [...p.steps, { icon: 'check' as const, title: 'Neuer Schritt XYZ', text: 'Test' }],
              }
            : p.key === 'waesche'
              ? { ...p, active: false }
              : p,
        ),
        'test',
      );
      await saveFolderDefaults(sql, { betriebsarzt: 'Dr. Test 2' }, 'test');
      expect((await getFolderDefaults(sql)).aushaenge).toBeTruthy();
      r = await buildPostersPdf(deps, DEMO.siteSchool);
      text = (await extractText(await getDocumentProxy(r.pdf), { mergePages: false })).text;
      expect(text).toHaveLength(DEFAULT_POSTERS.length - 1);
      expect(text.join('\n')).toContain('Neuer Schritt XYZ');
      expect(text.join('\n')).not.toContain('Mopps & Tücher waschen');
      // einzelner (auch ausgeschalteter) Aushang als Vorschau
      r = await buildPostersPdf(deps, DEMO.siteSchool, 'waesche');
      text = (await extractText(await getDocumentProxy(r.pdf), { mergePages: false })).text;
      expect(text).toHaveLength(1);
    },
  );
});
