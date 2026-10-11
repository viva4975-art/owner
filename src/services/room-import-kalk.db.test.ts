import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { writeXlsx } from '../domain/sheet/xlsx-write.js';
import { analyzeRooms, applyRooms, guessRoomType, parseInterval } from './room-import.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe('Turnus-Kürzel und Raumarten', () => {
  it('W/M/J-Kürzel, 0 = keine Reinigung', () => {
    expect(parseInterval('W5')).toBe(260);
    expect(parseInterval('W2 Di & Do.')).toBe(104);
    expect(parseInterval('M1')).toBe(12);
    expect(parseInterval('J2')).toBe(2);
    expect(parseInterval('0')).toBe(0);
    expect(parseInterval('keine Reinigung (macht HM)')).toBe(0);
  });
  it('Raumart → Nutzungsart über Stichwörter', () => {
    expect(guessRoomType('WC Damen 01')).toBe('Sanitär / WC');
    expect(guessRoomType('Umkleideraum, Kabine 5')).toBe('Umkleide / Dusche');
    expect(guessRoomType('Treppenhaus 02')).toBe('Flur / Treppenhaus');
    expect(guessRoomType('Lehrerzimmer')).toBe('Büro');
    expect(guessRoomType('Hausmeisterraum')).toBe('Lager / Technik');
    expect(guessRoomType('xyz')).toBeNull();
  });
});

describe.skipIf(!available)('Raumbuch aus einer Ausschreibungs-Kalkulation (mehrere Blätter)', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('findet das Blatt, Reinigungstage vor Turnus, Stunden je Jahr, Stundenvorgabe', async () => {
    const xlsx = writeXlsx([
      { name: 'Inhalt', header: ['Vergabe Unterhaltsreinigung'], rows: [['Anhang Teil C']] },
      {
        name: 'Kalkulationsbasis',
        header: ['Index', 'Raumart', 'Turnus', 'qm-Leistung pro Stunde'],
        rows: [['A44', 'Klassenzimmer', 'W1', 190]],
      },
      {
        name: 'PB EAF UR Los 1',
        title: ['Preisblatt Einzelraumkalkulation', 'Aufmaß/Flächenverzeichnis'],
        header: [
          'Gebäude',
          'Ebene',
          'RaumNr',
          'Raumart',
          'Turnus',
          'Tageskraft',
          'Bodenart',
          'Fläche_qm',
          'Reinigungs-gruppe',
          'Reinigungs-tageJahr',
          'qm Leistung pro Stunde',
          'StundenJahr',
        ],
        rows: [
          ['Grundschule', 'EG', 'A 1.01', 'Klasse 1a', 'W5', null, 'Linoleum', 60, 'A', 216, 190, 68.21],
          [
            'Grundschule',
            'EG',
            'A 1.02',
            'WC Damen',
            'W5',
            'Tageskraft (5x)',
            'Fliesen',
            5.5,
            'TKC',
            216,
            null,
            null,
          ],
          [
            'Grundschule',
            'UG',
            'A 0.03',
            'Hausmeisterraum',
            '0',
            null,
            'Anstrich',
            42.98,
            'H',
            0,
            null,
            null,
          ],
          ['Sportzentrum', 'EG', 'keine NR', 'WC', 'W6', null, 'Fliesen', 1.81, 'C', 291, 67, 7.86],
          ['Sportzentrum', 'EG', 'keine NR', 'WC', 'W6', null, 'Fliesen', 1.9, 'C', 291, 67, 8.25],
          ['Sportzentrum', 'EG', null, 'Lager', 'J2', null, 'Stein', 10, 'H', 2, 450, 0.04],
        ],
      },
    ]);
    const a = await analyzeRooms(sql, DEMO.siteSchool, xlsx);
    expect(a.sheetName).toBe('PB EAF UR Los 1');
    expect(a.rows.every((r) => !r.errors.length)).toBe(true);
    const by = (n: string) => a.rows.find((r) => r.name === n)!;
    expect([by('Klasse 1a').visits, by('Klasse 1a').typeName, by('Klasse 1a').turnus]).toEqual([
      216,
      'Klassenzimmer',
      'W5',
    ]);
    expect(by('WC Damen').typeName).toBe('Sanitär / WC');
    expect(by('WC Damen').notes).toBe('Tageskraft: Tageskraft (5x)');
    expect(by('Hausmeisterraum').visits).toBe(0);
    expect([by('WC').roomNo, by('WC (2)').roomNo]).toEqual([null, null]);
    expect(a.newTypes).toEqual([]);
    expect(a.hoursYear).toBeCloseTo(68.21 + 0 + 7.86 + 8.25 + 0.04, 6);
    const r = await applyRooms(sql, DEMO.siteSchool, 'kalk', a, { update: false, hourTarget: true }, 't');
    expect(r.created).toBe(6);
    const [t] = await sql<{ mode: string; year_minutes: number }[]>`
      select mode, year_minutes from app.site_hour_targets where site_id = ${DEMO.siteSchool}`;
    expect(t).toEqual({ mode: 'jahr', year_minutes: Math.round((68.21 + 7.86 + 8.25 + 0.04) * 60) });
    const [h] = await sql<{ visits_per_year: number; turnus: string }[]>`
      select visits_per_year, turnus from app.rooms where site_id = ${DEMO.siteSchool} and name = 'Hausmeisterraum'`;
    expect(h).toEqual({ visits_per_year: 0, turnus: '0' });
    // zweimal übernehmen legt nichts doppelt an
    expect((await applyRooms(sql, DEMO.siteSchool, 'kalk', a, { update: false }, 't')).created).toBe(0);
  }, 30_000);
});
