import { describe, expect, it } from 'vitest';
import { applyFormFields, defaultBlanks, defaultBoxes, formFieldsOf } from './word-form.js';

const box = (checked: boolean, attr = 'w:val') =>
  `<w:sdt><w:sdtPr><w14:checkbox><w14:checked ${attr}="${checked ? 1 : 0}"/><w14:checkedState w:val="2612"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>${checked ? '☒' : '☐'}</w:t></w:r></w:sdtContent></w:sdt>`;
const XML =
  `<w:body><w:p>${box(false)}<w:r><w:t xml:space="preserve">  keine Schwerbehinderung</w:t></w:r></w:p>` +
  `<w:p>${box(false, 'w14:val')}<w:r><w:t xml:space="preserve"> Schwerbehinderung, Grad: ______ %</w:t></w:r></w:p>` +
  `<w:p><w:r><w:t>☐ Vollzeit ☐ Teilzeit ☐ geringfügige Beschäftigung (Minijob)</w:t></w:r></w:p>` +
  `<w:p><w:r><w:t>☐ unbefristet ☐ befristet bis ________</w:t></w:r></w:p></w:body>`;

describe('Kästchen und Lücken in Word-Vorlagen', () => {
  it('erkennt Kontrollkästchen, ☐-Zeichen und Lücken mit Text daneben', () => {
    const f = formFieldsOf(XML);
    expect(f.map((x) => `${x.kind}:${x.label}`)).toEqual([
      'box:keine Schwerbehinderung',
      'box:Schwerbehinderung, Grad:',
      'blank:Schwerbehinderung, Grad:',
      'box:Vollzeit',
      'box:Teilzeit',
      'box:geringfügige Beschäftigung (Minijob)',
      'box:unbefristet',
      'box:befristet bis',
      'blank:befristet bis',
    ]);
    expect(f[2]!.before).toBe('Schwerbehinderung, Grad:');
  });

  it('kreuzt an, schreibt in Lücken und belegt aus Stammdaten vor', () => {
    const f = formFieldsOf(XML);
    const v = {
      'Mitarbeiter.Vorname': 'A',
      'Mitarbeiter.Beschäftigungsart': 'Teilzeit',
      'Mitarbeiter.Austrittsdatum': '31.12.2026',
    };
    const boxes = { ...defaultBoxes(f, v), 1: true };
    expect(boxes).toMatchObject({ 2: false, 3: true, 4: false, 5: false, 6: true });
    const blanks: Record<number, string> = { ...defaultBlanks(f, v), 0: '50' };
    expect(blanks[1]).toBe('31.12.2026');
    const out = applyFormFields(XML, boxes, blanks);
    expect(out).toContain('<w14:checked w14:val="1"/>');
    expect(out).toContain('Grad: 50 %');
    expect(out).toContain('☐ Vollzeit ☒ Teilzeit ☐ geringfügige');
    expect(out).toContain('☐ unbefristet ☒ befristet bis 31.12.2026');
    // erneut lesen: Zustand stimmt
    expect(
      formFieldsOf(out)
        .filter((x) => x.kind === 'box')
        .map((x) => x.checked),
    ).toEqual([false, true, false, true, false, false, true]);
  });
});
