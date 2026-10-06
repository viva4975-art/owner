import { unzipSync } from 'fflate';
import { splitCsvLine } from '../bank/statement.js';

/**
 * Tabellen einlesen: Excel (.xlsx, erstes Blatt) oder CSV (Semikolon/Komma/Tab, UTF-8 oder Windows-1252).
 * Ergebnis: Zeilen als Textzellen. Zahlen aus Excel bleiben wie gespeichert („24.5“, Punkt als Dezimaltrenner) –
 * so bleiben auch Raumnummern wie „1.01“ erhalten; `kind` sagt, wie Zahlen zu lesen sind. Kein XML-Parser mit DTD → keine XXE-Gefahr; DOCTYPE wird abgelehnt.
 */
export class SheetError extends Error {}

export interface Sheet {
  kind: 'xlsx' | 'csv';
  rows: string[][];
}

const MAX_UNZIPPED = 60 * 1024 * 1024;

export function readSheet(bytes: Uint8Array): Sheet {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return readXlsx(bytes);
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf)
    throw new SheetError('Altes Excel-Format (.xls) – bitte in Excel als .xlsx oder CSV speichern');
  return readCsv(bytes);
}

function readCsv(bytes: Uint8Array): Sheet {
  const utf = new TextDecoder('utf-8').decode(bytes);
  const text = (utf.includes('\uFFFD') ? new TextDecoder('windows-1252').decode(bytes) : utf).replace(
    /^\uFEFF/,
    '',
  );
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) throw new SheetError('Datei ist leer');
  const first = lines.slice(0, 10).join('\n');
  const sep = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0]!;
  return { kind: 'csv', rows: lines.map((l) => splitCsvLine(l, sep).map((c) => c.trim())) };
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function xmlText(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e] ?? m;
  });
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readXlsx(bytes: Uint8Array): Sheet {
  let files: Record<string, Uint8Array>;
  let total = 0;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (
          !/^(xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/sharedStrings\.xml|xl\/worksheets\/[^/]+\.xml)$/.test(
            f.name,
          )
        )
          return false;
        total += f.originalSize;
        if (total > MAX_UNZIPPED) throw new SheetError('Excel-Datei zu groß');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof SheetError) throw e;
    throw new SheetError('Excel-Datei kann nicht gelesen werden');
  }
  const dec = new TextDecoder('utf-8');
  const xml = (name: string) => {
    const f = files[name];
    if (!f) return null;
    const t = dec.decode(f);
    if (/<!DOCTYPE/i.test(t)) throw new SheetError('Excel-Datei enthält unzulässige Angaben (DOCTYPE)');
    return t;
  };
  // erstes Blatt über workbook.xml + Beziehungen finden
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = xml('xl/workbook.xml');
  const rels = xml('xl/_rels/workbook.xml.rels');
  const firstSheet = wb ? /<sheet\b[^>]*>/.exec(wb)?.[0] : undefined;
  const rid = firstSheet ? attr(firstSheet, 'r:id') : undefined;
  if (rid && rels) {
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if (attr(m[0], 'Id') === rid) {
        const target = attr(m[0], 'Target') ?? '';
        sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
      }
    }
  }
  const sheet = xml(sheetPath);
  if (!sheet) throw new SheetError('Excel-Datei enthält kein Tabellenblatt');

  const shared: string[] = [];
  const ss = xml('xl/sharedStrings.xml');
  if (ss) {
    for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const body = m[1]!.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
      shared.push([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlText(t[1]!)).join(''));
    }
  }

  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row: string[] = [];
    const body = rm[1] ?? '';
    let next = 0;
    for (const cm of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = cm[1]!;
      const ref = attr(` ${head}`, 'r');
      const idx = ref ? colIndex(ref) : next;
      next = idx + 1;
      const type = attr(` ${head}`, 't');
      const inner = cm[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let val = '';
      if (type === 's') val = shared[Number(v)] ?? '';
      else if (type === 'inlineStr')
        val = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlText(t[1]!)).join('');
      else if (type === 'str' || type === 'e') val = v != null ? xmlText(v) : '';
      else if (type === 'b') val = v === '1' ? 'ja' : 'nein';
      else if (v != null) {
        // Gleitkomma-Artefakte aus Excel (24.500000000000004) auf 10 Stellen glätten
        const n = Number(v);
        val = Number.isFinite(n) ? String(Number(n.toPrecision(12))) : xmlText(v);
      }
      while (row.length < idx) row.push('');
      row[idx] = val.trim();
    }
    if (row.some((c) => c !== '')) rows.push(row);
  }
  if (!rows.length) throw new SheetError('Tabellenblatt ist leer');
  return { kind: 'xlsx', rows };
}
