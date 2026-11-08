import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { dateFromText, importProspects, listProspects, statusFromText } from './prospects.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe('Akquise-Hilfen', () => {
  it('Status und Datum aus Text', () => {
    expect(statusFromText('Starkes Interesse')).toBe('interesse_stark');
    expect(statusFromText('')).toBe('erstkontakt');
    expect(statusFromText('kalt')).toBe('erstkontakt');
    expect(statusFromText('irgendwas')).toBeNull();
    expect(dateFromText('09.11.2026')).toBe('2026-11-09');
    expect(dateFromText('2026-11-09')).toBe('2026-11-09');
    expect(dateFromText('46335')).toBe('2026-11-09');
    expect(dateFromText('')).toBeNull();
    expect(dateFromText('morgen')).toBeUndefined();
  });
});

describe.skipIf(!available)('Akquise importieren', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('legt an, erkennt Dubletten, aktualisiert nur auf Wunsch, meldet Fehlerzeilen', async () => {
    const rows = [
      ['Firma', 'Ansprechpartner', 'Ort', 'Status', 'Wiedervorlage', 'Notiz', 'Aktivitäten', 'Farbe'],
      [
        'Muster GmbH',
        'Frau Muster',
        'München',
        'Leichtes Interesse',
        '10.11.2026',
        'Anfrage per Telefon',
        '0',
        'rot',
      ],
      ['Muster GmbH', '', 'München', '', '', '', '', ''],
      ['', 'ohne Firma', '', '', '', '', '', ''],
      ['Falsch AG', '', 'Augsburg', 'vielleicht', '', '', '', ''],
      ['Neu KG', '', '', '', '', '', '', ''],
    ];
    const r = await importProspects(sql, rows, { update: false }, 't');
    expect(r).toMatchObject({ created: 2, updated: 0, skipped: 1 });
    expect(r.errors.map((e) => e.row)).toEqual([4, 5]);
    expect(r.unknownColumns).toEqual(['Farbe']);
    const muster = (await listProspects(sql)).find((p) => p.company === 'Muster GmbH')!;
    expect(muster).toMatchObject({
      status: 'interesse_leicht',
      followup_on: '2026-11-10',
      activity_count: 1,
    });

    // erneut → nichts doppelt
    const again = await importProspects(sql, rows, { update: false }, 't');
    expect(again).toMatchObject({ created: 0, skipped: 3 });
    expect((await listProspects(sql)).filter((p) => p.company === 'Muster GmbH')).toHaveLength(1);

    // aktualisieren: Telefon kommt dazu, leere Zellen ändern nichts
    const up = await importProspects(
      sql,
      [
        ['Firma', 'Ort', 'Telefon', 'Ansprechpartner'],
        ['muster gmbh', 'münchen', '089 1234', ''],
      ],
      { update: true },
      't',
    );
    expect(up).toMatchObject({ created: 0, updated: 1 });
    const m2 = (await listProspects(sql)).find(
      (p) => p.company === 'muster gmbh' || p.company === 'Muster GmbH',
    )!;
    expect(m2).toMatchObject({ phone: '089 1234', contact: 'Frau Muster', status: 'interesse_leicht' });
  });
});
