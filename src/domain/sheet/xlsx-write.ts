import { strToU8, zipSync } from 'fflate';
import { sortByRequest } from '../export-sort.js';

/*
 * Kleiner Excel-Schreiber (.xlsx, Office Open XML) ohne Fremdbibliothek: Texte als Inline-Text (nie als Formel –
 * kein CSV-/Formel-Einschleusen möglich), Zahlen mit Format (eine Nachkommastelle, Prozent), fette Kopfzeile,
 * Spaltenbreiten, fixierte Kopfzeile, Autofilter.
 */

export type XlsxCell = string | number | null | { n: number; fmt: 'd1' | 'pct' | 'int' } | { b: string };

export interface XlsxSheet {
  name: string;
  /** Zeilen über der Tabelle (z. B. Titel, Stand), fett */
  title?: string[];
  header: string[];
  rows: XlsxCell[][];
  /** Summen-/Durchschnittszeilen unter der Tabelle, fett */
  footer?: XlsxCell[][];
  widths?: number[];
}

const esc = (s: string) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const col = (i: number): string => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

// Stil-Index: 0 normal, 1 fett, 2 Zahl 0,0, 3 Prozent 0,0 %, 4 fett Zahl, 5 fett Prozent, 6 ganze Zahl, 7 fett ganze Zahl
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="0.0"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2E6EA"/></patternFill></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
</cellXfs>
</styleSheet>`;

function cellXml(ref: string, v: XlsxCell, bold: boolean): string {
  if (v == null || v === '') return '';
  if (typeof v === 'number')
    return Number.isFinite(v) ? `<c r="${ref}"${bold ? ' s="4"' : ' s="2"'}><v>${v}</v></c>` : '';
  if (typeof v === 'string')
    return `<c r="${ref}" t="inlineStr"${bold ? ' s="1"' : ''}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  if ('b' in v)
    return `<c r="${ref}" t="inlineStr" s="1"><is><t xml:space="preserve">${esc(v.b)}</t></is></c>`;
  if (!Number.isFinite(v.n)) return '';
  const s = v.fmt === 'pct' ? (bold ? 5 : 3) : v.fmt === 'int' ? (bold ? 7 : 6) : bold ? 4 : 2;
  return `<c r="${ref}" s="${s}"><v>${v.n}</v></c>`;
}

function sheetXml(s: XlsxSheet): string {
  const rows: string[] = [];
  let r = 0;
  for (const t of s.title ?? []) {
    r++;
    rows.push(`<row r="${r}">${cellXml(`A${r}`, t, true)}</row>`);
  }
  if (s.title?.length) r++; // Leerzeile
  const headRow = ++r;
  rows.push(
    `<row r="${r}">${s.header
      .map((h, i) => `<c r="${col(i)}${r}" t="inlineStr" s="8"><is><t>${esc(h)}</t></is></c>`)
      .join('')}</row>`,
  );
  const cellText = (row: XlsxCell[], i: number) => {
    const v = row[i];
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v).replace('.', ',');
    return 'b' in v ? v.b : String(v.n).replace('.', ',');
  };
  // Sortierung der Bildschirm-Tabelle (?sort=…) übernehmen
  for (const row of sortByRequest(s.header, s.rows, cellText)) {
    r++;
    rows.push(`<row r="${r}">${row.map((v, i) => cellXml(`${col(i)}${r}`, v, false)).join('')}</row>`);
  }
  const lastData = r;
  for (const row of s.footer ?? []) {
    r++;
    rows.push(`<row r="${r}">${row.map((v, i) => cellXml(`${col(i)}${r}`, v, true)).join('')}</row>`);
  }
  const lastCol = col(Math.max(0, s.header.length - 1));
  const cols = s.widths?.length
    ? `<cols>${s.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headRow}" topLeftCell="A${headRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
${cols}<sheetData>${rows.join('')}</sheetData>${
    lastData > headRow ? `<autoFilter ref="A${headRow}:${lastCol}${lastData}"/>` : ''
  }</worksheet>`;
}

/** Excel-Blattnamen: max. 31 Zeichen, ohne : \ / ? * [ ] */
const sheetName = (n: string, i: number) => n.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31) || `Blatt${i + 1}`;

export function writeXlsx(sheets: XlsxSheet[]): Uint8Array {
  const names = sheets.map((s, i) => sheetName(s.name, i));
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets
  .map(
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  )
  .join('\n')}
</Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names
        .map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join(
          '',
        )}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    'xl/styles.xml': strToU8(STYLES),
  };
  sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s))));
  return zipSync(files, { level: 6, mtime: new Date('2026-01-01T00:00:00Z') });
}
