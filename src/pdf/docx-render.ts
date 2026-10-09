import { rgb } from '@cantoo/pdf-lib';
import { FORM_X, FORM_Y, type FormDoc } from './form-doc.js';

/*
 * Word-Dokument (document.xml) als Seiten in ein FormDoc setzen (Objektordner als ein PDF, Ahmed 09.10.:
 * „PDF, die man direkt ausdrucken kann“). Unterstützt, was Ahmeds Vorlagen nutzen: Absätze mit Läufen (fett, Farbe,
 * Größe, Großbuchstaben, Tab, Zeilenumbruch), Abstand nach, Linie unter dem Absatz, Ausrichtung, Aufzählungen,
 * Seitenumbruch, Tabellen mit Spaltenbreiten, verbundenen Zellen, Zellfarbe, Mindesthöhe und Rahmen. Kopf-/Fußzeilen und
 * Bilder entfallen (das Briefpapier bringt Logo und Firmendaten mit).
 */

interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: (XNode | string)[];
}

const unesc = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

/** Kleiner XML-Parser (nur Elemente, Attribute, Text) – reicht für document.xml. */
export function parseXml(xml: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, children: [] };
  const stack: XNode[] = [root];
  const re =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1]!;
    if (m[5] !== undefined) {
      top.children.push(unesc(m[5]));
      continue;
    }
    if (!m[2]) continue;
    if (m[1]) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (m[3] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
      attrs[a[1]!] = unesc(a[2] ?? a[3] ?? '');
    const node: XNode = { name: m[2], attrs, children: [] };
    top.children.push(node);
    if (!m[4]) stack.push(node);
  }
  return root;
}

const kids = (n: XNode, name?: string) =>
  n.children.filter((c): c is XNode => typeof c !== 'string' && (!name || c.name === name));
const child = (n: XNode | undefined, name: string) => (n ? kids(n, name)[0] : undefined);
const val = (n: XNode | undefined) => n?.attrs['w:val'];

interface Run {
  text: string;
  bold: boolean;
  color: [number, number, number] | null;
  size: number | null;
}
interface Para {
  kind: 'p';
  runs: Run[];
  align: 'left' | 'center' | 'right';
  after: number;
  before: number;
  border: [number, number, number] | null;
  bullet: boolean;
  pageBreak: boolean;
}
interface Cell {
  paras: Para[];
  fill: [number, number, number] | null;
  span: number;
}
interface Table {
  kind: 'tbl';
  grid: number[];
  rows: { minH: number; cells: Cell[] }[];
  border: [number, number, number] | null;
  marX: number;
  marY: number;
}

const hex = (v: string | undefined): [number, number, number] | null => {
  if (!v || !/^[0-9a-f]{6}$/i.test(v)) return null;
  return [
    parseInt(v.slice(0, 2), 16) / 255,
    parseInt(v.slice(2, 4), 16) / 255,
    parseInt(v.slice(4, 6), 16) / 255,
  ];
};

const SYM: Record<string, string> = { F06F: '☐', F0A8: '☐', F0FE: '☒', F078: '☒', F0FC: '✓' };

function runText(r: XNode, caps: boolean): string {
  let t = '';
  for (const c of r.children) {
    if (typeof c === 'string') continue;
    if (c.name === 'w:t') t += c.children.filter((x) => typeof x === 'string').join('');
    else if (c.name === 'w:tab') t += '    ';
    else if (c.name === 'w:br' && c.attrs['w:type'] !== 'page') t += '\n';
    else if (c.name === 'w:sym') t += SYM[(c.attrs['w:char'] ?? '').toUpperCase()] ?? '';
    else if (c.name === 'w:noBreakHyphen') t += '-';
  }
  return caps ? t.toUpperCase() : t;
}

function parsePara(p: XNode): Para {
  const pPr = child(p, 'w:pPr');
  const jc = val(child(pPr, 'w:jc'));
  const sp = child(pPr, 'w:spacing');
  const bottom = child(child(pPr, 'w:pBdr'), 'w:bottom');
  const runs: Run[] = [];
  let pageBreak = false;
  const collect = (n: XNode) => {
    for (const r of kids(n)) {
      if (r.name === 'w:r') {
        if (kids(r, 'w:br').some((b) => b.attrs['w:type'] === 'page')) pageBreak = true;
        const rPr = child(r, 'w:rPr');
        const b = child(rPr, 'w:b');
        const caps = !!child(rPr, 'w:caps') && val(child(rPr, 'w:caps')) !== '0';
        const sz = val(child(rPr, 'w:sz'));
        const text = runText(r, caps);
        if (text)
          runs.push({
            text,
            bold: !!b && val(b) !== '0' && val(b) !== 'false',
            color: hex(val(child(rPr, 'w:color'))),
            size: sz ? Number(sz) / 2 : null,
          });
      } else if (
        ['w:hyperlink', 'w:ins', 'w:smartTag', 'w:sdt', 'w:sdtContent', 'w:fldSimple'].includes(r.name)
      ) {
        collect(r);
      }
    }
  };
  collect(p);
  return {
    kind: 'p',
    runs,
    align: jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : 'left',
    after: Number(sp?.attrs['w:after'] ?? 80) / 20,
    before: Number(sp?.attrs['w:before'] ?? 0) / 20,
    border:
      bottom && val(bottom) !== 'nil' && val(bottom) !== 'none'
        ? (hex(bottom.attrs['w:color']) ?? [0.6, 0.6, 0.6])
        : null,
    bullet: !!child(pPr, 'w:numPr'),
    pageBreak: pageBreak || !!child(pPr, 'w:pageBreakBefore'),
  };
}

function cellParas(tc: XNode): Para[] {
  const out: Para[] = [];
  for (const c of kids(tc)) {
    if (c.name === 'w:p') out.push(parsePara(c));
    else if (c.name === 'w:sdt') out.push(...cellParas(child(c, 'w:sdtContent') ?? c));
    else if (c.name === 'w:tbl') {
      // verschachtelte Tabelle: je Zeile ein Absatz „Zelle | Zelle“
      for (const tr of kids(c, 'w:tr')) {
        const cells = kids(tr, 'w:tc').map((x) =>
          cellParas(x)
            .map((p) => p.runs.map((r) => r.text).join(''))
            .join(' '),
        );
        out.push({
          ...parsePara({ name: 'w:p', attrs: {}, children: [] }),
          runs: [{ text: cells.join('  |  '), bold: false, color: null, size: null }],
        });
      }
    }
  }
  return out;
}

function parseTable(t: XNode): Table {
  const tblPr = child(t, 'w:tblPr');
  const borders = child(tblPr, 'w:tblBorders');
  const ih = child(borders, 'w:insideH') ?? child(borders, 'w:top');
  const hasBorder = !!ih && !['nil', 'none'].includes(val(ih) ?? '');
  const mar = child(tblPr, 'w:tblCellMar');
  const grid = kids(child(t, 'w:tblGrid') ?? { name: '', attrs: {}, children: [] }, 'w:gridCol').map((g) =>
    Number(g.attrs['w:w'] ?? 0),
  );
  const rows = kids(t, 'w:tr').map((tr) => {
    const h = child(child(tr, 'w:trPr'), 'w:trHeight');
    return {
      minH: Number(h?.attrs['w:val'] ?? 0) / 20,
      cells: kids(tr, 'w:tc').map((tc) => {
        const tcPr = child(tc, 'w:tcPr');
        return {
          paras: cellParas(tc),
          fill: hex(child(tcPr, 'w:shd')?.attrs['w:fill']),
          span: Number(val(child(tcPr, 'w:gridSpan')) ?? 1),
        };
      }),
    };
  });
  return {
    kind: 'tbl',
    grid: grid.length ? grid : [1],
    rows,
    border: hasBorder ? (hex(ih!.attrs['w:color']) ?? [0.75, 0.75, 0.75]) : null,
    marX: Number(child(mar, 'w:left')?.attrs['w:w'] ?? 108) / 20,
    marY: Number(child(mar, 'w:top')?.attrs['w:w'] ?? 40) / 20,
  };
}

export function parseDocx(documentXml: string): (Para | Table)[] {
  const doc = parseXml(documentXml);
  const body = child(child(doc, 'w:document'), 'w:body');
  if (!body) return [];
  const out: (Para | Table)[] = [];
  const walk = (n: XNode) => {
    for (const c of kids(n)) {
      if (c.name === 'w:p') out.push(parsePara(c));
      else if (c.name === 'w:tbl') out.push(parseTable(c));
      else if (c.name === 'w:sdt') walk(child(c, 'w:sdtContent') ?? c);
    }
  };
  walk(body);
  return out;
}

/** Größte Schrift in den ersten Absätzen = Titel des Dokuments */
export function docxTitle(blocks: (Para | Table)[]): string | null {
  let best: { t: string; s: number } | null = null;
  for (const b of blocks.slice(0, 8)) {
    if (b.kind !== 'p') continue;
    for (const r of b.runs) {
      const t = r.text.trim();
      if (t && (r.size ?? 0) >= 12 && (!best || (r.size ?? 0) > best.s)) best = { t, s: r.size ?? 0 };
    }
  }
  return best?.t ?? null;
}

const F = 0.9; // Word-Größen etwas kleiner (Inhaltsbereich des Briefpapiers ist kleiner als eine leere A4-Seite)
const DEF = 10;

interface Word {
  t: string;
  w: number;
  size: number;
  bold: boolean;
  color: [number, number, number] | null;
  space: boolean;
  br?: boolean;
}

/** Absatz in Zeilen setzen (Wörter behalten ihre Formatierung) */
function layout(d: FormDoc, p: Para, maxW: number) {
  const words: Word[] = [];
  if (p.bullet)
    words.push({
      t: '•  ',
      w: d.width('•  ', DEF * F),
      size: DEF * F,
      bold: false,
      color: null,
      space: false,
    });
  for (const r of p.runs) {
    const size = (r.size ?? DEF) * F;
    const parts = r.text.split(/(\n| +)/);
    for (const part of parts) {
      if (!part) continue;
      if (part === '\n') {
        words.push({ t: '', w: 0, size, bold: r.bold, color: r.color, space: false, br: true });
        continue;
      }
      words.push({
        t: part,
        w: d.width(part, size, r.bold),
        size,
        bold: r.bold,
        color: r.color,
        space: /^ +$/.test(part),
      });
    }
  }
  const lines: { words: Word[]; w: number; h: number }[] = [];
  let cur: Word[] = [];
  let w = 0;
  const push = () => {
    while (cur.length && cur[cur.length - 1]!.space) w -= cur.pop()!.w;
    const h = Math.max(DEF * F, ...cur.map((x) => x.size)) * 1.22;
    lines.push({ words: cur, w, h });
    cur = [];
    w = 0;
  };
  for (const x of words) {
    if (x.br) {
      push();
      continue;
    }
    if (x.space && !cur.length) continue;
    if (w + x.w > maxW && cur.length) {
      push();
      if (x.space) continue;
    }
    // sehr lange Wörter (Unterstrich-Linien) kürzen
    if (x.w > maxW) {
      let t = x.t;
      while (t.length > 1 && d.width(t, x.size, x.bold) > maxW) t = t.slice(0, -1);
      x.t = t;
      x.w = d.width(t, x.size, x.bold);
    }
    cur.push(x);
    w += x.w;
  }
  if (cur.length || !lines.length) push();
  const size = Math.max(DEF * F, ...p.runs.map((r) => (r.size ?? DEF) * F));
  return { lines, empty: !p.runs.some((r) => r.text.trim()), size };
}

function drawLines(
  d: FormDoc,
  ls: ReturnType<typeof layout>['lines'],
  x: number,
  maxW: number,
  align: Para['align'],
  y0: number,
) {
  let y = y0;
  for (const l of ls) {
    let cx = align === 'center' ? x + (maxW - l.w) / 2 : align === 'right' ? x + maxW - l.w : x;
    for (const wd of l.words) {
      if (!wd.space)
        d.text(wd.t, cx, y + l.h * 0.8, {
          size: wd.size,
          bold: wd.bold,
          ...(wd.color ? { color: rgb(...wd.color) } : {}),
        });
      cx += wd.w;
    }
    y += l.h;
  }
  return y;
}

function paraHeight(d: FormDoc, p: Para, maxW: number) {
  const l = layout(d, p, maxW);
  if (l.empty) return { l, h: Math.min(6, l.size * 0.5) + p.after * F * 0.6 };
  return { l, h: l.lines.reduce((a, x) => a + x.h, 0) + (p.before + p.after) * F * 0.6 + (p.border ? 4 : 0) };
}

/** Dokument in das FormDoc setzen (ab der aktuellen Position; Seitenumbrüche automatisch). */
export function renderDocx(d: FormDoc, blocks: (Para | Table)[]) {
  const { L, R } = FORM_X;
  const { BOTTOM } = FORM_Y;
  const full = R - L;
  for (const b of blocks) {
    if (b.kind === 'p') {
      if (b.pageBreak && d.y > FORM_Y.TOP + 20) d.newPage();
      const { l, h } = paraHeight(d, b, full);
      if (l.empty) {
        if (d.y > FORM_Y.TOP) d.y += h;
        if (b.border) d.line(L, R, d.y, rgb(...b.border), 1);
        continue;
      }
      // Zeile für Zeile, damit lange Absätze umbrechen
      d.y += b.before * F * 0.6;
      for (const line of l.lines) {
        d.ensure(line.h);
        drawLines(d, [line], L, full, b.align, d.y);
        d.y += line.h;
      }
      if (b.border) {
        d.y += 2;
        d.line(L, R, d.y, rgb(...b.border), 1.2);
        d.y += 2;
      }
      d.y += b.after * F * 0.6;
      continue;
    }
    // Tabelle
    const total = b.grid.reduce((a, x) => a + x, 0) || 1;
    const scale = full / total;
    const colX: number[] = [];
    let acc = L;
    for (const g of b.grid) {
      colX.push(acc);
      acc += g * scale;
    }
    colX.push(R);
    const pad = Math.min(6, b.marX * F);
    const padY = Math.min(4, b.marY * F + 1);
    for (const row of b.rows) {
      let gi = 0;
      const cells = row.cells.map((c) => {
        const x0 = colX[Math.min(gi, colX.length - 1)]!;
        gi += c.span;
        const x1 = colX[Math.min(gi, colX.length - 1)]!;
        const inner = Math.max(10, x1 - x0 - pad * 2);
        const laid = c.paras.map((p) => ({ p, ...paraHeight(d, p, inner) }));
        const h = laid.reduce((a, x) => a + x.h, 0);
        return { c, x0, x1, inner, laid, h };
      });
      const rowH = Math.max(row.minH * F, ...cells.map((c) => c.h + padY * 2), 12);
      d.ensure(Math.min(rowH, BOTTOM - FORM_Y.TOP - 10));
      for (const c of cells) {
        if (c.c.fill && !(c.c.fill[0] > 0.99 && c.c.fill[1] > 0.99 && c.c.fill[2] > 0.99))
          d.rect(c.x0, d.y, c.x1 - c.x0, rowH, rgb(...c.c.fill));
        let y = d.y + padY;
        for (const x of c.laid) {
          if (x.l.empty) {
            y += x.h;
            continue;
          }
          y += x.p.before * F * 0.6;
          y = drawLines(d, x.l.lines, c.x0 + pad, c.inner, x.p.align, y);
          y += x.p.after * F * 0.6;
        }
      }
      if (b.border) {
        const col = rgb(...b.border);
        d.line(L, R, d.y, col, 0.5);
        d.line(L, R, d.y + rowH, col, 0.5);
        for (const c of cells) {
          d.page.drawLine({
            start: { x: c.x0, y: FORM_Y.H - d.y },
            end: { x: c.x0, y: FORM_Y.H - d.y - rowH },
            thickness: 0.5,
            color: col,
          });
        }
        d.page.drawLine({
          start: { x: R, y: FORM_Y.H - d.y },
          end: { x: R, y: FORM_Y.H - d.y - rowH },
          thickness: 0.5,
          color: col,
        });
      }
      d.y += rowH;
    }
    d.y += 6;
  }
}
