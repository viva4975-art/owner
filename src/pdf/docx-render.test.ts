import { describe, expect, it } from 'vitest';
import { parseDocx } from './docx-render.js';

const doc = (body: string) => `<w:document xmlns:w="w" xmlns:w14="w14"><w:body>${body}</w:body></w:document>`;
const box = (checked: string, glyph: string) =>
  `<w:sdt><w:sdtPr><w14:checkbox><w14:checked w:val="${checked}"/></w14:checkbox></w:sdtPr>` +
  `<w:sdtContent><w:r><w:t>${glyph}</w:t></w:r></w:sdtContent></w:sdt>`;
const text = (b: ReturnType<typeof parseDocx>[number]) =>
  b.kind === 'p' ? b.runs.map((r) => r.text).join('') : '';

describe('parseDocx', () => {
  it('zeichnet Kontrollkästchen nach dem Zustand, nicht nach dem Zeichen darin', () => {
    const [p] = parseDocx(
      doc(`<w:p>${box('1', '☐')}<w:r><w:t xml:space="preserve">  keine</w:t></w:r></w:p>`),
    );
    expect(text(p!)).toBe('☒  keine');
    const [q] = parseDocx(doc(`<w:p>${box('0', '☒')}<w:r><w:t>x</w:t></w:r></w:p>`));
    expect(text(q!)).toBe('☐x');
  });

  it('gibt „Ort, Datum“-Zeilen Abstand nach oben', () => {
    const [a, b] = parseDocx(
      doc('<w:p><w:r><w:t>München, den 01.11.2026</w:t></w:r></w:p><w:p><w:r><w:t>Text</w:t></w:r></w:p>'),
    );
    expect(a!.kind === 'p' && a!.before).toBeGreaterThan(20);
    expect(b!.kind === 'p' && b!.before).toBe(0);
  });

  it('liest Zellrahmen oben als Unterschriftslinie (gut sichtbar)', () => {
    const cell = (t: string) =>
      `<w:tc><w:tcPr><w:tcBorders><w:top w:val="single" w:sz="4" w:color="D8D5D8"/></w:tcBorders></w:tcPr>` +
      `<w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
    const [t] = parseDocx(
      doc(
        `<w:tbl><w:tblGrid><w:gridCol w:w="4270"/><w:gridCol w:w="4270"/></w:tblGrid><w:tr>${cell('Stempel und Unterschrift Arbeitgeber')}${cell('Bemerkung')}</w:tr></w:tbl>`,
      ),
    );
    if (t!.kind !== 'tbl') throw new Error('Tabelle erwartet');
    const [sign, other] = t!.rows[0]!.cells;
    expect(sign!.top![0]).toBeLessThan(0.5);
    expect(other!.top![0]).toBeGreaterThan(0.8);
    expect(sign!.bottom).toBeNull();
  });
});
