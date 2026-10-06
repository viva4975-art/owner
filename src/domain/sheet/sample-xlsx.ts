// Testhilfe: kleine Excel-Datei (nur für Tests).
import { strToU8, zipSync } from 'fflate';

/** Minimale .xlsx wie aus Excel: gemeinsame Texte, Zahl, Inline-Text, leere Zelle, Titelzeile. */
export function sampleXlsx(): Uint8Array {
  const ss = [
    'Raumbuch Grundschule',
    'Etage',
    'Raum-Nr.',
    'Raum',
    'Raumart',
    'Fläche m²',
    'Intervall',
    'EG',
    'Sekretariat',
    'Büro',
    '5x wöchentlich',
    'WC &amp; Dusche',
  ];
  const sst = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${ss
    .map((t, i) => (i === 3 ? `<si><r><t>Ra</t></r><r><t>um</t></r></si>` : `<si><t>${t}</t></si>`))
    .join('')}</sst>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="3"/></cols><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c></row>
<row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3" t="s"><v>2</v></c><c r="C3" t="s"><v>3</v></c><c r="D3" t="s"><v>4</v></c><c r="E3" t="s"><v>5</v></c><c r="F3" t="s"><v>6</v></c></row>
<row r="4"><c r="A4" t="s"><v>7</v></c><c r="B4"><v>1.01</v></c><c r="C4" t="s"><v>8</v></c><c r="D4" t="s"><v>9</v></c><c r="E4"><v>24.5</v></c><c r="F4" t="s"><v>10</v></c></row>
<row r="5"><c r="A5" t="s"><v>7</v></c><c r="B5" t="inlineStr"><is><t>1.02</t></is></c><c r="C5" t="s"><v>11</v></c><c r="D5" s="1"/><c r="E5"><v>8</v></c><c r="F5" t="str"><f>"tgl"</f><v>täglich</v></c></row>
</sheetData></worksheet>`;
  const wb = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Räume" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/raeume.xml"/></Relationships>`;
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8(wb),
    'xl/_rels/workbook.xml.rels': strToU8(rels),
    'xl/sharedStrings.xml': strToU8(sst),
    'xl/worksheets/raeume.xml': strToU8(sheet),
  });
}
