/*
 * Kästchen (☐, Word-Kontrollkästchen w14:checkbox) und Lücken („______“) in Word-Vorlagen (Ahmed 08.10.: „viele Felder
 * werden nicht ausgefüllt, Kästchen wie Schwerbehinderung ankreuzen“). Die Ausfüll-Seite zeigt jedes Kästchen und jede
 * Lücke mit dem Text daneben; beim Erzeugen wird angekreuzt bzw. der Text in die Lücke geschrieben. Reihenfolge = Position
 * im Dokument (Index stabil, solange die Vorlage gleich bleibt).
 */

export interface FormField {
  kind: 'box' | 'blank' | 'cell';
  index: number;
  /** Text daneben (für die Anzeige) */
  label: string;
  /** Text davor im selben Absatz (z. B. „Grad:“ vor einer Lücke) */
  before: string;
  checked?: boolean;
  /** Überschrift im Dokument, unter der das Feld steht (z. B. „Datenschutzinformation · Teil B – …“) */
  group?: string;
  /** Teil der Vorlage („Teil A – Gilt für alle“, „Teil C – Zusatzmodule …“), falls die Vorlage so gegliedert ist */
  part?: string | undefined;
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
  // Kästchen allein in einer Tabellenzelle: Beschriftung steht in der Zelle rechts daneben (gleiche Zeile)
  if (label.length < 3 && xml.lastIndexOf('<w:tc>', w.pos) > xml.lastIndexOf('</w:tc>', w.pos)) {
    const tcEnd = xml.indexOf('</w:tc>', w.end);
    const trEnd = xml.indexOf('</w:tr>', w.end);
    const nextEnd = tcEnd < 0 ? -1 : xml.indexOf('</w:tc>', tcEnd + 7);
    if (tcEnd >= 0 && nextEnd >= 0 && nextEnd < trEnd) {
      const right = plain(xml.slice(tcEnd + 7, nextEnd))
        .split(/[☐☒]|_{4,}/)[0]!
        .replace(/\s+/g, ' ')
        .replace(/^[\s·]+|[\s·]+$/g, '');
      if (right.length >= 2) label = right;
    }
  }
  if (label.length < 3) {
    const prev = plain(xml.slice(Math.max(0, w.pos - 6000), w.pos))
      .replace(/\s+/g, ' ')
      .replace(/[☐☒·\s]+$/g, '')
      .trim();
    label = before.length >= 3 ? before : prev.slice(-90).replace(/^.*[·]\s*/, '');
  }
  label = label.replace(/_{4,}/g, '…');
  // lange Texte nicht mitten im Wort abschneiden (Ahmed 20.10.: „… über Wh“)
  if (label.length > 400) label = `${label.slice(0, 400).replace(/\s+\S*$/, '')} …`;
  return { label, before: before.slice(-60) };
}

/*
 * Leere Felder ohne Linie (Ahmed 12.10.: „Personalstammblatt muss ausgefüllt werden“): leere Tabellenzelle rechts neben
 * einer Beschriftung („Name | ___“, „IBAN | ___“) und Zeilen „Ort, Datum:“ ohne Inhalt. Index = Reihenfolge im Dokument.
 */
const ROW = /<w:tr[ >](?:(?!<w:tr[ >])[\s\S])*?<\/w:tr>/g;
const CELL = /<w:tc>[\s\S]*?<\/w:tc>/g;
const cellText = (c: string) =>
  plain(c.replace(/<\/w:tc>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
/** Beschriftung, neben der eine Eingabe erwartet wird (keine laufende Nummer, kein Preis, keine Unterschrift) */
const isLabel = (t: string) =>
  t.length >= 2 &&
  t.length <= 80 &&
  !/^[\d.,\s€%]+$/.test(t) &&
  !/[☐☒]/.test(t) &&
  !/\$\{/.test(t) &&
  !/unterschrift|stempel/i.test(t);
const ORT_DATUM = /^(Ort,? Datum):?\s*$/i;

type OnCell = (i: number, label: string) => string | undefined;

function scanCells(xml: string, on: OnCell): string {
  let n = 0;
  // erst Tabellenzeilen, dann freie Zeilen „Ort, Datum:“ – Reihenfolge fest, damit die Indizes stabil bleiben
  let out = xml.replace(ROW, (row) => {
    if (/<w:tbl>/.test(row)) return row; // verschachtelte Tabelle: nicht anfassen
    const cells = row.match(CELL) ?? [];
    let changed = false;
    const repl = cells.map((c, i) => {
      if (i === 0 || cellText(c) || /<w14:checkbox>/.test(c)) return c;
      const label = cellText(cells[i - 1]!);
      if (!isLabel(label)) return c;
      const v = on(n++, label);
      if (!v) return c;
      changed = true;
      // Leerzeichen-Läufe der leeren Zelle entfernen, sonst steht der Wert eingerückt
      return insertRun(c.replace(/(<w:t(?:\s[^>]*)?>)\s+(<\/w:t>)/g, '$1$2'), v);
    });
    if (!changed) return row;
    let k = 0;
    return row.replace(CELL, () => repl[k++]!);
  });
  out = out.replace(/<w:p[ >](?:(?!<w:p[ >])[\s\S])*?<\/w:p>/g, (p) => {
    const t = plain(p).trim();
    const m = ORT_DATUM.exec(t);
    if (!m || /<w:tc>/.test(p)) return p;
    const v = on(n++, m[1]!);
    if (!v) return p;
    // Leerzeichen-Läufe hinter „Ort, Datum:“ entfernen, damit der Wert direkt dahinter steht
    const trimmed = p
      .replace(/(<w:t(?:\s[^>]*)?>)\s+(<\/w:t>)/g, '$1$2')
      .replace(/(<w:t(?:\s[^>]*)?>)([^<]*?:)\s+(<\/w:t>)/g, '$1$2$3');
    return insertRun(trimmed, ` ${v}`, true);
  });
  return out;
}

/** Text als Lauf ans Ende des ersten Absatzes (Formatierung des Absatzzeichens), Zeilenumbrüche als <w:br/>. */
function insertRun(xml: string, value: string, appendToLast = false): string {
  const end = appendToLast ? xml.lastIndexOf('</w:p>') : xml.indexOf('</w:p>');
  if (end < 0) return xml;
  const pStart = xml.lastIndexOf('<w:p', end);
  const ppr = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(xml.slice(pStart, end))?.[0] ?? '';
  // Formatierung: Absatzzeichen, sonst letzter Lauf im Absatz
  const rpr =
    /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(ppr)?.[0] ??
    [...xml.slice(pStart, end).matchAll(/<w:r>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/g)].pop()?.[1] ??
    '';
  const body = value
    .split('\n')
    .map((l) => `<w:t xml:space="preserve">${esc(l)}</w:t>`)
    .join('<w:br/>');
  return `${xml.slice(0, end)}<w:r>${rpr.replace(/<w:(vanish|strike)\/>/g, '')}${body}</w:r>${xml.slice(end)}`;
}

/**
 * Überschriften der Vorlage mit Position (Ahmed 20.10.: „übersichtlicher mit Miniüberschrift“): fette Absätze mit
 * Überschriften-Format bzw. großer Schrift, nummerierte Abschnitte („1  Vertragsunterlagen“) und Fragen.
 * level 1 = Dokumenttitel (z. B. „ARBEITSVERTRAG“), level 2 = Abschnitt.
 */
function headingsOf(xml: string): { pos: number; level: 1 | 2; text: string }[] {
  const out: { pos: number; level: 1 | 2; text: string }[] = [];
  for (const m of xml.matchAll(/<w:p[ >](?:(?!<\/w:p>)[\s\S])*<\/w:p>/g)) {
    const p = m[0];
    const text = unesc([...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(''))
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length < 3 || text.length > 90 || /\$\{|[☐☒]|_{4,}/.test(text)) continue;
    // Gliederung von Unterweisungen: „Teil A – …“, „A1 Brandschutz und Notfall“
    if (/^(Teil\s+[A-Z]\b|[A-Z]\d{1,2}\s+\p{L})/u.test(text) && !/[.:;]$/.test(text)) {
      out.push({ pos: m.index, level: 2, text });
      continue;
    }
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? '';
    const bold = /<w:b\/>|<w:b w:val="(1|true)"\/>/.test(p);
    const size = Number(/<w:sz w:val="(\d+)"/.exec(p)?.[1] ?? 0);
    if (/^(Title|Titel)/i.test(style) || (bold && size >= 30)) out.push({ pos: m.index, level: 1, text });
    else if (
      /heading|berschrift/i.test(style) ||
      (bold && (size >= 22 || /^\d+\s+\S/.test(text) || /\?$/.test(text)))
    )
      out.push({ pos: m.index, level: 2, text });
  }
  return out;
}

function partAt(heads: ReturnType<typeof headingsOf>, pos: number): string | undefined {
  let part: string | undefined;
  for (const h of heads) {
    if (h.pos > pos) break;
    if (h.level === 1) part = undefined;
    else if (/^Teil\s+[A-Z]\b/.test(h.text)) part = h.text;
  }
  return part;
}

/** Teil gilt für alle (nicht „Zusatzmodule, nur bei zutreffender Tätigkeit“) → Kästchen vorab ankreuzen. */
export const generalPart = (part: string | undefined) =>
  !!part && !/zusatz|nur bei|optional|falls|wahlweise|freiwillig|einwillig/i.test(part);

function groupAt(heads: ReturnType<typeof headingsOf>, pos: number): string {
  let doc: string | undefined;
  let sec: string | undefined;
  for (const h of heads) {
    if (h.pos > pos) break;
    if (h.level === 1) {
      doc = h.text;
      sec = undefined;
    } else sec = h.text.replace(/^(§?\s*\d+)\s+/, '$1 ');
  }
  return [doc, sec].filter(Boolean).join(' · ');
}

export function formFieldsOf(documentXml: string): FormField[] {
  const out: FormField[] = [];
  const heads = headingsOf(documentXml);
  scanCells(documentXml, (i, label) => {
    out.push({ kind: 'cell', index: i, label, before: label });
    return undefined;
  });
  scan(
    documentXml,
    (i, checked, w) => {
      out.push({
        kind: 'box',
        index: i,
        checked,
        ...context(documentXml, w),
        group: groupAt(heads, w.pos),
        part: partAt(heads, w.pos),
      });
      return undefined;
    },
    (i, w) => {
      out.push({ kind: 'blank', index: i, ...context(documentXml, w), group: groupAt(heads, w.pos) });
      return undefined;
    },
  );
  return out;
}

export function applyFormFields(
  documentXml: string,
  boxes: Record<number, boolean>,
  blanks: Record<number, string>,
  cells: Record<number, string> = {},
): string {
  // Zellen zuerst: Kästchen/Lücken ändern nur Text in nicht leeren Zellen, die Zell-Indizes bleiben gleich
  const withCells = Object.keys(cells).length ? scanCells(documentXml, (i) => cells[i]) : documentXml;
  return scan(
    withCells,
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
  const school = v['Mitarbeiter.Schulobjekt'] ?? '';
  // Unterweisung (Ahmed 21.10.): Themen der Teile „für alle“ ankreuzen, Zusatzmodule nicht
  for (const f of fields)
    if (f.kind === 'box' && generalPart(f.part) && f.label.length >= 3 && !/:$/.test(f.label))
      out[f.index] = true;
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
    // Anlage 3 Schulobjekte: nur, wenn Objekte bekannt sind (Zuordnung oder Einsatzplan)
    else if (school && /^ja, einsatz in schulobjekten/.test(l)) out[f.index] = school === 'ja';
    else if (school && /^nein – kein einsatz in schulobjekten/.test(l)) out[f.index] = school === 'nein';
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

/** Beschriftung vereinfachen: „E-Mail / Notfallkontakt“ → „e mail notfallkontakt“ */
export const normLabel = (l: string) =>
  l
    .toLowerCase()
    .replace(/[–—]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Vorbelegung leerer Felder neben Beschriftungen aus den Stammdaten (Ahmed 12.10.: „es muss alles ausgefüllt werden“).
 * Was die App nicht weiß (z. B. Kennzeichen, Rückgabe), bleibt leer und kann auf der Ausfüll-Seite eingetragen werden.
 */
export function defaultCells(fields: FormField[], v: Record<string, string>): Record<number, string> {
  const g = (k: string) => (v[k] ?? '').trim();
  const join = (sep: string, ...xs: string[]) => xs.filter(Boolean).join(sep);
  const emp = 'Mitarbeiter.Vorname' in v;
  const site = 'Objekt.Name' in v;
  const fullName = join(' ', g('Mitarbeiter.Vorname'), g('Mitarbeiter.Nachname'));
  const empAddr = join(', ', g('Mitarbeiter.Straße'), join(' ', g('Mitarbeiter.PLZ'), g('Mitarbeiter.Ort')));
  const custAddr = join(', ', g('Kunde.Straße'), join(' ', g('Kunde.PLZ'), g('Kunde.Ort')));
  const siteAddr = join(', ', g('Objekt.Straße'), join(' ', g('Objekt.PLZ'), g('Objekt.Ort')));
  const siteName = site
    ? join(' ', g('Objekt.Name'), g('Objekt.Nummer') ? `(${g('Objekt.Nummer')})` : '')
    : '';
  const signed = g('Dokument.Unterschriftsdatum') || g('Dokument.Datum');
  // Befreiung von der RV-Pflicht wirkt ab dem Monat des Eingangs beim Arbeitgeber, frühestens ab Beschäftigungsbeginn
  const rvStart = (() => {
    const iso = (d: string) => d.split('.').reverse().join('-');
    const de = (d: string) => d.split('-').reverse().join('.');
    if (!signed) return '';
    const first = `${iso(signed).slice(0, 7)}-01`;
    const entry = g('Mitarbeiter.Eintrittsdatum');
    return de(entry && iso(entry) > first ? iso(entry) : first);
  })();
  const rules: [RegExp, () => string][] = [
    [/^name$/, () => (emp ? g('Mitarbeiter.Nachname') : '')],
    [/^vorname$/, () => g('Mitarbeiter.Vorname')],
    [
      /^(name vorname|mitarbeiter ?in|mieter( arbeitnehmer ?in)?)$/,
      () => (emp ? join(', ', g('Mitarbeiter.Nachname'), g('Mitarbeiter.Vorname')) : ''),
    ],
    [/^geburtsdatum$/, () => g('Mitarbeiter.Geburtsdatum')],
    [
      /^geburtsort staatsangeh/,
      () => join(' / ', g('Mitarbeiter.Geburtsort'), g('Mitarbeiter.Staatsangehörigkeit')),
    ],
    [/^geburtsort$/, () => g('Mitarbeiter.Geburtsort')],
    [/^staatsangeh/, () => g('Mitarbeiter.Staatsangehörigkeit')],
    [/^familienstand$/, () => g('Mitarbeiter.Familienstand')],
    [/^stra(ss|ß)e( hausnummer| hausnr)?$/, () => g('Mitarbeiter.Straße')],
    [/^plz (wohnort|ort)$/, () => join(' ', g('Mitarbeiter.PLZ'), g('Mitarbeiter.Ort'))],
    [/^anschrift$/, () => (emp ? empAddr : custAddr)],
    [/^adresse$/, () => (emp ? empAddr : site ? siteAddr : custAddr)],
    [/^telefon( mobil)?$/, () => g('Mitarbeiter.Telefon')],
    [/^e mail( notfallkontakt)?$/, () => g('Mitarbeiter.E-Mail')],
    [/^sozialversicherungsnummer$/, () => g('Mitarbeiter.SV-Nummer')],
    [/^steuer identifikationsnummer$|^steuer id$/, () => g('Mitarbeiter.Steuer-ID')],
    [/^krankenkasse$/, () => g('Mitarbeiter.Krankenkasse')],
    [/^iban$/, () => g('Mitarbeiter.IBAN')],
    [/^kontoinhaber/, () => (g('Mitarbeiter.IBAN') ? fullName : '')],
    [
      /^(gew(ü|u)nschter eintritt|eintritt|eintrittsdatum|arbeitsverh(ä|a)ltnis seit)$/,
      () => g('Mitarbeiter.Eintrittsdatum'),
    ],
    [/^t(ä|a)tigkeit$/, () => g('Mitarbeiter.Tätigkeit')],
    [/^personalnummer$/, () => g('Mitarbeiter.Personalnummer')],
    [
      /^(objekt )?einsatz(gebiet|ort)$/,
      () => (site ? join(', ', siteName, siteAddr) : g('Mitarbeiter.Objekte')),
    ],
    [/^(verantwortliche )?objektleitung$/, () => g('Objekt.Objektleitung') || g('Mitarbeiter.Objektleitung')],
    [/^resturlaub$/, () => g('Mitarbeiter.Resturlaub')],
    [/^(kunde|auftraggeber|entleiher)$/, () => g('Kunde.Name')],
    [/^ansprechpartner( vor ort)?$/, () => g('Kunde.Ansprechpartner')],
    [/^(objekt|objekt objekt nr|objekt liegenschaft|leistung objekt|einsatzort objekt)$/, () => siteName],
    [/^objekt adresse$/, () => join(', ', siteName, siteAddr)],
    [/^objekt nr$/, () => g('Objekt.Nummer')],
    [/^ort datum$/, () => join(', ', g('Dokument.Ort') || 'München', g('Dokument.Datum'))],
    // Antrag auf Befreiung von der Rentenversicherungspflicht (Minijob, Anlage 10)
    [/^eingang beim arbeitgeber$/, () => signed],
    [/^beginn der befreiung$/, () => rvStart],
    [/^meldung an (die )?minijob zentrale$/, () => signed],
    [/^zu den entgeltunterlagen$/, () => signed],
  ];
  const out: Record<number, string> = {};
  for (const f of fields) {
    if (f.kind !== 'cell') continue;
    const l = normLabel(f.label);
    const r = rules.find(([re]) => re.test(l));
    const val = r ? r[1]() : '';
    if (val) out[f.index] = val;
  }
  return out;
}
