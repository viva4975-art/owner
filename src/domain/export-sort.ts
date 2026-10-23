import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Exporte in der Sortierung der Bildschirm-Tabelle (Ahmed 07.10. für CSV, 23.10. für alle Exporte): Der Browser hängt
 * `?sort=<Spaltenname>&dir=asc|desc` an Export-Links/-Formulare; eine Middleware legt den Wunsch für die Dauer der
 * Anfrage hier ab, Listen-PDFs (`renderTablePdf`) und Excel (`writeXlsx`) sortieren danach, wenn eine Spalte passt.
 */
export interface ExportSort {
  label: string;
  dir: 'asc' | 'desc';
}

export const exportSortStore = new AsyncLocalStorage<ExportSort | null>();
export const currentExportSort = (): ExportSort | null => exportSortStore.getStore() ?? null;

type Key = [0, number] | [1, string];

export function sortKey(v: string): Key {
  const t = v.trim().replace(/^'/, '');
  const d = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(t);
  if (d) return [0, Number(d[3]! + d[2]! + d[1]!)];
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return [0, Number(iso[1]! + iso[2]! + iso[3]!)];
  const h = /^(\d{1,2}):(\d{2})(?!\d)/.exec(t);
  if (h && t.length <= 13) return [0, Number(h[1]) * 60 + Number(h[2])];
  const n = t.replace(/[€%\s\u00a0]/g, '');
  if (/^[-−]?[\d.]*\d(,\d+)?$/.test(n))
    return [0, Number(n.replace(/−/, '-').replace(/\./g, '').replace(',', '.'))];
  return [1, t.toLowerCase()];
}

export function cmpKey(a: Key, b: Key): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[0] === 0
    ? a[1] - (b[1] as number)
    : String(a[1]).localeCompare(String(b[1]), 'de', { numeric: true });
}

export const normLabel = (s: string) => s.toLowerCase().replace(/[^a-z0-9äöüß]/g, '');

/** Spalte zum Sortier-Wunsch (gleicher Name, sonst Anfang/enthalten); -1 = keine passt. */
export function matchColumn(header: string[], label: string): number {
  const head = header.map(normLabel);
  const want = normLabel(label);
  if (!want) return -1;
  let col = head.indexOf(want);
  if (col < 0) col = head.findIndex((h) => h && (h.startsWith(want) || want.startsWith(h)));
  if (col < 0 && want.length >= 4) col = head.findIndex((h) => h.includes(want));
  return col;
}

/** Sortiert Zeilen nach dem Sortier-Wunsch der Anfrage (stabil); ohne Wunsch/passende Spalte unverändert. */
export function sortByRequest<T>(header: string[], rows: T[], text: (row: T, col: number) => string): T[] {
  const s = currentExportSort();
  if (!s || rows.length < 2) return rows;
  const col = matchColumn(header, s.label);
  if (col < 0) return rows;
  const f = s.dir === 'desc' ? -1 : 1;
  return rows
    .map((r, i) => ({ r, i, k: sortKey(text(r, col)) }))
    .sort((a, b) => cmpKey(a.k, b.k) * f || a.i - b.i)
    .map((x) => x.r);
}
