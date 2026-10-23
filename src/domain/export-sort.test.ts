import { describe, expect, it } from 'vitest';
import { exportSortStore, sortByRequest } from './export-sort.js';

describe('Export-Sortierung', () => {
  const rows = [
    ['B', '1.200,00 €'],
    ['A', '30,00 €'],
    ['C', '400,00 €'],
  ];
  const text = (r: string[], i: number) => r[i]!;
  it('ohne Wunsch unverändert', () => {
    expect(sortByRequest(['Name', 'Betrag'], rows, text)).toEqual(rows);
  });
  it('sortiert nach Spaltenname, Beträge als Zahl, absteigend', () => {
    const out = exportSortStore.run({ label: 'Betrag', dir: 'desc' }, () =>
      sortByRequest(['Name', 'Betrag'], rows, text),
    );
    expect(out.map((r) => r[0])).toEqual(['B', 'C', 'A']);
  });
  it('unbekannte Spalte → unverändert', () => {
    const out = exportSortStore.run({ label: 'Datum', dir: 'asc' }, () =>
      sortByRequest(['Name', 'Betrag'], rows, text),
    );
    expect(out).toEqual(rows);
  });
});
