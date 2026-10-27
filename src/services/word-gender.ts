/*
 * Mitarbeiter-Vorlagen passend zur Person (Ahmed 10.10.: „zwischen Arbeitnehmer und Arbeitnehmerin unterscheiden“,
 * „bei Unterschrift Arbeitnehmer leichte Schattierung drüber“; seit 27.10.: „wieder auf Linie, nur den Namen gelb“).
 *
 * - `genderizeXml`: Doppelformen „Der/die Arbeitnehmer/in“, „dem/der“, „er/sie“, „ihm/ihr“ … werden je nach Anrede
 *   (Frau/Herr) zur passenden Form. Ohne Anrede (divers/leer) bleibt die Doppelform stehen.
 * - `markEmployeeSignature`: Unter der Unterschriftslinie der Person steht „Unterschrift Arbeitnehmer…“ /
 *   „Mitarbeiter…“ – diese Beschriftung wird gelb markiert (die Linie bleibt wie in der Vorlage, keine Fläche).
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
const HL = '<w:highlight w:val="yellow"/>';
// Elemente, die in w:rPr nach w:highlight kommen müssen (Schema-Reihenfolge, sonst meldet Word „unlesbarer Inhalt“)
const AFTER_HL =
  /<w:(u|effect|bdr|shd|fitText|vertAlign|rtl|cs|em|lang|eastAsianLayout|specVanish|oMath)[ />]/;

/** Alle Läufe eines Absatzes bzw. einer Zelle gelb markieren */
function highlightRuns(xml: string): string {
  return xml.replace(/<w:r(?: [^>]*)?>[\s\S]*?<\/w:r>/g, (r) => {
    if (!/<w:t[ >]/.test(r) || r.includes('<w:highlight ')) return r;
    if (!r.includes('<w:rPr>')) return r.replace(/^(<w:r(?: [^>]*)?>)/, `$1<w:rPr>${HL}</w:rPr>`);
    return r.replace(/<w:rPr>([\s\S]*?)<\/w:rPr>/, (_m, inner: string) => {
      const k = AFTER_HL.exec(inner);
      const n = k ? inner.slice(0, k.index) + HL + inner.slice(k.index) : inner + HL;
      return `<w:rPr>${n}</w:rPr>`;
    });
  });
}

/** Ab dem Lauf mit `word` markieren (davor stehendes „München, den …“ nicht); Lauf wird dafür geteilt. */
function highlightFrom(p: string, word: string): string {
  let on = false;
  return p.replace(/<w:r(?: [^>]*)?>[\s\S]*?<\/w:r>/g, (r) => {
    if (on) return highlightRuns(r);
    const m = /(<w:t(?:\s[^>]*)?>)([\s\S]*?)<\/w:t>/.exec(r);
    const k = m ? m[2]!.indexOf(word) : -1;
    if (!m || k < 0) return r;
    on = true;
    if (k === 0) return highlightRuns(r);
    const head = r.replace(m[0], `<w:t xml:space="preserve">${m[2]!.slice(0, k)}</w:t>`);
    const tail = r.replace(m[0], `<w:t xml:space="preserve">${m[2]!.slice(k)}</w:t>`);
    return head + highlightRuns(tail);
  });
}

/**
 * Beschriftung unter der Unterschriftslinie der Arbeitnehmerin / des Arbeitnehmers gelb markieren – dort unterschreibt die
 * Person. Erkannt wie bisher: Absatz mit Linie darüber (leerer Absatz mit Linie unten bzw. Linie oben an der Beschriftung)
 * oder Tabellenzelle mit oberer Linie. Arbeitgeber/Geschäftsführung bleiben unmarkiert.
 */
export function markEmployeeSignature(xml: string): string {
  const paras = [...xml.matchAll(PARA)];
  const text = (p: string) =>
    xmlUnesc([...p.matchAll(new RegExp(T.source, 'g'))].map((m) => m[2]).join('')).trim();
  const edits: { start: number; end: number; repl: string }[] = [];
  for (let i = 1; i < paras.length; i++) {
    const lp = paras[i]![0];
    const label = text(lp);
    if (!label || label.length > 140 || !SIG_LABEL.test(label) || /arbeitgeber/i.test(label)) continue;
    // Linie als Unterstriche in derselben Zeile: „Unterschrift Arbeitnehmer/in: ______“
    if (/Unterschrift[^:_]*(Arbeitnehmer|Mitarbeiter)[^:_]*:\s*_{3,}/u.test(label)) {
      edits.push({
        start: paras[i]!.index!,
        end: paras[i]!.index! + lp.length,
        repl: highlightFrom(lp, 'Unterschrift'),
      });
      continue;
    }
    const prev = paras[i - 1]!;
    const between = xml.slice(prev.index! + prev[0].length, paras[i]!.index);
    if (between.trim()) continue; // nicht direkt davor (z. B. andere Zelle)
    const p = prev[0];
    if (text(p)) continue;
    const lineBelow = /<w:pBdr>[\s\S]*?<w:bottom /.test(p);
    const lineAbove = /<w:pBdr>[\s\S]*?<w:top /.test(lp);
    if (!lineBelow && !lineAbove) continue;
    edits.push({ start: paras[i]!.index!, end: paras[i]!.index! + lp.length, repl: highlightRuns(lp) });
  }
  let out = xml;
  for (const e of edits.reverse()) out = out.slice(0, e.start) + e.repl + out.slice(e.end);
  return markSignatureCells(out);
}

const TR = /<w:tr[ >](?:(?!<w:tr[ >])[\s\S])*?<\/w:tr>/g;
const TC = /<w:tc[ >][\s\S]*?<\/w:tc>/g;

/** Unterschriftsblock als Tabelle (Linie = obere Zellenlinie, Beschriftung darunter): Beschriftung der Person gelb. */
function markSignatureCells(xml: string): string {
  const text = (p: string) =>
    xmlUnesc([...p.matchAll(new RegExp(T.source, 'g'))].map((m) => m[2]).join('')).trim();
  return xml.replace(TR, (row: string) =>
    row.replace(TC, (c) => {
      const t = text(c);
      const sig =
        t.length < 140 &&
        SIG_LABEL.test(t) &&
        !/arbeitgeber/i.test(t) &&
        /<w:tcBorders>[\s\S]*?<w:top w:val="(single|thick|double)"/.test(c);
      return sig ? highlightRuns(c) : c;
    }),
  );
}

/**
 * Festgehalt (Ahmed 10.10.: „bei Leuten mit Gehalt soll ein anderer Satz nur mit Gehalt stehen“): Der Stundenlohn-Satz
 * der Arbeitsverträge wird durch das Monatsgehalt ersetzt.
 */
export function salaryClause(xml: string): string {
  return replaceInParagraphs(
    xml,
    /erhält (?:den Tariflohn|einen Stundenlohn|den Stundenlohn) von (?:derzeit )?\$\{Mitarbeiter\.Stundenlohn\} EUR brutto pro Stunde\./u,
    () => 'erhält ein festes monatliches Bruttogehalt in Höhe von ${Mitarbeiter.Gehalt} EUR.',
  );
}
