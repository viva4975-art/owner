import { describe, expect, it } from 'vitest';
import { sortCsv } from './csv-sort.js';

describe('CSV-Export in Bildschirm-Sortierung', () => {
  const csv =
    '﻿Pers.-Nr.;Name;Stunden;Datum\r\n1002;Zeta;10,50;03.10.2026\r\n1010;"Alpha; ""A""\nzweite Zeile";2,00;01.10.2026\r\n1001;Müller;100,00;02.10.2026\r\nSumme;;112,50;\r\n';
  it('sortiert nach Zahl, Text und Datum, Summe bleibt unten, Zellen mit Umbruch bleiben ganz', () => {
    const byHours = sortCsv(csv, 'Stunden', 'desc').split('\r\n');
    expect(byHours[1]).toMatch(/^1001/);
    expect(byHours[3]).toMatch(/^1010/);
    expect(byHours[4]).toMatch(/^Summe/);
    const byName = sortCsv(csv, 'Name', 'asc');
    expect(byName.indexOf('Alpha')).toBeLessThan(byName.indexOf('Müller'));
    expect(byName).toContain('"Alpha; ""A""\nzweite Zeile"');
    expect(byName.startsWith('﻿')).toBe(true);
    const byDate = sortCsv(csv, 'Datum', 'asc').split('\r\n');
    expect(byDate[1]).toMatch(/^1010/);
    expect(sortCsv(csv, 'Pers.-Nr.', 'asc').split('\r\n')[1]).toMatch(/^1001/);
  });
  it('unbekannte Spalte → unverändert', () => {
    expect(sortCsv(csv, 'Gibt es nicht', 'asc')).toBe(csv);
  });
});
