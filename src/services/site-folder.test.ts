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
});
