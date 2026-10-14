import { getDocumentProxy } from 'unpdf';

/**
 * Tabelle aus einer PDF (Textebene, z. B. aus Excel oder Fortytools als PDF gedruckt) lesen.
 * Spalten werden über die x-Positionen erkannt (Bereiche, die in vielen Zeilen belegt sind), nicht über
 * Leerzeichen – so bleiben leere Spalten (z. B. „Revier“) an ihrer Stelle. Kopfzeilen, die mehrere Spalten
 * überdecken („Objektnummer * Raumname *“), werden wortweise verteilt. Ergebnis wie bei CSV: Zeilen mit Textzellen.
 * Gescannte PDFs ohne Textebene liefern keine Zeilen (keine Texterkennung).
 */
export interface PdfItem {
  page: number;
  x: number;
  y: number;
  w: number;
  str: string;
}

const MAX_PAGES = 200;

export async function pdfItems(bytes: Uint8Array): Promise<PdfItem[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const out: PdfItem[] = [];
  for (let p = 1; p <= Math.min(pdf.numPages, MAX_PAGES); p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const str = it.str.replace(/\s+/g, ' ').trim();
      if (!str) continue;
      const w = it.width > 0 ? it.width : str.length * 4;
      out.push({ page: p, x: it.transform[4] as number, y: it.transform[5] as number, w, str });
    }
  }
  return out;
}

interface Col {
  a: number;
  b: number;
}

const overlap = (a1: number, b1: number, a2: number, b2: number) =>
  Math.max(0, Math.min(b1, b2) - Math.max(a1, a2));

/** Positionierte Textstücke → Tabellenzeilen (rein, ohne PDF – testbar). */
export function itemsToRows(items: PdfItem[]): string[][] {
  if (!items.length) return [];
  // Zeilen: gleiche Seite, y innerhalb 2,5 pt
  const sorted = [...items].sort((p, q) => p.page - q.page || q.y - p.y || p.x - q.x);
  const lines: PdfItem[][] = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && last[0]!.page === it.page && Math.abs(last[0]!.y - it.y) <= 2.5) last.push(it);
    else lines.push([it]);
  }
  for (const l of lines) l.sort((p, q) => p.x - q.x);

  // Belegung je x (jede Zeile zählt einmal); Spalten = Bereiche, die in mehr als t Zeilen belegt sind
  const maxX = Math.ceil(Math.max(...items.map((i) => i.x + i.w))) + 2;
  const cover = new Int32Array(maxX + 1);
  for (const l of lines) {
    const mark = new Uint8Array(maxX + 1);
    for (const it of l)
      for (let x = Math.max(0, Math.floor(it.x)); x < Math.ceil(it.x + it.w); x++) mark[x] = 1;
    for (let x = 0; x <= maxX; x++) cover[x]! += mark[x]!;
  }
  const t = Math.max(1, Math.floor(lines.length * 0.03));
  const cols: Col[] = [];
  for (let x = 0; x <= maxX; x++) {
    if (cover[x]! <= t) continue;
    const prev = cols[cols.length - 1];
    if (prev && x - prev.b <= 1) prev.b = x + 1;
    else cols.push({ a: x, b: x + 1 });
  }
  // Textstücke ohne Spalte (seltene Spalten wie „Beschreibung“, Kopfzeilen) bilden eigene Spalten
  const orphans = items.filter((it) => !cols.some((c) => overlap(it.x, it.x + it.w, c.a, c.b) > 0));
  for (const it of orphans.sort((p, q) => p.x - q.x)) {
    const hit = cols.find((c) => overlap(it.x, it.x + it.w, c.a - 2, c.b + 2) > 0);
    if (hit) {
      hit.a = Math.min(hit.a, it.x);
      hit.b = Math.max(hit.b, it.x + it.w);
    } else cols.push({ a: it.x, b: it.x + it.w });
  }
  cols.sort((p, q) => p.a - q.a);
  if (!cols.length) return [];

  const colOf = (a: number, b: number) => {
    let best = -1;
    let bestOv = 0;
    cols.forEach((c, i) => {
      const ov = overlap(a, b, c.a, c.b);
      if (ov > bestOv) {
        bestOv = ov;
        best = i;
      }
    });
    if (best >= 0) return best;
    const mid = (a + b) / 2;
    let d = Infinity;
    cols.forEach((c, i) => {
      const dd = mid < c.a ? c.a - mid : mid > c.b ? mid - c.b : 0;
      if (dd < d) {
        d = dd;
        best = i;
      }
    });
    return best;
  };

  const rows: { page: number; cells: string[] }[] = [];
  for (const l of lines) {
    const parts: { col: number; x: number; str: string }[] = [];
    const native = new Set<number>();
    const multi: PdfItem[] = [];
    for (const it of l) {
      const hits = cols.filter((c) => overlap(it.x, it.x + it.w, c.a, c.b) > 0.5).length;
      if (hits > 1 && it.str.includes(' ')) multi.push(it);
      else {
        const c = colOf(it.x, it.x + it.w);
        native.add(c);
        parts.push({ col: c, x: it.x, str: it.str });
      }
    }
    // Stücke über mehrere Spalten: Wörter anteilig verteilen; in eine Spalte, die in dieser Zeile schon
    // eigenen Text hat, wandert ein Wort nicht (überlaufender langer Text bleibt zusammen)
    for (const it of multi) {
      const words = it.str.split(' ');
      const len = it.str.length;
      let pos = 0;
      let cur = -1;
      for (const wd of words) {
        const a = it.x + (it.w * pos) / len;
        const b = it.x + (it.w * (pos + wd.length)) / len;
        pos += wd.length + 1;
        let c = colOf(a, b);
        if (cur >= 0 && c !== cur && native.has(c)) c = cur;
        if (cur < 0 && native.has(c)) {
          const free = colOf(it.x, it.x + 1);
          c = native.has(free) ? c : free;
        }
        cur = c;
        parts.push({ col: c, x: a, str: wd });
      }
    }
    const cells = cols.map(() => [] as { x: number; str: string }[]);
    for (const p of parts) cells[p.col]!.push(p);
    rows.push({
      page: l[0]!.page,
      cells: cells.map((cs) =>
        cs
          .sort((p, q) => p.x - q.x)
          .map((p) => p.str)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
      ),
    });
  }
  // Kopfzeile, die auf jeder Seite wiederholt wird, nur einmal behalten
  const seen = new Set<string>();
  const firstOfPage = new Map<string, number>();
  let lastPage = 0;
  for (const r of rows) {
    if (r.page === lastPage) continue;
    lastPage = r.page;
    const k = r.cells.join('\u0001');
    firstOfPage.set(k, (firstOfPage.get(k) ?? 0) + 1);
  }
  return rows
    .filter((r) => {
      const k = r.cells.join('\u0001');
      if ((firstOfPage.get(k) ?? 0) < 2) return true;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((r) => r.cells);
}

export async function readPdfTable(bytes: Uint8Array): Promise<string[][]> {
  return itemsToRows(await pdfItems(bytes));
}

export const isPdf = (bytes: Uint8Array) =>
  bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
