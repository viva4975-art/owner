import { describe, expect, it } from 'vitest';
import { readSheet } from './sheet.js';
import { writeXlsx } from './xlsx-write.js';

describe('writeXlsx', () => {
  it('schreibt lesbares Excel, Texte bleiben Text (keine Formeln)', () => {
    const bytes = writeXlsx([
      {
        name: 'Durchschnitt: 2025',
        title: ['Ausfallzeiten 2025'],
        header: ['Name', 'Tage', 'Quote'],
        rows: [
          ['=SUMME(A1:A9)', 5, { n: 0.123, fmt: 'pct' }],
          ['Müller & Söhne <GmbH>', { n: 2.5, fmt: 'd1' }, null],
        ],
        footer: [[{ b: 'Gesamt' }, { n: 7.5, fmt: 'd1' }, { n: 0.1, fmt: 'pct' }]],
        widths: [30, 10, 10],
      },
    ]);
    const rows = readSheet(bytes).rows;
    const head = rows.findIndex((r) => r[0] === 'Name');
    expect(rows[0]![0]).toBe('Ausfallzeiten 2025');
    expect(rows[head + 1]![0]).toBe('=SUMME(A1:A9)');
    expect(rows[head + 1]![1]).toBe('5');
    expect(rows[head + 2]![0]).toBe('Müller & Söhne <GmbH>');
    expect(rows[head + 3]![0]).toBe('Gesamt');
    // gleicher Inhalt → gleiche Datei
    expect(
      Buffer.from(writeXlsx([{ name: 'A', header: ['x'], rows: [[1]] }])).equals(
        Buffer.from(writeXlsx([{ name: 'A', header: ['x'], rows: [[1]] }])),
      ),
    ).toBe(true);
  });
});
