import { describe, expect, it } from 'vitest';
import { parseDocx, renderDocx, signatureGroups } from './docx-render.js';
import { FormDoc } from './form-doc.js';

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

describe('Unterschriften nicht allein auf einer Seite (Ahmed 06.11.)', () => {
  const p = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
  const sig =
    '<w:tbl><w:tblGrid><w:gridCol w:w="4270"/><w:gridCol w:w="4270"/></w:tblGrid><w:tr>' +
    ['Unterschrift Arbeitgeber', 'Unterschrift Arbeitnehmer']
      .map(
        (t) =>
          `<w:tc><w:tcPr><w:tcBorders><w:top w:val="single" w:sz="4" w:color="000000"/></w:tcBorders></w:tcPr>${p(t)}</w:tc>`,
      )
      .join('') +
    '</w:tr></w:tbl>';

  it('nimmt die zwei Absätze vor dem Unterschriftsbereich mit', () => {
    const blocks = parseDocx(doc(p('Text 1') + p('Text 2') + p('Schluss A') + p('Schluss B') + sig));
    expect([...signatureGroups(blocks)]).toEqual([[2, 4]]);
  });

  it('setzt Unterschriften nie allein auf die letzte Seite', async () => {
    let wrapped = 0;
    for (let n = 30; n < 60; n++) {
      const body =
        Array.from({ length: n }, (_, i) => p(`Absatz ${i + 1}`)).join('') +
        p('Schluss A') +
        p('Schluss B') +
        sig;
      const d = await FormDoc.create({ title: 't', sideRef: 't', date: '2026-11-06', author: 't' });
      const seen: Record<string, number> = {};
      const orig = d.text.bind(d);
      d.text = ((
        t: string,
        ...rest: Parameters<FormDoc['text']> extends [string, ...infer R] ? R : never
      ) => {
        seen[t] = d.pdf.getPageCount();
        return orig(t, ...rest);
      }) as FormDoc['text'];
      renderDocx(d, parseDocx(doc(body)));
      expect(seen['Unterschrift'], `n=${n}`).toBe(seen['B']);
      if ((seen['Unterschrift'] ?? 0) > 1) wrapped++;
    }
    expect(wrapped).toBeGreaterThan(0);
  });
});
