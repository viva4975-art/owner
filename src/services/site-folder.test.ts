import { describe, expect, it } from 'vitest';
import { fillFolderXml } from './site-folder.js';

const p = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const tc = (inner: string) => `<w:tc><w:tcPr/>${inner}</w:tc>`;

describe('Objektordner: Lücken in Word-Vorlagen füllen', () => {
  const values = {
    objekt: 'Schule Ost (2007805)',
    objektleitung: 'Olga O.',
    'objektleitung|tel': '0176 1',
    'bereichsleitung|tel': '0176 2',
    kunde: 'Stadt (20078)',
  };
  it('Absatz „Beschriftung: ____“ und „Tel“ bezogen auf die Zeile davor', () => {
    const xml =
      p('Objekt: ______') +
      p('Objektleitung: ____') +
      p('Tel: ____') +
      p('Bereichsleitung: ____') +
      p('Tel: ____');
    const r = fillFolderXml(xml, values);
    expect(r.xml).toContain('Objekt: Schule Ost (2007805)');
    expect(r.xml).toContain('Objektleitung: Olga O.');
    expect(r.xml.match(/Tel: [^<]*/g)).toEqual(['Tel: 0176 1', 'Tel: 0176 2']);
    // Bereichsleitung selbst unbekannt → Linie bleibt
    expect(r.xml).toContain('Bereichsleitung: ____');
  });
  it('Tabelle: Wert in die Zelle neben der Beschriftung (Unterstriche oder leer)', () => {
    const row = `<w:tr>${tc(p('Kunde'))}${tc('<w:p></w:p>')}${tc(p('Objektleitung'))}${tc(p('______'))}</w:tr>`;
    const r = fillFolderXml(`<w:tbl>${row}</w:tbl>`, values);
    expect(r.filled).toBe(2);
    expect(r.xml).toContain('>Stadt (20078)</w:t>');
    expect(r.xml).toContain('Olga O.');
  });
  it('Beschriftungen wie „Anschrift Objekt“, Name + „Tel.:“ in einer Zelle, gleiche leere Zellen', () => {
    const v = {
      ...values,
      adresse: 'Weg 1, 80000 München',
      ansprechpartner: 'Maier',
      'ansprechpartner|tel': '089 1',
      leistungsbeginn: '01.01.2026',
    };
    const row1 = `<w:tr>${tc(p('Anschrift Objekt'))}${tc(p('______'))}</w:tr>`;
    const row2 = `<w:tr>${tc(p('Ansprechpartner Kunde'))}${tc(p('______ Tel.: ______'))}</w:tr>`;
    const row3 = `<w:tr>${tc(p('Übernahme am'))}${tc('<w:p></w:p>')}${tc(p('Beginn der Reinigung'))}${tc('<w:p></w:p>')}</w:tr>`;
    const r = fillFolderXml(`<w:tbl>${row1}${row2}${row3}</w:tbl>`, v);
    expect(r.xml).toContain('Weg 1, 80000 München');
    expect(r.xml).toContain('Maier Tel.: 089 1');
    // Datum gehört in die Zelle hinter „Beginn der Reinigung“, nicht hinter „Übernahme am“
    const cells = [...r.xml.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((m) => m[0].replace(/<[^>]+>/g, ''));
    expect(cells.slice(-4)).toEqual(['Übernahme am', '', 'Beginn der Reinigung', '01.01.2026']);
  });
});
