import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { itemsToRows, readPdfTable } from './pdf-table.js';

/** PDF wie aus Excel gedruckt: Kopfzeile mit zusammengezogenem Text, leere Spalte, Zahlen rechtsbündig, Folgeseite ohne Kopf. */
async function samplePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const put = (p: ReturnType<typeof doc.addPage>, s: string, x: number, y: number, right = false) =>
    p.drawText(s, { x: right ? x - font.widthOfTextAtSize(s, 7) : x, y, size: 7, font });
  const row = (p: ReturnType<typeof doc.addPage>, y: number, r: string[]) => {
    put(p, r[0]!, 150, y);
    put(p, r[1]!, 221, y);
    put(p, r[2]!, 325, y);
    if (r[3]) put(p, r[3], 500, y);
    put(p, r[4]!, 580, y, true);
  };
  const p1 = doc.addPage([842, 595]);
  put(p1, 'Objektnummer * Raumname *', 140, 531);
  put(p1, 'Raumnummer *', 325, 531);
  put(p1, 'Revier', 500, 531);
  put(p1, 'Größe in m²', 548, 531);
  const data = [
    ['2010001', 'Flur', 'A 0.01', '', '12,76'],
    ['2010001', 'Klassenraum Mittagsbetreuung', 'A 0.02', '', '112,50'],
    ['2010001', 'WC', 'A 0.03', 'R1', '8,10'],
  ];
  data.forEach((r, i) => row(p1, 521 - i * 10, r));
  const p2 = doc.addPage([842, 595]);
  for (let i = 0; i < 20; i++) row(p2, 531 - i * 10, ['2010001', 'Büro', `B 1.${i}`, '', '20,00']);
  return doc.save();
}

describe('PDF-Tabelle lesen', () => {
  it('Spalten über Positionen, leere Spalte bleibt, Kopf wortweise verteilt', async () => {
    const rows = await readPdfTable(await samplePdf());
    expect(rows[0]).toEqual(['Objektnummer *', 'Raumname *', 'Raumnummer *', 'Revier', 'Größe in m²']);
    expect(rows[1]).toEqual(['2010001', 'Flur', 'A 0.01', '', '12,76']);
    expect(rows[2]).toEqual(['2010001', 'Klassenraum Mittagsbetreuung', 'A 0.02', '', '112,50']);
    expect(rows[3]).toEqual(['2010001', 'WC', 'A 0.03', 'R1', '8,10']);
    expect(rows.length).toBe(24);
  });

  it('auf jeder Seite wiederholte Kopfzeile nur einmal', () => {
    const it = (page: number, x: number, y: number, str: string) => ({ page, x, y, w: str.length * 4, str });
    const items = [1, 2, 3].flatMap((p) => [
      it(p, 10, 500, 'Raum'),
      it(p, 100, 500, 'Fläche'),
      ...[0, 1, 2, 3].flatMap((i) => [it(p, 10, 490 - i * 10, `R${p}${i}`), it(p, 100, 490 - i * 10, '5')]),
    ]);
    const rows = itemsToRows(items);
    expect(rows.filter((r) => r[0] === 'Raum').length).toBe(1);
    expect(rows.length).toBe(13);
  });
});
