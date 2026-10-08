/*
 * Kästchen (☐, Word-Kontrollkästchen w14:checkbox) und Lücken („______“) in Word-Vorlagen (Ahmed 08.10.: „viele Felder
 * werden nicht ausgefüllt, Kästchen wie Schwerbehinderung ankreuzen“). Die Ausfüll-Seite zeigt jedes Kästchen und jede
 * Lücke mit dem Text daneben; beim Erzeugen wird angekreuzt bzw. der Text in die Lücke geschrieben. Reihenfolge = Position
 * im Dokument (Index stabil, solange die Vorlage gleich bleibt).
 */

export interface FormField {
  kind: 'box' | 'blank';
  index: number;
  /** Text daneben (für die Anzeige) */
  label: string;
  /** Text davor im selben Absatz (z. B. „Grad:“ vor einer Lücke) */
  before: string;
  checked?: boolean;
}

const unesc = (s: string) =>
  s.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e]!,
  );
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const plain = (xml: string) =>
  unesc(
    xml
      .replace(/<w:tab\/>/g, ' ')
      .replace(/<\/w:tc>/g, ' · ')
      .replace(/<[^>]+>/g, ''),
  );

const TOKEN =
  /(<w:sdt>(?:(?!<w:sdt[ >])(?!<\/w:sdt>)[\s\S])*?<\/w:sdt>)|(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g;
const BOXCHAR = /[☐☒]/;
const PIECE = /[☐☒]|_{4,}/g;

/** Ort eines Kästchens/einer Lücke: Element im XML (Start/Ende) und Text davor/danach im selben Lauf */
interface Where {
  pos: number;
  end: number;
  pre: string;
  post: string;
}
type OnBox = (i: number, checked: boolean, w: Where) => boolean | undefined;
type OnBlank = (i: number, w: Where) => string | undefined;

/** Ein Durchlauf über document.xml; Rückgabewerte der Rückrufe ändern das XML. */
function scan(xml: string, onBox: OnBox, onBlank: OnBlank): string {
  let box = 0;
  let blank = 0;
  return xml.replace(
    TOKEN,
    (m, sdt: string | undefined, open: string, text: string, close: string, pos: number) => {
      if (sdt) {
        if (!/<w14:checkbox>/.test(sdt)) {
          // anderes Inhaltssteuerelement: Text darin normal behandeln
          const inner = sdt.slice('<w:sdt>'.length, -'</w:sdt>'.length);
          const shift = (w: Where): Where => ({ ...w, pos: pos + 7 + w.pos, end: pos + 7 + w.end });
          return `<w:sdt>${scan(
            inner,
            (_i, c, w) => onBox(box++, c, shift(w)),
            (_i, w) => onBlank(blank++, shift(w)),
          )}</w:sdt>`;
        }
        const checked = /<w14:checked w(?:14)?:val="(1|true)"\s*\/>/.test(sdt);
        const want = onBox(box++, checked, { pos, end: pos + sdt.length, pre: '', post: '' });
        if (want === undefined || want === checked) return sdt;
        const val = want ? '1' : '0';
        const attr = /<w14:checked w:val=/.test(sdt) ? 'w:val' : 'w14:val';
        let out = /<w14:checked [^>]*\/>/.test(sdt)
          ? sdt.replace(/<w14:checked [^>]*\/>/, `<w14:checked ${attr}="${val}"/>`)
          : sdt.replace('<w14:checkbox>', `<w14:checkbox><w14:checked w14:val="${val}"/>`);
        out = out.replace(
          /(<w:sdtContent>[\s\S]*?<w:t(?:\s[^>]*)?>)[☐☒](<\/w:t>)/,
          `$1${want ? '☒' : '☐'}$2`,
        );
        return out;
      }
      const t = unesc(text);
      if (!BOXCHAR.test(t) && !/_{4,}/.test(t)) return m;
      let changed = false;
      const end = pos + m.length;
      const nt = t.replace(PIECE, (piece: string, off: number) => {
        const w = { pos, end, pre: t.slice(0, off), post: t.slice(off + piece.length) };
        if (piece === '☐' || piece === '☒') {
          const want = onBox(box++, piece === '☒', w);
          if (want === undefined) return piece;
          changed = true;
          return want ? '☒' : '☐';
        }
        const v = onBlank(blank++, w);
        if (v === undefined || v === '') return piece;
        changed = true;
        return v;
      });
      if (!changed) return m;
      const o = /xml:space=/.test(open) ? open : open.replace('<w:t', '<w:t xml:space="preserve"');
      return `${o}${esc(nt)}${close}`;
    },
  );
}

/** Text vor/nach dem Kästchen im selben Absatz; ohne Text daneben der Text davor im Dokument (Tabellen: Spalte links). */
function context(xml: string, w: Where) {
  const pStart = Math.max(0, xml.lastIndexOf('<w:p', w.pos));
  const pEndRaw = xml.indexOf('</w:p>', w.end);
  const pEnd = pEndRaw < 0 ? xml.length : pEndRaw;
  const after = (w.post + plain(xml.slice(w.end, pEnd)))
    .split(/[☐☒]|_{4,}/)[0]!
    .replace(/\s+/g, ' ')
    .replace(/^[\s·]+|[\s·]+$/g, '');
  const before = (plain(xml.slice(pStart, w.pos)) + w.pre)
    .split(/[☐☒]|_{4,}/)
    .pop()!
    .replace(/\s+/g, ' ')
    .replace(/^[\s·]+|[\s·]+$/g, '');
  let label = after;
  if (label.length < 3) {
    const prev = plain(xml.slice(Math.max(0, w.pos - 6000), w.pos))
      .replace(/\s+/g, ' ')
      .replace(/[☐☒·\s]+$/g, '')
      .trim();
    label = before.length >= 3 ? before : prev.slice(-90).replace(/^.*[·]\s*/, '');
  }
  return { label: label.replace(/_{4,}/g, '…').slice(0, 160), before: before.slice(-60) };
}

export function formFieldsOf(documentXml: string): FormField[] {
  const out: FormField[] = [];
  scan(
    documentXml,
    (i, checked, w) => {
      out.push({ kind: 'box', index: i, checked, ...context(documentXml, w) });
      return undefined;
    },
    (i, w) => {
      out.push({ kind: 'blank', index: i, ...context(documentXml, w) });
      return undefined;
    },
  );
  return out;
}

export function applyFormFields(
  documentXml: string,
  boxes: Record<number, boolean>,
  blanks: Record<number, string>,
): string {
  return scan(
    documentXml,
    (i) => (i in boxes ? boxes[i] : undefined),
    (i) => blanks[i],
  );
}

/**
 * Vorbelegung aus den Stammdaten anhand des Texts neben dem Kästchen (nur, was sicher bekannt ist):
 * Beschäftigungsart, befristet/unbefristet, ungekündigt. Rückgabe: Index → angekreuzt.
 */
export function defaultBoxes(fields: FormField[], v: Record<string, string>): Record<number, boolean> {
  const out: Record<number, boolean> = {};
  const art = (v['Mitarbeiter.Beschäftigungsart'] ?? '').toLowerCase();
  const exit = v['Mitarbeiter.Austrittsdatum'] ?? '';
  if (!('Mitarbeiter.Vorname' in v)) return out;
  for (const f of fields) {
    if (f.kind !== 'box') continue;
    const l = f.label.toLowerCase();
    if (/^vollzeit\b/.test(l)) out[f.index] = art === 'vollzeit';
    else if (/^teilzeit\b/.test(l)) out[f.index] = art === 'teilzeit';
    else if (/^(geringfügig|minijob)/.test(l)) out[f.index] = art === 'minijob';
    else if (/^unbefristet\b/.test(l)) out[f.index] = !exit;
    else if (/^befristet bis/.test(l)) out[f.index] = !!exit;
    else if (/^ungekündigt/.test(l)) out[f.index] = !exit;
  }
  return out;
}

/** Lücken-Vorbelegung: „befristet bis ____“ → Austrittsdatum. */
export function defaultBlanks(fields: FormField[], v: Record<string, string>): Record<number, string> {
  const out: Record<number, string> = {};
  const exit = v['Mitarbeiter.Austrittsdatum'] ?? '';
  for (const f of fields)
    if (f.kind === 'blank' && exit && /(befristet bis|gekündigt zum)$/i.test(f.before)) out[f.index] = exit;
  return out;
}
