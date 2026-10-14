/**
 * Aushänge für den Putzraum (Ahmed 14.10.: „alle Aushänge in einen Button … wie reinigt man den Wagen, die
 * Waschmaschine, mit Piktogrammen, einfach schön“). Je Aushang eine A4-Seite ohne Briefpapier: Bordeaux-Kopfband mit
 * Piktogramm, nummerierte Schritt-Karten mit Symbol, Kästen „So ist es richtig“ / „Niemals“.
 *
 * Die Texte sind firmenweit änderbar (Einstellungen → Objektordner-Vorlagen → Aushänge): Schritte ändern, löschen,
 * hinzufügen, Aushänge ausschalten oder eigene anlegen. Platzhalter wie {objektleitung} werden je Objekt gefüllt;
 * leere Platzhalter verschwinden samt Zeile.
 * Bewusst keine festen Dosierungen/Temperaturen ohne Herstellerangabe – die stehen beim Produkt bzw. Pflegeetikett.
 */
import { readFile } from 'node:fs/promises';
import { type PDFDocument, type PDFImage, rgb, type RGB } from '@cantoo/pdf-lib';
import { formatDateDe } from '../domain/invoice/calc.js';
import { FORM_COLORS, FORM_X, type FormDoc } from './form-doc.js';
import { PICTOS, type PictoName, drawPicto, drawPictoBadge } from './pictos.js';

export const SKETCHES = { reinigungswagen: 'Reinigungswagen', waschmaschine: 'Waschmaschine' } as const;
export type SketchName = keyof typeof SKETCHES;

export type PosterColor = 'rot' | 'gelb' | 'blau' | 'gruen';
export interface PosterStep {
  icon: PictoName;
  title: string;
  text: string;
  color?: PosterColor;
}
/** notfall/farben/hautschutz haben feste Datenteile (Telefonnummern, Kontakte, Dosiertabelle), text nur Schritte */
export type PosterKind = 'notfall' | 'farben' | 'text';
export interface PosterDef {
  key: string;
  kind: PosterKind;
  title: string;
  icon: PictoName;
  /** Zeile unter den Schritten bzw. Einleitung */
  intro: string;
  /** Skizze mit nummerierten Stellen (Nummern = Schritte), assets/aushaenge/skizze-<name>.png */
  sketch?: SketchName;
  steps: PosterStep[];
  dos: string[];
  donts: string[];
  note: string;
  active: boolean;
  /** von uns vorgegeben (zurücksetzbar) – sonst eigener Aushang (löschbar) */
  builtin: boolean;
}

export const PICTO_NAMES = Object.keys(PICTOS) as PictoName[];
export const PICTO_LABELS: Partial<Record<PictoName, string>> = {
  phone: 'Telefon',
  alert: 'Achtung',
  cross: 'Erste Hilfe',
  pin: 'Ort',
  user: 'Person',
  house: 'Gebäude',
  exit: 'Ausgang',
  people: 'Personen',
  hand: 'Hand',
  tube: 'Creme',
  droplet: 'Tropfen',
  wash: 'Waschen',
  cart: 'Reinigungswagen',
  bucket: 'Eimer',
  trash: 'Abfall',
  wipe: 'Tuch',
  mop: 'Mopp',
  bag: 'Sack',
  bottle: 'Flasche',
  spray: 'Sprühflasche',
  lid: 'Behälter',
  washer: 'Waschmaschine',
  thermo: 'Temperatur',
  filter: 'Sieb / Filter',
  door: 'Tür / Raum',
  sun: 'Trocknen',
  air: 'Lüften',
  book: 'Unterlagen',
  cup: 'Getränk',
  ladder: 'Leiter',
  check: 'Haken',
  x: 'Verbot',
  mix: 'Nicht mischen',
  palette: 'Farben',
  clock: 'Uhrzeit',
  doc: 'Dokument',
  key: 'Schlüssel',
  calendar: 'Kalender',
  wheel: 'Rad',
  power: 'Ein/Aus',
  tap: 'Wasserhahn',
};

/** Platzhalter, die in allen Texten gehen (Hilfe in den Einstellungen) */
export const POSTER_PLACEHOLDERS: [string, string][] = [
  ['{objekt}', 'Objektname'],
  ['{adresse}', 'Adresse des Objekts'],
  ['{objektleitung}', 'Name der Objektleitung'],
  ['{objektleitung_tel}', 'Telefon der Objektleitung'],
  ['{putzraum}', 'Lage des Putzraums'],
  ['{abfall_platz}', 'Müll-Sammelplatz'],
  ['{hautschutz}', 'Hautschutz-Produkt'],
  ['{hautreinigung}', 'Hautreinigungs-Produkt'],
  ['{hautpflege}', 'Hautpflege-Produkt'],
  ['{betriebsarzt}', 'Betriebsarzt'],
];

const s = (icon: PictoName, title: string, text: string, color?: PosterColor): PosterStep =>
  color ? { icon, title, text, color } : { icon, title, text };

export const DEFAULT_POSTERS: PosterDef[] = [
  {
    key: 'notfall',
    kind: 'notfall',
    title: 'Notfall & Kontakte',
    icon: 'alert',
    intro: 'Bei einem Unfall',
    steps: [
      s(
        'cross',
        'Erste Hilfe',
        'Ruhe bewahren, auf eigene Sicherheit achten, Verletzte betreuen, Ersthelfer holen.',
      ),
      s(
        'phone',
        'Notruf 112',
        'Wo ist es passiert? Was ist passiert? Wie viele Verletzte? Warten auf Rückfragen.',
      ),
      s('user', 'Objektleitung anrufen', 'Sofort Bescheid geben – auch bei kleinen Verletzungen.'),
      s('book', 'Eintragen', 'Jede Erste-Hilfe-Leistung ins Verbandbuch, jeden Arbeitsunfall melden.'),
    ],
    dos: [],
    donts: [],
    note: '',
    active: true,
    builtin: true,
  },
  {
    key: 'farben',
    kind: 'farben',
    title: 'Farbsystem & Dosierung',
    icon: 'palette',
    intro: 'Jede Farbe hat ihren Bereich – Tücher, Eimer und Handschuhe nie zwischen den Bereichen wechseln.',
    steps: [
      s(
        'wipe',
        'Rot – WC und Urinal',
        'Toilettenbecken, Urinale, WC-Sitze und der Bereich direkt darum.',
        'rot',
      ),
      s('wash', 'Gelb – Sanitär', 'Waschbecken, Armaturen, Spiegel, Fliesen, Duschen, Trennwände.', 'gelb'),
      s(
        'house',
        'Blau – Büro und Möbel',
        'Tische, Stühle, Schränke, Fensterbänke, Türen, Heizkörper.',
        'blau',
      ),
      s(
        'cup',
        'Grün – Küche',
        'Teeküchen, Küchen, Speiseräume – alles mit Kontakt zu Lebensmitteln.',
        'gruen',
      ),
    ],
    dos: ['Erst Wasser, dann Reiniger', 'Dosierhilfe benutzen', 'Für jeden Bereich frische Tücher'],
    donts: ['Reinigungsmittel mischen', 'Nach Gefühl dosieren', 'Rote Tücher außerhalb des WC benutzen'],
    note: 'Überdosierung schadet Oberflächen und Haut. Sicherheitsdatenblätter liegen im Objektordner.',
    active: true,
    builtin: true,
  },
  {
    key: 'hautschutz',
    kind: 'text',
    title: 'Hautschutzplan',
    icon: 'hand',
    intro: 'Feuchtarbeit und Reinigungsmittel belasten die Haut. So bleibt sie gesund:',
    steps: [
      s('tube', 'Vor der Arbeit', 'Hautschutz auftragen – auch nach jeder Pause.\n{hautschutz}'),
      s(
        'hand',
        'Bei Nassarbeit',
        'Schutzhandschuhe tragen. Bei längerem Tragen Baumwoll-Unterziehhandschuhe.',
      ),
      s(
        'wash',
        'Vor Pausen und nach der Arbeit',
        'Hände mild reinigen und gründlich abtrocknen.\n{hautreinigung}',
      ),
      s('droplet', 'Nach der Arbeit', 'Hände eincremen.\n{hautpflege}'),
    ],
    dos: ['Handschuhe nur auf saubere, trockene Hände', 'Hautveränderungen sofort melden'],
    donts: ['Ringe oder Uhr bei Nassarbeit', 'Hände mit Reinigungsmittel waschen'],
    note: 'Nasse Hände oder Handschuhe mehr als 2 Stunden am Tag gelten als Feuchtarbeit (TRGS 401) – Vorsorge beim Betriebsarzt: {betriebsarzt}',
    active: true,
    builtin: true,
  },
  {
    key: 'sanitaer',
    kind: 'text',
    title: 'Sanitärräume richtig reinigen',
    icon: 'wash',
    intro: 'Immer von sauber nach schmutzig, von oben nach unten.',
    steps: [
      s('trash', 'Abfall', 'Abfalleimer und Hygienebehälter leeren, neue Beutel einsetzen.'),
      s('bag', 'Auffüllen', 'Seife, Papierhandtücher und Toilettenpapier auffüllen.'),
      s('wash', 'Waschbecken & Spiegel', 'Gelbes Tuch: Spiegel, Armaturen, Waschbecken, Ablagen, Fliesen.'),
      s(
        'wipe',
        'WC und Urinal zuletzt',
        'Rotes Tuch: erst außen, dann Sitz, zuletzt Becken innen mit der Bürste.',
      ),
      s('mop', 'Boden', 'Von hinten zur Tür hin wischen – nicht durch nasse Flächen laufen.'),
      s('check', 'Kontrolle', 'Geruch, Spritzer, Papier – alles in Ordnung? Dann Licht aus.'),
    ],
    dos: ['Handschuhe tragen', 'Warnschild „Rutschgefahr“ aufstellen'],
    donts: [
      'Gelbes und rotes Tuch vertauschen',
      'Reiniger direkt in das WC kippen und stehen lassen ohne Bürste',
    ],
    note: '',
    active: true,
    builtin: true,
  },
  {
    key: 'wagen',
    kind: 'text',
    title: 'Reinigungswagen pflegen und bestücken',
    icon: 'cart',
    sketch: 'reinigungswagen',
    intro: 'Nach jeder Schicht diese 10 Punkte erledigen. Die Nummern in der Skizze zeigen, wo am Wagen.',
    steps: [
      s(
        'trash',
        'Müllsack leeren und neu einsetzen',
        'Vollen Sack zuknoten, entsorgen, neuen Sack einsetzen.',
      ),
      s(
        'droplet',
        'Schmutzwasser ausleeren',
        'Roten Eimer nur im Ausguss leeren – nicht ins Handwaschbecken.',
      ),
      s(
        'bucket',
        'Eimer und Presse ausspülen',
        'Beide Eimer und Presse klar ausspülen, umgedreht trocknen lassen.',
      ),
      s(
        'bag',
        'Mopps und Tücher in den Wäschesack',
        'Benutzte Mopps und Tücher nie wieder verwenden – ab in die Wäsche.',
      ),
      s('palette', 'Farbeimer reinigen', 'Auswaschen und trocknen. Farben nie vertauschen – Rot nur für WC.'),
      s(
        'spray',
        'Sprühflaschen kontrollieren',
        'Nur beschriftete Flaschen, Deckel zu, nichts ohne Etikett umfüllen.',
      ),
      s('wipe', 'Griff und Ablagen abwischen', 'Wagen außen feucht abwischen – Griff, Ablagen, Deckel.'),
      s('wheel', 'Räder kontrollieren', 'Haare und Fäden entfernen, damit der Wagen leicht rollt.'),
      s('cart', 'Wagen neu bestücken', 'Frische Mopps, Tücher, Handschuhe, Müllsäcke und Mittel auffüllen.'),
      s(
        'door',
        'Wagen ordentlich abstellen',
        'In der Reinigungskammer abstellen. Mittel nie offen stehen lassen.',
      ),
    ],
    dos: [],
    donts: [],
    note: '',
    active: true,
    builtin: true,
  },
  {
    key: 'waschmaschine',
    kind: 'text',
    title: 'Waschmaschine bedienen und pflegen',
    icon: 'washer',
    sketch: 'waschmaschine',
    intro:
      'Nach jedem Waschgang diese 10 Punkte erledigen. Die Nummern in der Skizze zeigen, wo an der Maschine.',
    steps: [
      s('washer', 'Wäsche sofort entnehmen', 'Gleich nach Programmende raus – nasse Wäsche riecht schnell.'),
      s('wipe', 'Türdichtung reinigen', 'Gummi abwischen, Haare, Klettreste und Wasser entfernen.'),
      s('spray', 'Türglas innen abwischen', 'Schmutz und Waschmittelreste mit feuchtem Tuch entfernen.'),
      s('droplet', 'Waschmittelschublade reinigen', 'Herausziehen, Reste ausspülen, trocknen lassen.'),
      s(
        'filter',
        'Flusensieb reinigen (1× pro Woche)',
        'Klappe öffnen, Wasser auffangen, Sieb säubern, fest zudrehen.',
      ),
      s('wipe', 'Gehäuse außen reinigen', 'Bedienfeld, Tür und Oberseite feucht abwischen.'),
      s('power', 'Programm auf AUS stellen', 'Wahlschalter auf AUS drehen, Gerät ausschalten.'),
      s('tap', 'Wasserhahn zudrehen', 'Nach Arbeitsende Zulauf schließen – schützt vor Wasserschäden.'),
      s(
        'door',
        'Tür und Schublade offen lassen',
        'Spaltbreit offen, damit alles trocknet – keine Gerüche, kein Schimmel.',
      ),
      s(
        'thermo',
        'Hygiene-Waschgang 1× pro Woche',
        'Leer bei 90 °C waschen. Defekte sofort dem Vorarbeiter melden.',
      ),
    ],
    dos: [],
    donts: [],
    note: '',
    active: true,
    builtin: true,
  },
  {
    key: 'waesche',
    kind: 'text',
    title: 'Mopps & Tücher waschen',
    icon: 'mop',
    intro: 'Saubere Mopps und Tücher sind die Grundlage für hygienisches Reinigen.',
    steps: [
      s('palette', 'Sortieren', 'Nach Farben trennen. Rote Tücher (WC) möglichst getrennt waschen.'),
      s('mop', 'Ausschütteln', 'Grobe Verschmutzungen entfernen. Nasse Mopps nicht lange liegen lassen.'),
      s(
        'washer',
        'Beladen',
        'Trommel höchstens zu drei Vierteln füllen. Keine Fremdkörper (Klammern, Papier).',
      ),
      s('thermo', 'Temperatur', 'Nach Pflegeetikett waschen – Mikrofaser meist 60 °C.'),
      s(
        'droplet',
        'Waschmittel',
        'Nach Herstellerangabe dosieren. Kein Weichspüler – Mikrofaser reinigt sonst nicht mehr.',
      ),
      s('sun', 'Trocknen', 'Sofort herausnehmen und trocknen (Trockner nach Pflegeetikett).'),
      s('bag', 'Lagern', 'Saubere Wäsche trocken und getrennt von benutzter aufbewahren.'),
    ],
    dos: [],
    donts: ['Weichspüler', 'Feuchte Wäsche in der Maschine liegen lassen'],
    note: '',
    active: true,
    builtin: true,
  },
  {
    key: 'putzraum',
    kind: 'text',
    title: 'Ordnung im Putzraum',
    icon: 'door',
    intro: 'Putzraum: {putzraum}',
    steps: [
      s(
        'bottle',
        'Reinigungsmittel',
        'Nur in Originalgebinden, verschlossen, im Regal – nicht auf dem Boden, nicht über Kopfhöhe.',
      ),
      s(
        'key',
        'Abschließen',
        'Putzraum immer abschließen – Reinigungsmittel unzugänglich für Unbefugte und Kinder.',
      ),
      s('mop', 'Mopps & Tücher', 'Saubere und benutzte getrennt, benutzte in den Wäschesack.'),
      s(
        'cart',
        'Wagen & Maschinen',
        'Sauber zurückstellen, Maschinen ausschalten, Kabel aufrollen, Akkus laden.',
      ),
      s('air', 'Lüften', 'Raum lüften, nasse Sachen zum Trocknen ausbreiten.'),
      s('book', 'Unterlagen', 'Objektordner, Betriebsanweisungen und Sicherheitsdatenblätter liegen hier.'),
    ],
    dos: ['Verschüttetes sofort aufwischen', 'Leere Gebinde entsorgen'],
    donts: ['Essen, Getränke, private Sachen', 'Fluchtwege und Türen zustellen'],
    note: '',
    active: true,
    builtin: true,
  },
];

/** Gespeicherte Änderungen über die Vorgaben legen (neue Standard-Aushänge erscheinen automatisch). */
export function mergePosters(saved: Partial<PosterDef>[] | undefined): PosterDef[] {
  const byKey = new Map((saved ?? []).filter((p) => p.key).map((p) => [p.key!, p]));
  const out: PosterDef[] = DEFAULT_POSTERS.map((d) => {
    const o = byKey.get(d.key);
    return o ? { ...d, ...clean(o), key: d.key, kind: d.kind, builtin: true } : { ...d };
  });
  for (const o of saved ?? [])
    if (o.key && !DEFAULT_POSTERS.some((d) => d.key === o.key))
      out.push({ ...clean(o), key: o.key, kind: 'text', builtin: false } as PosterDef);
  return out;
}

function clean(o: Partial<PosterDef>): Partial<PosterDef> {
  const r: Partial<PosterDef> = {};
  if (typeof o.title === 'string') r.title = o.title;
  if (o.icon && o.icon in PICTOS) r.icon = o.icon;
  if (typeof o.intro === 'string') r.intro = o.intro;
  if (typeof o.note === 'string') r.note = o.note;
  if (typeof o.active === 'boolean') r.active = o.active;
  if (Array.isArray(o.dos)) r.dos = o.dos.filter((x) => typeof x === 'string');
  if (Array.isArray(o.donts)) r.donts = o.donts.filter((x) => typeof x === 'string');
  if (o.sketch === null || (typeof o.sketch === 'string' && o.sketch in SKETCHES))
    r.sketch = o.sketch ?? undefined;
  if (Array.isArray(o.steps))
    r.steps = o.steps
      .filter((x) => x && typeof x.title === 'string')
      .map((x) => ({
        icon: x.icon in PICTOS ? x.icon : 'check',
        title: x.title,
        text: x.text ?? '',
        ...(x.color ? { color: x.color } : {}),
      }));
  return r;
}

/** Platzhalter füllen; Zeilen, die danach nur noch aus leeren Platzhaltern bestanden, entfallen. */
export function fillPlaceholders(t: string, vals: Record<string, string | undefined>): string {
  return t
    .split('\n')
    .map((line) => {
      const keys = [...line.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]!);
      const had = keys.length > 0;
      const out = line.replace(/\{([a-z_]+)\}/g, (_m, k: string) => vals[k]?.trim() ?? '');
      // nur Platzhalter (oder „Putzraum: {putzraum}“) und alle leer → Zeile weg
      const rest = line.replace(/\{[a-z_]+\}/g, '').replace(/[\s:·,–-]/g, '');
      if (had && keys.every((k) => !vals[k]?.trim()) && rest.length < 25) return null;
      // „…: “ ohne Wert am Ende entfernen
      return out.replace(/[\s:·,–-]+$/u, (m) => (had ? '' : m));
    })
    .filter((l): l is string => l !== null)
    .join('\n')
    .trim();
}

export interface PosterContext {
  siteName: string;
  siteNo: string;
  address: string;
  date: string;
  vals: Record<string, string | undefined>;
  /** Notfall: Kontakte (Beschriftung, Wert, Symbol) */
  contacts: { label: string; value: string; icon: PictoName }[];
  /** Farbsystem: Dosiertabelle */
  dosage: { produkt: string; dosierung: string; wasser: string; hinweis: string }[];
  /** eingebettete Skizzen (embedSketches) */
  sketches?: Partial<Record<SketchName, PDFImage>>;
}

/** Skizzen einmal je Dokument einbetten. */
export async function embedSketches(pdf: PDFDocument): Promise<Partial<Record<SketchName, PDFImage>>> {
  const out: Partial<Record<SketchName, PDFImage>> = {};
  for (const k of Object.keys(SKETCHES) as SketchName[])
    out[k] = await pdf.embedPng(
      await readFile(new URL(`../../assets/aushaenge/skizze-${k}.png`, import.meta.url)),
    );
  return out;
}

/** Inhaltsbereich schlanker Seiten (FormDoc.newPage({ plain: true })) */
const PLAIN_TOP = 74;
const PLAIN_BOTTOM = 806;
const BORDEAUX = FORM_COLORS.BORDEAUX;
const WHITE = rgb(1, 1, 1);
const INK = rgb(0.1, 0.09, 0.1);
const LINE = rgb(0.89, 0.88, 0.89);
const GREEN = rgb(0.13, 0.48, 0.26);
const RED = rgb(0.74, 0.12, 0.12);
const COLORS: Record<PosterColor, { bg: RGB; fg: RGB; tint: RGB }> = {
  rot: { bg: rgb(0.8, 0.13, 0.16), fg: WHITE, tint: rgb(0.99, 0.93, 0.93) },
  gelb: { bg: rgb(0.96, 0.76, 0.1), fg: INK, tint: rgb(1, 0.97, 0.87) },
  blau: { bg: rgb(0.13, 0.4, 0.75), fg: WHITE, tint: rgb(0.92, 0.95, 1) },
  gruen: { bg: rgb(0.15, 0.55, 0.3), fg: WHITE, tint: rgb(0.92, 0.97, 0.93) },
};

/** Einen Aushang auf eine neue (schlanke) Seite zeichnen. */
export function drawPoster(d: FormDoc, def: PosterDef, ctx: PosterContext) {
  const { L, R } = FORM_X;
  const fill = (t: string) => fillPlaceholders(t, ctx.vals);
  // Schriftgrößen-Faktor: so lange verkleinern, bis alles auf eine Seite passt
  let k = 1.4;
  for (; k > 0.7; k -= 0.05) if (layout(d, def, ctx, k, fill, false) <= PLAIN_BOTTOM - 30) break;
  d.newPage({ plain: true });
  layout(d, def, ctx, k, fill, true);
  // Fußzeile
  const foot = `${ctx.siteName} (${ctx.siteNo}) · Stand ${formatDateDe(ctx.date)} · Viva-Deluxe Gebäudereinigung GmbH`;
  d.line(L, R, d.bottom - 14, LINE, 0.5);
  d.text(d.fit(foot, R - L, 7.5), L, d.bottom - 3, { size: 7.5, color: FORM_COLORS.MUT });
}

/** Zeichnet (draw=true) bzw. misst den Aushang; gibt das Ende (y) zurück. */
function layout(
  d: FormDoc,
  def: PosterDef,
  ctx: PosterContext,
  k: number,
  fill: (t: string) => string,
  draw: boolean,
): number {
  const { L, R } = FORM_X;
  const W = R - L;
  const page = d.page;
  let y = PLAIN_TOP + 6;

  // Kopfband
  const bandH = 84;
  const title = fill(def.title);
  let tSize = 26;
  while (tSize > 15 && d.width(title, tSize, true) > W - 104) tSize -= 1;
  if (draw) {
    page.drawRectangle({ x: L, y: page.getHeight() - y - bandH, width: W, height: bandH, color: BORDEAUX });
    drawPictoBadge(page, def.icon, L + 44, y + bandH / 2, 27, WHITE, BORDEAUX);
    d.text(title, L + 86, y + 40, { size: tSize, bold: true, color: WHITE });
    const sub = [ctx.siteName, ctx.address].filter(Boolean).join(' · ');
    d.text(d.fit(sub, W - 100, 10), L + 86, y + 62, { size: 10, color: rgb(0.96, 0.88, 0.91) });
  }
  y += bandH + 16;

  const para = (t: string, size: number, bold = false, color = INK) => {
    if (!t) return;
    for (const l of d.wrap(t, W, size, bold)) {
      if (draw) d.text(l, L, y + size, { size, bold, color });
      y += size + 5;
    }
    y += 6;
  };

  if (def.kind === 'notfall') {
    // drei große Nummern
    const tw = (W - 2 * 10) / 3;
    const tiles: [string, string, boolean][] = [
      ['Notruf · Feuerwehr · Rettung', '112', true],
      ['Polizei', '110', false],
      ['Giftnotruf München', '089 19240', false],
    ];
    tiles.forEach(([label, num, acc], i) => {
      const x = L + i * (tw + 10);
      if (draw) {
        page.drawRectangle({
          x,
          y: page.getHeight() - y - 70,
          width: tw,
          height: 70,
          color: acc ? rgb(0.8, 0.1, 0.12) : FORM_COLORS.BOX,
          borderColor: acc ? rgb(0.8, 0.1, 0.12) : LINE,
          borderWidth: acc ? 0 : 0.6,
        });
        drawPicto(page, 'phone', x + 10, y + 10, 16, acc ? WHITE : BORDEAUX, 2);
        d.cap(label, x + 32, y + 22, { size: 6.4, color: acc ? WHITE : FORM_COLORS.MUT });
        d.text(num, x + 12, y + 56, { size: num.length > 4 ? 22 : 30, bold: true, color: acc ? WHITE : INK });
      }
    });
    y += 82;
    // Adresse für den Notruf
    const adr = ctx.address || ctx.siteName;
    const al = d.wrap(adr, W - 70, 15 * k, true);
    const ah = 28 + al.length * (15 * k + 4);
    if (draw) {
      page.drawRectangle({
        x: L,
        y: page.getHeight() - y - ah,
        width: W,
        height: ah,
        color: FORM_COLORS.ACCENT,
      });
      page.drawRectangle({ x: L, y: page.getHeight() - y - ah, width: 3, height: ah, color: BORDEAUX });
      drawPicto(page, 'pin', L + 14, y + ah / 2 - 13, 26, BORDEAUX, 2);
      d.cap('Unsere Adresse – das sagen Sie beim Notruf', L + 52, y + 15, { size: 6.6 });
      al.forEach((l, i) =>
        d.text(l, L + 52, y + 22 + (i + 1) * (15 * k + 4) - 3, { size: 15 * k, bold: true }),
      );
    }
    y += ah + 10;
    // Kontakte zweispaltig
    const cw = (W - 10) / 2;
    const contacts = ctx.contacts.filter((c) => c.value.trim());
    for (let i = 0; i < contacts.length; i += 2) {
      const pair = contacts.slice(i, i + 2);
      const lines = pair.map((c) => d.wrap(c.value, cw - 52, 11.5 * k, true));
      const h = 24 + Math.max(...lines.map((l) => l.length)) * (11.5 * k + 3) + 6;
      pair.forEach((c, j) => {
        const x = L + j * (cw + 10);
        if (!draw) return;
        page.drawRectangle({
          x,
          y: page.getHeight() - y - h,
          width: cw,
          height: h,
          color: WHITE,
          borderColor: LINE,
          borderWidth: 0.6,
        });
        drawPictoBadge(page, c.icon, x + 22, y + 22, 12, FORM_COLORS.ACCENT, BORDEAUX);
        d.cap(c.label, x + 42, y + 15, { size: 6.2 });
        lines[j]!.forEach((l, n) =>
          d.text(l, x + 42, y + 20 + (n + 1) * (11.5 * k + 3) - 2, { size: 11.5 * k, bold: true }),
        );
      });
      y += h + 8;
    }
    y += 4;
    if (def.intro) {
      if (draw) d.text(fill(def.intro), L, y + 12, { size: 12, bold: true, color: BORDEAUX });
      y += 20;
    }
  } else if (def.intro) {
    para(fill(def.intro), 11.5 * k);
  }
  // Skizze mit Nummern (Wagen, Waschmaschine)
  const sk = def.sketch ? ctx.sketches?.[def.sketch] : undefined;
  if (sk) {
    const sw = W * Math.min(0.86, 0.86 * k);
    const sh = (sk.height / sk.width) * sw;
    if (draw) {
      page.drawRectangle({
        x: L,
        y: page.getHeight() - y - sh - 12,
        width: W,
        height: sh + 12,
        color: WHITE,
        borderColor: LINE,
        borderWidth: 0.6,
      });
      page.drawImage(sk, { x: L + (W - sw) / 2, y: page.getHeight() - y - sh - 6, width: sw, height: sh });
    }
    y += sh + 12 + 10;
  }

  // Schritt-Karten (zwei Spalten; Farbsystem mit Farbkennung)
  const steps = def.steps
    .map((st) => ({ ...st, title: fill(st.title), text: fill(st.text) }))
    .filter((st) => st.title);
  const cols = steps.length <= 1 ? 1 : 2;
  const gap = 10;
  const cw = (W - (cols - 1) * gap) / cols;
  const ts = 12.5 * k;
  const bs = 10.5 * k;
  // mit Skizze: kompakte Karten ohne Symbol (die Skizze zeigt die Stelle)
  const compact = !!sk;
  const ics = compact ? 0 : 34 * Math.min(k, 1.15);
  const tx = 38 * Math.min(k, 1.15);
  /** Text um das Symbol rechts oben herum umbrechen */
  const card = (st: (typeof steps)[number]) => {
    const narrow = compact ? cw - tx - 10 : cw - tx - ics - 18;
    const full = cw - tx - 10;
    const lines: { t: string; bold: boolean; size: number; y: number }[] = [];
    let yy = compact ? 7 : 14;
    const add = (text: string, size: number, bold: boolean, lh: number) => {
      for (const para of text.split('\n')) {
        let line = '';
        // überlange Wörter an Bindestrichen trennen („Baumwoll-Unterziehhandschuhe“)
        const words = para
          .split(/\s+/)
          .filter(Boolean)
          .flatMap((w) =>
            d.width(w, size, bold) > narrow ? w.replace(/-/g, '-\u0000').split('\u0000') : [w],
          );
        const width = () => (yy < 12 + ics ? narrow : full);
        for (const w of words) {
          const next = line ? (line.endsWith('-') ? `${line}${w}` : `${line} ${w}`) : w;
          if (d.width(next, size, bold) <= width() || !line) line = next;
          else {
            yy += lh;
            lines.push({ t: line, bold, size, y: yy });
            line = w;
          }
        }
        if (line) {
          yy += lh;
          lines.push({ t: line, bold, size, y: yy });
        }
      }
    };
    add(st.title, ts, true, ts + 3);
    yy += compact ? 3 : 5;
    add(st.text, bs, false, bs + 3.5);
    return { lines, h: compact ? yy + 9 : Math.max(yy + 12, ics + 24) };
  };
  for (let i = 0; i < steps.length; i += cols) {
    const row = steps.slice(i, i + cols);
    const cards = row.map(card);
    const hh = Math.max(...cards.map((c) => c.h));
    row.forEach((st, j) => {
      if (!draw) return;
      const x = L + j * (cw + gap);
      const col = st.color ? COLORS[st.color] : null;
      page.drawRectangle({
        x,
        y: page.getHeight() - y - hh,
        width: cw,
        height: hh,
        color: col ? col.tint : FORM_COLORS.BOX,
        borderColor: LINE,
        borderWidth: 0.6,
      });
      if (col) page.drawRectangle({ x, y: page.getHeight() - y - hh, width: 5, height: hh, color: col.bg });
      // Nummer
      const n = String(i + j + 1);
      const r = 10.5 * Math.min(k, 1.15);
      const top = compact ? 6 : 10;
      page.drawCircle({
        x: x + 8 + r,
        y: page.getHeight() - y - top - r,
        size: r,
        color: col ? col.bg : BORDEAUX,
      });
      d.text(n, x + 8 + r - d.width(n, r, true) / 2, y + top + r * 1.36, {
        size: r,
        bold: true,
        color: col ? col.fg : WHITE,
      });
      // Symbol rechts oben
      if (!compact) drawPicto(page, st.icon, x + cw - ics - 10, y + 10, ics, col ? col.bg : BORDEAUX, 1.9);
      for (const l of cards[j]!.lines)
        d.text(l.t, x + tx, y + l.y - 3, {
          size: l.size,
          bold: l.bold,
          ...(l.bold ? {} : { color: rgb(0.25, 0.23, 0.25) }),
        });
    });
    y += hh + (compact ? 6 : gap);
  }

  // Dosiertabelle (Farbsystem)
  if (def.kind === 'farben') {
    y += 6;
    if (draw) d.text('Dosierung', L, y + 12, { size: 12, bold: true, color: BORDEAUX });
    y += 20;
    const rows = ctx.dosage;
    if (!rows.length) {
      para('Dosierung laut Etikett bzw. Dosiersystem des Herstellers.', 10.5 * k);
    } else {
      const widths = [W * 0.3, W * 0.17, W * 0.17, W * 0.36];
      const head = ['Produkt', 'Dosierung', 'Wasser', 'Einsatz / Hinweis'];
      const sz = 10.5 * k;
      const rowH = (r: string[]) =>
        Math.max(...r.map((c, i) => d.wrap(c, widths[i]! - 10, sz, i === 0).length)) * (sz + 3) + 9;
      if (draw) {
        page.drawRectangle({
          x: L,
          y: page.getHeight() - y - 18,
          width: W,
          height: 18,
          color: FORM_COLORS.ACCENT,
        });
        let x = L;
        head.forEach((t, i) => {
          d.cap(t, x + 6, y + 12, { size: 6.4 });
          x += widths[i]!;
        });
      }
      y += 18;
      for (const r of rows) {
        const cells = [r.produkt, r.dosierung, r.wasser, r.hinweis];
        const h = rowH(cells);
        if (draw) {
          let x = L;
          cells.forEach((c, i) => {
            d.wrap(c, widths[i]! - 10, sz, i === 0).forEach((l, n) =>
              d.text(l, x + 6, y + 6 + (n + 1) * (sz + 3) - 2, { size: sz, bold: i === 0 }),
            );
            x += widths[i]!;
          });
          d.line(L, R, y + h, LINE, 0.5);
        }
        y += h;
      }
      y += 8;
    }
  }

  // Richtig / Niemals
  const dos = def.dos.map(fill).filter(Boolean);
  const donts = def.donts.map(fill).filter(Boolean);
  if (dos.length || donts.length) {
    y += 4;
    const boxes: [string, string[], RGB, PictoName][] = [];
    if (dos.length) boxes.push(['So ist es richtig', dos, GREEN, 'check']);
    if (donts.length) boxes.push(['Niemals', donts, RED, 'x']);
    const bw = (W - (boxes.length - 1) * gap) / boxes.length;
    const sz = 10.5 * k;
    const wrapped = boxes.map(([, items]) => items.map((t) => d.wrap(t, bw - 40, sz)));
    const h = 32 + Math.max(...wrapped.map((w) => w.reduce((a, l) => a + l.length * (sz + 3) + 4, 0)));
    boxes.forEach(([label, , color, icon], i) => {
      if (!draw) return;
      const x = L + i * (bw + gap);
      page.drawRectangle({
        x,
        y: page.getHeight() - y - h,
        width: bw,
        height: h,
        color: WHITE,
        borderColor: color,
        borderWidth: 1.2,
      });
      drawPictoBadge(page, icon, x + 18, y + 16, 9, color);
      d.text(label, x + 33, y + 20, { size: 11, bold: true, color });
      let yy = y + 30;
      wrapped[i]!.forEach((ls) => {
        drawPicto(page, icon, x + 11, yy + 2.5, sz * 0.95, color, 2.6);
        ls.forEach((l) => {
          yy += sz + 3;
          d.text(l, x + 28, yy - 1, { size: sz });
        });
        yy += 4;
      });
    });
    y += h + 10;
  }

  const note = fill(def.note);
  if (note) {
    const ls = d.wrap(note, W - 34, 9.5 * k);
    const h = 14 + ls.length * (9.5 * k + 3);
    if (draw) {
      drawPicto(page, 'alert', L + 2, y + 2, 16, BORDEAUX, 2);
      ls.forEach((l, i) =>
        d.text(l, L + 26, y + 12 + i * (9.5 * k + 3), { size: 9.5 * k, color: rgb(0.3, 0.28, 0.3) }),
      );
    }
    y += h;
  }
  return y;
}
