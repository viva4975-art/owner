import { describe, expect, it } from 'vitest';
import { genderOf, genderizeXml, salaryClause, shadeEmployeeSignature } from './word-gender.js';

const p = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const txt = (xml: string) => xml.replace(/<[^>]+>/g, '');

describe('Mitarbeiter-Vorlagen: Arbeitnehmer / Arbeitnehmerin', () => {
  const src =
    p('Der/die Arbeitnehmer/in versichert, dass er/sie kein weiteres Arbeitsverhältnis hat.') +
    p(
      'Es ist ihm/ihr verboten. Angaben des/der Arbeitnehmer/in. Gefahr des Arbeitnehmers/der Arbeitnehmerin.',
    ) +
    p('Dem/der Arbeitnehmer/in wird den/die Mitarbeiter/in gezeigt, seiner/ihrer Wahl.') +
    p('Veranlassung des/der ${Aufhebung.Veranlassung}. Neue/r Mitarbeiter/in. Vorarbeiter/innen.');

  it('Frau', () => {
    const t = txt(genderizeXml(src, 'f'));
    expect(t).toContain('Die Arbeitnehmerin versichert, dass sie kein');
    expect(t).toContain('Es ist ihr verboten. Angaben der Arbeitnehmerin. Gefahr der Arbeitnehmerin.');
    expect(t).toContain('Der Arbeitnehmerin wird die Mitarbeiterin gezeigt, ihrer Wahl.');
    expect(t).toContain('des/der ${Aufhebung.Veranlassung}');
    expect(t).toContain('Neue Mitarbeiterin. Vorarbeiter/innen.');
  });

  it('Herr', () => {
    const t = txt(genderizeXml(src, 'm'));
    expect(t).toContain('Der Arbeitnehmer versichert, dass er kein');
    expect(t).toContain('Es ist ihm verboten. Angaben des Arbeitnehmers. Gefahr des Arbeitnehmers.');
    expect(t).toContain('Dem Arbeitnehmer wird den Mitarbeiter gezeigt, seiner Wahl.');
    expect(t).toContain('Neuer Mitarbeiter.');
  });

  it('über Word-Läufe hinweg, Anrede → Geschlecht', () => {
    const x =
      '<w:p><w:r><w:t>Der/die Arbeit</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>nehmer/in zahlt</w:t></w:r></w:p>';
    expect(txt(genderizeXml(x, 'f'))).toBe('Die Arbeitnehmerin zahlt');
    expect(genderOf('Frau')).toBe('f');
    expect(genderOf('Herr')).toBe('m');
    expect(genderOf('divers')).toBeNull();
  });
});

describe('Unterschriftsfeld der Person hinterlegt', () => {
  it('Tabelle: hellgraue Zeile nur über der Arbeitnehmer-Zelle', () => {
    const cell = (t: string) =>
      `<w:tc><w:tcPr><w:tcW w:w="4270" w:type="dxa"/><w:tcBorders><w:top w:val="single" w:sz="4"/></w:tcBorders></w:tcPr>${p(t)}</w:tc>`;
    const xml = `<w:tbl><w:tr>${cell('Unterschrift Arbeitgeber')}${cell('Unterschrift Arbeitnehmerin – Anna')}</w:tr></w:tbl>`;
    const out = shadeEmployeeSignature(xml);
    const rows = out.match(/<w:tr>[\s\S]*?<\/w:tr>/g)!;
    expect(rows).toHaveLength(2);
    const cells = rows[0]!.match(/<w:tc>[\s\S]*?<\/w:tc>/g)!;
    expect(cells[0]).not.toContain('w:shd');
    expect(cells[1]).toContain('w:shd');
    expect(shadeEmployeeSignature(out)).toBe(out); // nicht doppelt
  });

  it('Absatz mit Linie über „Datum, Mitarbeiter/in“ wird hinterlegt', () => {
    const line =
      '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="8"/></w:pBdr><w:spacing w:after="34"/></w:pPr></w:p>';
    const out = shadeEmployeeSignature(line + p('Datum, Mitarbeiter/in'));
    expect(out).toContain('w:shd');
    expect(out).toContain('w:lineRule="exact"');
    expect(shadeEmployeeSignature(line + p('Datum, Geschäftsführung'))).not.toContain('w:shd');
  });

  it('Linie über der Beschriftung: leerer Absatz davor wird das Feld', () => {
    const xml =
      '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:p>' +
      '<w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="4"/></w:pBdr></w:pPr><w:r><w:t>Datum, Unterschrift Mitarbeiterin</w:t></w:r></w:p>';
    const out = shadeEmployeeSignature(xml);
    expect(out.indexOf('w:shd')).toBeLessThan(out.indexOf('Datum, Unterschrift'));
    expect(out).toContain('w:line="640"');
  });
});

describe('Festgehalt im Arbeitsvertrag', () => {
  it('Stundenlohn-Satz wird zum Monatsgehalt', () => {
    const x =
      '<w:p><w:r><w:t>2.1  Der/die Arbeitnehmer/in erhält den Tariflohn von derzeit ${Mitarbeiter.Stunden</w:t></w:r><w:r><w:t>lohn} EUR brutto pro Stunde. Zuschläge …</w:t></w:r></w:p>';
    expect(txt(salaryClause(x))).toBe(
      '2.1  Der/die Arbeitnehmer/in erhält ein festes monatliches Bruttogehalt in Höhe von ${Mitarbeiter.Gehalt} EUR. Zuschläge …',
    );
  });
});
