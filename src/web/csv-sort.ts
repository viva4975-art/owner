import { cmpKey as cmp, normLabel as norm, sortKey } from '../domain/export-sort.js';

/**
 * Exporte in der Sortierung der Bildschirm-Tabelle (Ahmed 07.10.): Der Browser hängt `?sort=<Spaltenname>&dir=asc|desc`
 * an CSV-Links; hier wird die fertige CSV nach der gleichnamigen Spalte umsortiert. Rohzeilen bleiben unverändert
 * (keine Neu-Quotierung), Summen-/Gesamtzeilen bleiben unten. Passt keine Spalte, bleibt die Datei, wie sie ist.
 */

/** Zerlegt CSV in Datensätze (Anführungszeichen mit Zeilenumbrüchen erlaubt); liefert Rohtext und Zellen. */
function records(text: string, sep: string): { raw: string; cells: string[] }[] {
  const out: { raw: string; cells: string[] }[] = [];
  let i = 0;
  while (i < text.length) {
    const start = i;
    const cells: string[] = [];
    let cell = '';
    let q = false;
    for (; i < text.length; i++) {
      const ch = text[i]!;
      if (q) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i++;
          } else q = false;
        } else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) {
        cells.push(cell);
        cell = '';
      } else if (ch === '\n' || ch === '\r') break;
      else cell += ch;
    }
    cells.push(cell);
    const raw = text.slice(start, i);
    if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
    else if (i < text.length) i++;
    if (raw.length) out.push({ raw, cells });
  }
  return out;
}

export function sortCsv(text: string, label: string, dir: 'asc' | 'desc'): string {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const body = bom ? text.slice(1) : text;
  const first = body.split(/\r?\n/, 1)[0] ?? '';
  const sep = [';', '\t', ','].find((s) => first.includes(s)) ?? ';';
  const recs = records(body, sep);
  if (recs.length < 3) return text;
  const head = recs[0]!.cells.map(norm);
  const want = norm(label);
  if (!want) return text;
  let col = head.indexOf(want);
  if (col < 0) col = head.findIndex((h) => h && (h.startsWith(want) || want.startsWith(h)));
  if (col < 0 && want.length >= 4) col = head.findIndex((h) => h.includes(want));
  if (col < 0) return text;
  const isTotal = (r: { cells: string[] }) => /^\s*(summe|gesamt)/i.test(r.cells[0] ?? '');
  const rows = recs.slice(1);
  const data = rows.filter((r) => !isTotal(r));
  const totals = rows.filter(isTotal);
  const f = dir === 'desc' ? -1 : 1;
  data.sort((a, b) => cmp(sortKey(a.cells[col] ?? ''), sortKey(b.cells[col] ?? '')) * f);
  const nl = body.includes('\r\n') ? '\r\n' : '\n';
  return bom + [recs[0]!, ...data, ...totals].map((r) => r.raw).join(nl) + nl;
}
