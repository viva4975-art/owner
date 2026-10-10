/*
 * Mitarbeiter-Vorlagen passend zur Person (Ahmed 10.10.: „zwischen Arbeitnehmer und Arbeitnehmerin unterscheiden“,
 * „bei Unterschrift Arbeitnehmer leichte Schattierung drüber“).
 *
 * - `genderizeXml`: Doppelformen „Der/die Arbeitnehmer/in“, „dem/der“, „er/sie“, „ihm/ihr“ … werden je nach Anrede
 *   (Frau/Herr) zur passenden Form. Ohne Anrede (divers/leer) bleibt die Doppelform stehen.
 * - `shadeEmployeeSignature`: Die leere Unterschriftszeile (Absatz mit Linie unten) über „Unterschrift Arbeitnehmer…“ /
 *   „Mitarbeiter…“ bekommt eine hellgraue Fläche in Unterschriftshöhe – dort unterschreibt die Person.
 *
 * Gearbeitet wird je Absatz auf dem zusammengesetzten Text der Word-Läufe (Formatierung des ersten Laufs bleibt).
 */

const xmlEsc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const xmlUnesc = (s: string) =>
  s.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e]!,
  );

const PARA = /<w:p[ >](?:(?!<w:p[ >])[\s\S])*?<\/w:p>/g;
const T = /(<w:t(?:\s[^>]*)?>)([\s\S]*?)<\/w:t>/g;

/** Text eines Absatzes ersetzen; Treffer, die über mehrere Läufe gehen, landen im Lauf, in dem sie beginnen. */
export function replaceInParagraphs(xml: string, re: RegExp, repl: (m: RegExpMatchArray) => string): string {
  return xml.replace(PARA, (para) => {
    const runs: { start: number; end: number; open: string; text: string }[] = [];
    let m: RegExpExecArray | null;
    const tre = new RegExp(T.source, 'g');
    while ((m = tre.exec(para)))
      runs.push({ start: m.index, end: m.index + m[0].length, open: m[1]!, text: xmlUnesc(m[2]!) });
    if (!runs.length) return para;
    const full = runs.map((r) => r.text).join('');
    const matches = [
      ...full.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)),
    ];
    if (!matches.length) return para;
    const owner: number[] = [];
    const startInRun: number[] = [];
    let offset = 0;
    runs.forEach((r, i) => {
      startInRun[i] = offset;
      offset += r.text.length;
      for (let k = 0; k < r.text.length; k++) owner.push(i);
    });
    const newText = runs.map((r) => r.text.split(''));
    for (const mm of matches.reverse()) {
      if (!mm[0].length) continue;
      const from = mm.index!;
      const to = from + mm[0].length;
      const first = owner[from]!;
      const r = repl(mm);
      for (let i = owner[to - 1]!; i >= first; i--) {
        const rs = startInRun[i]!;
        const a = Math.max(from, rs) - rs;
        const b = Math.min(to, rs + runs[i]!.text.length) - rs;
        newText[i]!.splice(a, b - a, ...(i === first ? [r] : []));
      }
    }
    let out = '';
    let last = 0;
    runs.forEach((r, i) => {
      const t = newText[i]!.join('');
      const open = /xml:space=/.test(r.open) ? r.open : r.open.replace('<w:t', '<w:t xml:space="preserve"');
      out += para.slice(last, r.start) + `${open}${xmlEsc(t)}</w:t>`;
      last = r.end;
    });
    return out + para.slice(last);
  });
}

export type Gender = 'm' | 'f';

/** Anrede → Geschlecht für die Textformen (nur Frau/Herr; sonst bleibt die Doppelform). */
export const genderOf = (salutation: string | null | undefined): Gender | null =>
  /^frau/i.test(salutation ?? '') ? 'f' : /^herr/i.test(salutation ?? '') ? 'm' : null;

const NOUN = '(Arbeitnehmer|Mitarbeiter|Vorarbeiter|Objektleiter|Bewerber|Stelleninhaber|Ansprechpartner)';
const cap = (s: string, like: string) => (/^[A-ZÄÖÜ]/.test(like) ? s[0]!.toUpperCase() + s.slice(1) : s);

export function genderizeXml(xml: string, g: Gender): string {
  const f = g === 'f';
  const rules: [RegExp, (m: RegExpMatchArray) => string][] = [
    // „des Arbeitnehmers/der Arbeitnehmerin“
    [/\b([Dd])es (\p{L}+)s\/der \2in\b/u, (m) => (f ? `${m[1]}er ${m[2]}in` : `${m[1]}es ${m[2]}s`)],
    // „des/der Arbeitnehmer/in“ (Genitiv)
    [
      new RegExp(`\\b([Dd])es/der ${NOUN}/in\\b`, 'u'),
      (m) => (f ? `${m[1]}er ${m[2]}in` : `${m[1]}es ${m[2]}s`),
    ],
    // Artikel und Pronomen (nicht vor Platzhaltern wie „des/der ${Aufhebung.Veranlassung}“)
    [/\b([Dd])es\/der\b(?! \$\{)/u, (m) => cap(f ? 'der' : 'des', m[1]!)],
    [/\b([Dd])er\/die\b(?! \$\{)/u, (m) => cap(f ? 'die' : 'der', m[1]!)],
    [/\b([Dd])en\/die\b(?! \$\{)/u, (m) => cap(f ? 'die' : 'den', m[1]!)],
    [/\b([Dd])em\/der\b(?! \$\{)/u, (m) => cap(f ? 'der' : 'dem', m[1]!)],
    [/\b([Ee])r\/sie\b/u, (m) => cap(f ? 'sie' : 'er', m[1]!)],
    [/\b([Ii])hm\/ihr\b/u, (m) => cap(f ? 'ihr' : 'ihm', m[1]!)],
    [/\b([Ii])hn\/sie\b/u, (m) => cap(f ? 'sie' : 'ihn', m[1]!)],
    [
      /\b([Ss])ein(e[mnrs]?)?\/ihr(e[mnrs]?)?\b/u,
      (m) => cap(f ? `ihr${m[3] ?? ''}` : `sein${m[2] ?? ''}`, m[1]!),
    ],
    [/\bNeue\/r\b/u, () => (f ? 'Neue' : 'Neuer')],
    [/\b([Ee])rste\/r\b/u, (m) => cap(f ? 'erste' : 'erster', m[1]!)],
    [/\bBeauftragte\/r\b/u, () => (f ? 'Beauftragte' : 'Beauftragter')],
    [/\b(VORARBEITER|ARBEITNEHMER|MITARBEITER|OBJEKTLEITER)\/IN\b/u, (m) => (f ? `${m[1]}IN` : m[1]!)],
    // Bezeichnungen „Arbeitnehmer/in“ (nicht die Mehrzahl „…/innen“)
    [new RegExp(`\\b${NOUN}/in\\b(?!nen)`, 'u'), (m) => (f ? `${m[1]}in` : m[1]!)],
  ];
  let out = xml;
  for (const [re, fn] of rules) out = replaceInParagraphs(out, re, fn);
  return out;
}

const SIG_LABEL = /(Arbeitnehmer|Mitarbeiter)(in|\/in)?\b/u;
const SHADE = '<w:shd w:val="clear" w:color="auto" w:fill="EEEBED"/>';

/** Leere Linie über der Unterschrift der Arbeitnehmerin / des Arbeitnehmers hellgrau hinterlegen, in Unterschriftshöhe. */
export function shadeEmployeeSignature(xml: string): string {
  const paras = [...xml.matchAll(PARA)];
  const text = (p: string) =>
    xmlUnesc([...p.matchAll(new RegExp(T.source, 'g'))].map((m) => m[2]).join('')).trim();
  const edits: { start: number; end: number; repl: string }[] = [];
  for (let i = 1; i < paras.length; i++) {
    const label = text(paras[i]![0]);
    if (!label || label.length > 140 || !SIG_LABEL.test(label)) continue;
    const prev = paras[i - 1]!;
    const between = xml.slice(prev.index! + prev[0].length, paras[i]!.index);
    if (between.trim()) continue; // nicht direkt davor (z. B. andere Zelle)
    const p = prev[0];
    if (text(p) || p.includes('<w:shd ')) continue;
    // Linie unter dem leeren Absatz – oder Linie über der Beschriftung (leerer Absatz davor = Unterschriftsfeld)
    const lineBelow = /<w:pBdr>[\s\S]*?<w:bottom /.test(p);
    const lineAbove = /<w:pBdr>[\s\S]*?<w:top /.test(paras[i]![0]) && !/<w:pBdr>/.test(p);
    if (!lineBelow && !lineAbove) continue;
    let np = lineBelow
      ? p.replace(/(<w:pBdr>[\s\S]*?<\/w:pBdr>)/, `$1${SHADE}`)
      : /<w:pPr>/.test(p)
        ? p.replace(/<w:pPr>(<w:pStyle [^>]*\/>|<w:keepNext\/>|<w:keepLines\/>)*/, (m) => m + SHADE)
        : p.replace(/^<w:p([ >])/, `<w:p$1`).replace(/^(<w:p[^>]*>)/, `$1<w:pPr>${SHADE}</w:pPr>`);
    // Höhe für die Unterschrift: genaue Zeilenhöhe (Fläche liegt über der Linie)
    np = /<w:spacing [^>]*\/>/.test(np)
      ? np.replace(
          /<w:spacing [^>]*\/>/,
          '<w:spacing w:before="120" w:after="34" w:line="640" w:lineRule="exact"/>',
        )
      : np.replace(SHADE, `${SHADE}<w:spacing w:before="120" w:after="34" w:line="640" w:lineRule="exact"/>`);
    edits.push({ start: prev.index!, end: prev.index! + p.length, repl: np });
  }
  let out = xml;
  for (const e of edits.reverse()) out = out.slice(0, e.start) + e.repl + out.slice(e.end);
  return alignSignatureRows(shadeSignatureRows(out));
}

const EXACT = '<w:spacing w:before="120" w:after="34" w:line="640" w:lineRule="exact"/>';

/** In einer Zeile mit hinterlegtem Feld die anderen Unterschriftsfelder gleich hoch machen (Linien auf einer Höhe). */
function alignSignatureRows(xml: string): string {
  return xml.replace(TR, (row) => {
    if (!row.includes('EEEBED') || !row.includes('w:line="640"')) return row;
    return row.replace(
      /(<w:p>(?:<w:pPr>(?:(?!<\/w:pPr>)[\s\S])*<\/w:pPr>)?<\/w:p>)(<w:p><w:pPr><w:pBdr><w:top )/g,
      (m, empty: string, next: string) => {
        if (empty.includes('w:line="640"')) return m;
        const e = /<w:spacing [^>]*\/>/.test(empty)
          ? empty.replace(/<w:spacing [^>]*\/>/, EXACT)
          : empty.replace('<w:p>', `<w:p><w:pPr>${EXACT}</w:pPr>`).replace('<w:pPr><w:pPr>', '<w:pPr>');
        return e + next;
      },
    );
  });
}

const TR = /<w:tr[ >](?:(?!<w:tr[ >])[\s\S])*?<\/w:tr>/g;
const TC = /<w:tc[ >][\s\S]*?<\/w:tc>/g;

/**
 * Unterschriftsblock als Tabelle (Linie = obere Zellenlinie, Beschriftung darunter): neue Zeile darüber, nur über der
 * Zelle der Arbeitnehmerin / des Arbeitnehmers hellgrau – das Feld zum Unterschreiben.
 */
function shadeSignatureRows(xml: string): string {
  const text = (p: string) =>
    xmlUnesc([...p.matchAll(new RegExp(T.source, 'g'))].map((m) => m[2]).join('')).trim();
  return xml.replace(TR, (row: string, offset: number, whole: string) => {
    if (row.includes('EEEBED')) return row;
    // schon eingefügt (direkt davor steht die hinterlegte Zeile)
    const before = whole.slice(Math.max(0, offset - 1500), offset);
    if (before.endsWith('</w:tr>') && before.slice(before.lastIndexOf('<w:tr>')).includes('EEEBED'))
      return row;
    const cells = [...row.matchAll(TC)].map((m) => m[0]);
    if (!cells.length) return row;
    const isSig = (c: string) => {
      const t = text(c);
      return (
        t.length < 140 &&
        SIG_LABEL.test(t) &&
        /<w:tcBorders>[\s\S]*?<w:top w:val="(single|thick|double)"/.test(c) &&
        !/arbeitgeber/i.test(t)
      );
    };
    if (!cells.some(isSig)) return row;
    const newCells = cells
      .map((c) => {
        const w = /<w:tcW [^>]*\/>/.exec(c)?.[0] ?? '';
        const span = /<w:gridSpan [^>]*\/>/.exec(c)?.[0] ?? '';
        const shd = isSig(c) ? SHADE : '';
        return `<w:tc><w:tcPr>${w}${span}${shd}</w:tcPr><w:p><w:pPr><w:keepNext/><w:spacing w:before="0" w:after="0"/></w:pPr></w:p></w:tc>`;
      })
      .join('');
    return `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="640" w:hRule="exact"/></w:trPr>${newCells}</w:tr>${row}`;
  });
}
