import { strToU8, zipSync } from 'fflate';
import { sampleXlsx } from './sample-xlsx.js';
import { describe, expect, it } from 'vitest';
import { areaOf, parseInterval } from '../../services/room-import.js';
import { SheetError, readSheet } from './sheet.js';

describe('Tabellen einlesen', () => {
  it('xlsx: erstes Blatt über Beziehungen, Texte, Zahlen wie gespeichert, Inline-Text, Rich-Text, Lücken', () => {
    const { kind, rows } = readSheet(sampleXlsx());
    expect(kind).toBe('xlsx');
    expect(rows[0]).toEqual(['Raumbuch Grundschule']);
    expect(rows[1]).toEqual(['Etage', 'Raum-Nr.', 'Raum', 'Raumart', 'Fläche m²', 'Intervall']);
    expect(rows[2]).toEqual(['EG', '1.01', 'Sekretariat', 'Büro', '24.5', '5x wöchentlich']);
    expect(rows[3]).toEqual(['EG', '1.02', 'WC & Dusche', '', '8', 'täglich']);
  });

  it('CSV mit Semikolon und Windows-1252', () => {
    const bytes = new Uint8Array([
      ...Buffer.from('Raum;Fl'),
      0xe4,
      ...Buffer.from('che\nB'),
      0xfc,
      ...Buffer.from('ro;12,5\n'),
    ]);
    expect(readSheet(bytes).rows).toEqual([
      ['Raum', 'Fläche'],
      ['Büro', '12,5'],
    ]);
  });

  it('altes .xls und DOCTYPE werden abgelehnt', () => {
    expect(() => readSheet(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toThrow(SheetError);
    const evil = zipSync({
      'xl/worksheets/sheet1.xml': strToU8(
        '<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><worksheet/>',
      ),
    });
    expect(() => readSheet(evil)).toThrow(/DOCTYPE/);
  });
});

describe('Reinigungsintervall', () => {
  it.each([
    ['5x wöchentlich', 260],
    ['5 x pro Woche', 260],
    ['2x/Woche', 104],
    ['wöchentlich', 52],
    ['täglich', 260],
    ['arbeitstäglich', 260],
    ['Mo-So', 365],
    ['14-tägig', 26],
    ['alle 2 Wochen', 26],
    ['1x Monat', 12],
    ['monatlich', 12],
    ['quartalsweise', 4],
    ['halbjährlich', 2],
    ['2x jährlich', 2],
    ['5', 260],
    ['260', 260],
    ['', null],
    ['nach Bedarf', null],
  ])('%s → %s', (t, n) => {
    expect(parseInterval(t)).toBe(n);
  });
  it('„täglich“ nach Wahl Mo–Fr / Mo–Sa / Mo–So, eindeutige Angaben bleiben', () => {
    expect(parseInterval('täglich', 312)).toBe(312);
    expect(parseInterval('tgl.', 365)).toBe(365);
    expect(parseInterval('arbeitstäglich', 365)).toBe(260);
    expect(parseInterval('Mo–Sa', 260)).toBe(312);
    expect(parseInterval('Mo – So', 260)).toBe(365);
  });
});

describe('Fläche', () => {
  it.each([
    ['24,5', 'csv', 2450n],
    ['1.234,56', 'csv', 123456n],
    ['24.5', 'xlsx', 2450n],
    ['0.285', 'xlsx', 29n],
    ['12,344 m²', 'csv', 1234n],
    ['0', 'csv', null],
    ['abc', 'csv', null],
  ] as const)('%s (%s) → %s', (v, k, c) => {
    expect(areaOf(v, k)).toBe(c);
  });
});
