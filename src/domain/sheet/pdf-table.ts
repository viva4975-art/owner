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
export function itemsToRows(input: PdfItem[]): string[][] {
  let items = input;
  if (!items.length) return [];
  // Zeilen: gleiche Seite, y innerhalb 2,5 pt
  const sorted = [...items].sort((p, q) => p.page - q.page || q.y - p.y || p.x - q.x);
  let lines: PdfItem[][] = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && last[0]!.page === it.page && Math.abs(last[0]!.y - it.y) <= 2.5) last.push(it);
    else lines.push([it]);
  }
  for (const l of lines) l.sort((p, q) => p.x - q.x);

  // Kopfzeile, die auf mehreren Seiten wiederkehrt (z. B. Revierplan je Reinigungskraft): Seiten können leicht
  // unterschiedlich skaliert sein (Excel/LibreOffice „auf Seitenbreite“) → jede Seite über ihre Kopfzeile auf die
  // erste Seite mit Kopfzeile umrechnen (x' = a·x + b)
  const keyOf = (l: PdfItem[]) => l.map((i) => i.str).join('\u0001');
  const pagesByKey = new Map<string, Set<number>>();
  for (const l of lines) {
    if (l.length < 4) continue;
    const k = keyOf(l);
    if (!pagesByKey.has(k)) pagesByKey.set(k, new Set());
    pagesByKey.get(k)!.add(l[0]!.page);
  }
  let headerKey: string | null = null;
  let headerN = 0;
  for (const [k, pages] of pagesByKey) {
    const n = k.split('\u0001').length;
    if (pages.size >= 2 && n > headerN) {
      headerKey = k;
      headerN = n;
    }
  }
  const headerLines = headerKey ? lines.filter((l) => keyOf(l) === headerKey) : [];
  if (headerLines.length >= 2) {
    const ref = headerLines[0]!;
    const fit = new Map<number, { a: number; b: number }>();
    for (const h of headerLines) {
      if (h[0]!.page === ref[0]!.page || fit.has(h[0]!.page)) continue;
      const n = h.length;
      const mx = h.reduce((s2, i) => s2 + i.x, 0) / n;
      const my = ref.reduce((s2, i) => s2 + i.x, 0) / n;
      let num = 0;
      let den = 0;
      h.forEach((i, k) => {
        num += (i.x - mx) * (ref[k]!.x - my);
        den += (i.x - mx) ** 2;
      });
      const a = den > 0 ? num / den : 1;
      if (a > 0.5 && a < 2) fit.set(h[0]!.page, { a, b: my - a * mx });
    }
    let cur: { a: number; b: number } | undefined;
    let curPage = 0;
    lines = lines.map((l) => {
      const pg = l[0]!.page;
      if (pg !== curPage) {
        curPage = pg;
        cur = fit.get(pg) ?? cur;
      }
      const f = cur;
      return f ? l.map((i) => ({ ...i, x: f.a * i.x + f.b, w: f.a * i.w })) : l;
    });
    items = lines.flat();
  }

  // Belegung je x (jede Zeile zählt einmal); Spalten = Bereiche, die in mehr als t Zeilen belegt sind.
  // Nur Tabellenzeilen (mind. 4 Stücke) und keine sehr breiten Stücke (Titel, Fußzeile, Legende)
  const maxX = Math.ceil(Math.max(...items.map((i) => i.x + i.w))) + 2;
  const wide = (it: PdfItem) => it.w > maxX * 0.35;
  const tableLines = lines.filter((l) => l.length >= 4);
  const cover = new Int32Array(maxX + 1);
  // wiederholte Kopfzeilen zählen nicht mit (ihre Beschriftungen werden unten den Spalten zugeordnet)
  for (const l of tableLines) {
    if (headerKey && keyOf(l) === headerKey) continue;
    const mark = new Uint8Array(maxX + 1);
    for (const it of l) {
      if (wide(it)) continue;
      for (let x = Math.max(0, Math.floor(it.x)); x < Math.ceil(it.x + it.w); x++) mark[x] = 1;
    }
    for (let x = 0; x <= maxX; x++) cover[x]! += mark[x]!;
  }
  const t = Math.max(1, Math.floor(tableLines.length * 0.03));
  const cols: Col[] = [];
  for (let x = 0; x <= maxX; x++) {
    if (cover[x]! <= t) continue;
    const prev = cols[cols.length - 1];
    if (prev && x - prev.b <= 1) prev.b = x + 1;
    else cols.push({ a: x, b: x + 1 });
  }
  // Beschriftung der Kopfzeile ohne Spalte (Kopf zentriert, Daten linksbündig: „Raumbezeichnung“ über „Saal“):
  // zur nächsten Spalte, die noch keine eigene Beschriftung hat (bis 80 pt); sonst eigene Spalte (z. B. „Beschreibung“
  // ohne Einträge)
  const headLine = (headerKey ? lines.find((l) => keyOf(l) === headerKey) : undefined) ?? tableLines[0];
  if (headLine) {
    const labelled = new Set<Col>();
    for (const it of headLine)
      for (const c of cols) if (overlap(it.x, it.x + it.w, c.a, c.b) > 0) labelled.add(c);
    for (const it of headLine) {
      if (wide(it) || cols.some((c) => overlap(it.x, it.x + it.w, c.a, c.b) > 0)) continue;
      let best: Col | undefined;
      let d = 80;
      for (const c of cols) {
        if (labelled.has(c)) continue;
        const gap = it.x >= c.b ? it.x - c.b : c.a - (it.x + it.w);
        if (gap < d) {
          d = gap;
          best = c;
        }
      }
      if (best) {
        best.a = Math.min(best.a, it.x);
        best.b = Math.max(best.b, it.x + it.w);
        labelled.add(best);
      }
    }
  }
  // übrige Textstücke ohne Spalte (seltene Spalten wie „Beschreibung“) bilden eigene Spalten
  const orphans = tableLines
    .flat()
    .filter((it) => !wide(it) && !cols.some((c) => overlap(it.x, it.x + it.w, c.a, c.b) > 0));
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

  const rows: { page: number; cells: string[]; hdr: boolean }[] = [];
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
      hdr: headerKey !== null && keyOf(l) === headerKey,
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
  let headerSeen = false;
  return rows
    .filter((r) => {
      if (r.hdr) {
        if (headerSeen) return false;
        headerSeen = true;
        return true;
      }
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
