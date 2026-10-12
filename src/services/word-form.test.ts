import { describe, expect, it } from 'vitest';
import { applyFormFields, defaultBlanks, defaultBoxes, defaultCells, formFieldsOf } from './word-form.js';

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

describe('leere Felder neben Beschriftungen (Ahmed 12.10.)', () => {
  const cell = (t: string) =>
    `<w:tc><w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr>${t ? `<w:r><w:t>${t}</w:t></w:r>` : '<w:r><w:t xml:space="preserve"> </w:t></w:r>'}</w:p></w:tc>`;
  const xml =
    `<w:body><w:tbl><w:tr>${cell('Name')}${cell('')}${cell('IBAN')}${cell('')}</w:tr>` +
    `<w:tr>${cell('1')}${cell('')}</w:tr>` +
    `<w:tr>${cell('Eingang beim Arbeitgeber')}${cell('')}${cell('Beginn der Befreiung')}${cell('')}</w:tr></w:tbl>` +
    `<w:p><w:r><w:t xml:space="preserve">Ort, Datum:      </w:t></w:r></w:p></w:body>`;
  it('erkennt Zellen und „Ort, Datum:“, belegt sie aus den Stammdaten vor und füllt sie', () => {
    const f = formFieldsOf(xml).filter((x) => x.kind === 'cell');
    // laufende Nummern („1“) zählen nicht als Beschriftung
    expect(f.map((x) => x.label)).toEqual([
      'Name',
      'IBAN',
      'Eingang beim Arbeitgeber',
      'Beginn der Befreiung',
      'Ort, Datum',
    ]);
    const v = {
      'Mitarbeiter.Vorname': 'Anna',
      'Mitarbeiter.Nachname': 'Muster',
      'Mitarbeiter.IBAN': 'DE02 1203',
      'Mitarbeiter.Eintrittsdatum': '15.10.2026',
      'Dokument.Datum': '12.10.2026',
      'Dokument.Unterschriftsdatum': '12.10.2026',
    };
    const cells = defaultCells(f, v);
    // RV-Befreiung: ab Monat des Eingangs, frühestens ab Beschäftigungsbeginn
    expect(Object.values(cells)).toEqual([
      'Muster',
      'DE02 1203',
      '12.10.2026',
      '15.10.2026',
      'München, 12.10.2026',
    ]);
    const out = applyFormFields(xml, {}, {}, cells);
    expect(out).toContain('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Muster</w:t></w:r>');
    expect(out).toContain('Ort, Datum:</w:t></w:r><w:r><w:t xml:space="preserve"> München, 12.10.2026</w:t>');
    // Felder sind danach nicht mehr leer → werden nicht noch einmal erkannt
    expect(formFieldsOf(out).filter((x) => x.kind === 'cell')).toHaveLength(0);
  });
});
