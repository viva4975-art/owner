import type { Role } from '../services/users.js';

/*
 * Wer darf welche Seite? Erste passende Regel gilt. Für Objektleitung werden Inhalte zusätzlich auf die eigenen
 * Objekte eingeschränkt (siehe managedSites). Preise/Rechnungen sieht die Objektleitung nicht.
 */
const ALL: Role[] = ['admin', 'buchhaltung', 'personal', 'objektleitung'];
const OFFICE: Role[] = ['admin', 'buchhaltung'];
const HR: Role[] = ['admin', 'personal'];

const RULES: [RegExp, Role[]][] = [
  [/^\/(anmelden|abmelden|konto|static|health|m)(\/|$)/, ALL],
  [/^\/kalender\/(abo|abonnieren)(\/|$)/, ALL],
  // Suche oben für alle; Treffer werden je Rolle gefiltert (Objektleitung nur eigene Objekte, siehe searchFor)
  [/^\/suche(\.json)?$/, ALL],
  [/^\/benutzer(\/|$)/, ['admin']],
  [/^\/einstellungen\/firma(\/|$)/, ['admin']],
  [/^\/einstellungen\/nummernkreise(\/|$)/, ['admin']],
  [/^\/einstellungen\/bankabruf(\/|$)/, ['admin']],
  [/^\/einstellungen\/email(\/|$)/, ['admin']],
  [/^\/einstellungen\/system(\/|$)/, ['admin']],
  [/^\/einstellungen\/archiv(\/|$)/, ['admin']],
  [/^\/einstellungen\/rechte(\/|$)/, ['admin']],
  [/^\/einstellungen\/datenschutz(\/|$)/, ['admin']],
  [/^\/transfer\/bank\/rueckkehr$/, ['admin']],
  [/^\/einstellungen\/erinnerungen(\/|$)/, ['admin', 'buchhaltung']],
  [/^\/erinnerungen(\/|$)/, ['admin', 'buchhaltung']],
  [/^\/personal\/lohnabrechnungen(\/|$)/, ['admin', 'personal', 'buchhaltung']],
  [/^\/grundreinigung\/objektleitung$/, ['admin', 'buchhaltung', 'personal', 'objektleitung']],
  [/^\/einstellungen\/?$/, ['admin', 'buchhaltung', 'personal']],
  [/^\/einstellungen\/unterweisungen(\/|$)/, ['admin', 'buchhaltung', 'personal']],
  [/^\/einstellungen\/word-vorlagen(\/|$)/, ['admin', 'buchhaltung', 'personal']],
  [/^\/sicherheitsdatenblaetter([/.]|$)/, ALL],
  [/^\/aushaenge\/skizze\//, ALL],
  [/^\/einstellungen\/objektordner(\/|$)/, ['admin', 'buchhaltung', 'personal']],
  [/^\/word-vorlagen\/(erzeugen|ausfuellen)$/, ALL],
  [/^\/transfer\/import\/(dubletten|abgleich)$/, ['admin']],
  [/^\/vorlagen\/?$/, ['admin', 'buchhaltung', 'personal']],
  [/^\/auswertungen\/kostenstellen([/.]|$)/, ['admin', 'buchhaltung']],
  [/^\/auswertungen\/ausgaben([/.]|$)/, ['admin', 'buchhaltung']],
  [/^\/personal\/export/, HR],
  [/^\/bewerber\/stellen\/[0-9a-f-]{36}\/plakat$/, ALL],
  [/^\/stellen$/, ALL],
  [/^\/bewerber(\/|$)/, HR],
  // Objektleitung: Fehlende Unterlagen ihrer Leute (ohne Stammdaten; Ahmed 19.10.)
  [/^\/personal\/unterlagen(\.csv|\.pdf)?$/, [...HR, 'objektleitung']],
  [/^\/verbandbuch(\/|$)/, [...HR, 'objektleitung']],
  [/^\/team(\/|$)/, ['objektleitung']],
  [/^\/personal(\/|$)/, HR],
  [/^\/zeiterfassung\/(meine(\/|$)|plan-als-ist$)/, ALL],
  [/^\/zeiterfassung\/(stundenzettel|lohnarten|arbeitszeitkonto)/, ['admin', 'personal', 'buchhaltung']],
  [/^\/zeiterfassung\/(monat|pruefbericht|einstellungen)/, HR],
  [/^\/(zeiterfassung|einsatzplanung)(\/|$)/, ['admin', 'personal', 'objektleitung']],
  // Buchhaltung braucht Urlaub/Krank für den Lohn (Ahmed 07.10.)
  [/^\/urlaub\/[0-9a-f-]{36}\/(loeschen|stunden)/, ['admin', 'personal', 'buchhaltung']],
  // Objektleitung: nur ihre eingeplanten Leute (Filter in routes-planning, Ahmed 14.10.)
  [/^\/urlaub(\/|$)/, ['admin', 'personal', 'buchhaltung', 'objektleitung']],
  [/^\/auswertungen\/(urlaub|krankheit|ausfallzeiten)([/.]|$)/, ['admin', 'personal', 'buchhaltung']],
  [/^\/auswertungen\/stunden([/.]|$)/, HR],
  [/^\/auswertungen\/dienste([/.]|$)/, ALL],
  [/^\/auswertungen\/?$/, ALL],
  // Objekte: Objektleitung nur eigene und ohne Preise/Rechnungen/Bearbeiten
  [
    /^\/objekte\/[0-9a-f-]{36}\/(leistungen|rechnungen|rechnungsangaben|bearbeiten|regie-abrechnen|angebote|vertrag)/,
    OFFICE,
  ],
  [/^\/objekte\/(export\.csv|qr-druck)$/, ['admin', 'buchhaltung', 'objektleitung']],
  // NU-Bestellung am Handy unterschreiben lassen: Objektleitung nur eigene Objekte (assertSite in der Route)
  [
    /^\/nachunternehmer\/auftraege\/[0-9a-f-]{36}\/(unterschreiben|unterschrift|auftrag\.pdf)$/,
    ['admin', 'buchhaltung', 'objektleitung'],
  ],
  [/^\/arbeitsscheine(\/|$)/, ['admin', 'buchhaltung', 'objektleitung']],
  [/^\/qm(\/|$)/, ALL],
  // Fotogruppen (Aufgabe fürs Büro); Objektleitung nur selbst aufgenommene (Prüfung in der Route)
  [/^\/fotos\/[0-9a-f-]{36}(\/|$)/, ALL],
  [/^\/(qualitaet|zaehler)(\/|$)/, ['admin', 'buchhaltung', 'objektleitung']],
  [
    /^\/objekte\/[0-9a-f-]{36}(\/(einsaetze|zeiten|qr|notizen|aufgaben|arbeitsscheine|raumbuch|stundenvorgabe|qualitaet|zaehler|dokumente|schluessel|uebergaben|objektordner|anwesenheit|aushang)([/.]|$)|$)/,
    ['admin', 'buchhaltung', 'objektleitung', 'personal'],
  ],
  [/^\/objekte\/?$/, ['admin', 'buchhaltung', 'objektleitung']],
  [/^\/(schluessel|geraete|uebergaben)(\/|$)/, ALL],
  [/^\/arbeitskleidung(\/|$)/, ['admin', 'buchhaltung', 'personal']],
  [/^\/(aufgaben|geplant)(\/|$)/, ALL],
  [/^\/(dateien|api\/uploads)(\/|$)/, ALL],
  [/^\/neu$/, ALL],
  [/^\/$/, ALL],
];

function defaultAccess(role: Role, path: string): boolean {
  for (const [re, roles] of RULES) if (re.test(path)) return roles.includes(role);
  return OFFICE.includes(role); // alles andere: Büro/Buchhaltung
}

/**
 * Rechte der Benutzergruppen selbst einstellen (Einstellungen → Rechte, Ahmed 21.10.): je Bereich und Rolle erlaubt/
 * gesperrt. Gespeichert werden nur Abweichungen von der Vorgabe (`app.role_permissions`). Admin hat immer alles; die
 * reinen Admin-Seiten (Benutzer, Firmendaten, Bank, E-Mail, System …) und Anmelde-/App-Seiten sind nicht einstellbar.
 */
export const PERM_ROLES = ['buchhaltung', 'personal', 'objektleitung'] as const;
export type PermRole = (typeof PERM_ROLES)[number];
export interface PermArea {
  key: string;
  label: string;
  prefixes: string[];
}
export const PERM_GROUPS: { label: string; areas: PermArea[] }[] = [
  {
    label: 'Kunden',
    areas: [
      { key: 'kunden', label: 'Kundenliste und Kundenakten', prefixes: ['/kunden'] },
      { key: 'objekte', label: 'Objekte', prefixes: ['/objekte'] },
      { key: 'aufgaben', label: 'Aufgaben', prefixes: ['/aufgaben'] },
      { key: 'akquise', label: 'Akquise', prefixes: ['/akquise'] },
      { key: 'preisanpassung', label: 'Preisanpassung', prefixes: ['/preisanpassung'] },
      { key: 'angebote', label: 'Angebote & Ausschreibungen', prefixes: ['/angebote', '/ausschreibungen'] },
    ],
  },
  {
    label: 'Rechnungen',
    areas: [
      { key: 'rechnungen', label: 'Rechnungen & Entwürfe', prefixes: ['/rechnungen'] },
      { key: 'offene-posten', label: 'Offene Posten', prefixes: ['/offene-posten'] },
      { key: 'mahnungen', label: 'Mahnwesen', prefixes: ['/mahnungen'] },
    ],
  },
  {
    label: 'Einkauf & Nachunternehmer',
    areas: [
      { key: 'nachunternehmer', label: 'Nachunternehmer', prefixes: ['/nachunternehmer'] },
      { key: 'lieferanten', label: 'Lieferanten', prefixes: ['/lieferanten'] },
      { key: 'bestellungen', label: 'Bestellungen', prefixes: ['/bestellungen'] },
      {
        key: 'rechnungseingang',
        label: 'Rechnungseingang & Zahlungsliste',
        prefixes: ['/rechnungseingang', '/zahlungsliste', '/zahlungslauf'],
      },
    ],
  },
  {
    label: 'Personal',
    areas: [
      { key: 'personal', label: 'Mitarbeiter & Personalakten', prefixes: ['/personal'] },
      { key: 'unterlagen', label: 'Fehlende Unterlagen', prefixes: ['/personal/unterlagen'] },
      { key: 'unterweisungen', label: 'Unterweisungen & Unterschriften', prefixes: ['/personal/dokumente'] },
      {
        key: 'lohnabrechnungen',
        label: 'Lohnabrechnungen einlesen',
        prefixes: ['/personal/lohnabrechnungen'],
      },
      { key: 'bewerber', label: 'Bewerber & Stellen', prefixes: ['/bewerber'] },
      { key: 'verbandbuch', label: 'Verbandbuch', prefixes: ['/verbandbuch'] },
    ],
  },
  {
    label: 'Zeit & Planung',
    areas: [
      { key: 'zeiterfassung', label: 'Zeiterfassung', prefixes: ['/zeiterfassung'] },
      {
        key: 'stundenliste',
        label: 'Stundenliste & Lohnarten',
        prefixes: ['/zeiterfassung/stundenzettel', '/zeiterfassung/lohnarten'],
      },
      { key: 'zeitkonto', label: 'Arbeitszeitkonto', prefixes: ['/zeiterfassung/arbeitszeitkonto'] },
      { key: 'planung', label: 'Einsatzplanung', prefixes: ['/einsatzplanung'] },
      { key: 'urlaub', label: 'Urlaub & Abwesenheiten', prefixes: ['/urlaub'] },
    ],
  },
  {
    label: 'Disposition & Inventar',
    areas: [
      { key: 'arbeitsscheine', label: 'Arbeitsscheine', prefixes: ['/arbeitsscheine'] },
      { key: 'qualitaet', label: 'Qualitätskontrolle', prefixes: ['/qualitaet'] },
      { key: 'glas', label: 'Glasreinigung', prefixes: ['/glasreinigung'] },
      { key: 'tiefgarage', label: 'Tiefgaragenreinigung', prefixes: ['/tiefgarage'] },
      { key: 'grundreinigung', label: 'Grundreinigung (mit Preisen)', prefixes: ['/grundreinigung'] },
      { key: 'artikel', label: 'Artikel', prefixes: ['/artikel'] },
      {
        key: 'materialausgabe',
        label: 'Materialausgabe (interner Lieferschein)',
        prefixes: ['/materialausgabe'],
      },
      { key: 'geraete', label: 'Geräte', prefixes: ['/geraete'] },
      { key: 'schluessel', label: 'Schlüsselbuch', prefixes: ['/schluessel'] },
      { key: 'fahrzeuge', label: 'Fahrzeuge', prefixes: ['/fahrzeuge'] },
    ],
  },
  {
    label: 'Verwaltung & Transfer',
    areas: [
      { key: 'kassenbuch', label: 'Kassenbuch', prefixes: ['/kassenbuch'] },
      { key: 'briefe', label: 'Briefe', prefixes: ['/verwaltung/briefe'] },
      { key: 'eigen-compliance', label: 'Eigen-Compliance', prefixes: ['/eigen-compliance'] },
      {
        key: 'bank',
        label: 'Bank (Kontoumsätze, Kontoauszug)',
        prefixes: ['/transfer/kontoumsaetze', '/transfer/kontoauszug'],
      },
      {
        key: 'dokumente',
        label: 'Dokumenteneingang & -versand',
        prefixes: ['/transfer/dokumenteneingang', '/transfer/dokumentenversand'],
      },
      { key: 'datev', label: 'DATEV-Export', prefixes: ['/datev'] },
      { key: 'importe', label: 'Importe', prefixes: ['/transfer/import', '/transfer/altdaten'] },
    ],
  },
  {
    label: 'Auswertungen & Einstellungen',
    areas: [
      {
        key: 'umsatz',
        label: 'Umsatz & Ausgaben',
        prefixes: ['/auswertungen/statistik', '/auswertungen/ausgaben', '/auswertungen/vorschau'],
      },
      {
        key: 'nachkalkulation',
        label: 'Nachkalkulation & Kostenstellen',
        prefixes: [
          '/auswertungen/nachkalkulation',
          '/auswertungen/plankalkulation',
          '/auswertungen/kostenstellen',
          '/auswertungen/stundensaetze',
        ],
      },
      {
        key: 'urlaub-krank',
        label: 'Urlaub & Krankheit (Auswertung)',
        prefixes: ['/auswertungen/urlaub', '/auswertungen/krankheit', '/auswertungen/ausfallzeiten'],
      },
      { key: 'dienste', label: 'Dienste-Liste', prefixes: ['/auswertungen/dienste'] },
      { key: 'einstellungen', label: 'Einstellungen (ohne Admin-Bereiche)', prefixes: ['/einstellungen'] },
    ],
  },
];
const AREAS = PERM_GROUPS.flatMap((g) => g.areas);
/** Seiten, die nur Admin öffnet bzw. immer offen sind – nie über die Einstellungen änderbar. */
const LOCKED = [
  /^\/(anmelden|abmelden|konto|static|health|m|app|qm)(\/|$)/,
  /^\/benutzer(\/|$)/,
  /^\/einstellungen\/(firma|nummernkreise|bankabruf|email|system|archiv|rechte|datenschutz)(\/|$)/,
  /^\/transfer\/bank\/rueckkehr$/,
  /^\/transfer\/import\/(dubletten|abgleich)$/,
];

/** Bereich einer Adresse: längster passender Anfang. */
export function areaOf(path: string): PermArea | null {
  let best: PermArea | null = null;
  let len = -1;
  for (const a of AREAS)
    for (const pre of a.prefixes)
      if ((path === pre || path.startsWith(pre + '/') || path.startsWith(pre + '.')) && pre.length > len) {
        best = a;
        len = pre.length;
      }
  return best;
}

let overrides = new Map<string, boolean>();
/** Abweichungen aus der Datenbank übernehmen (beim Start und nach dem Speichern). */
export function setPermissionOverrides(rows: { role: string; area: string; allowed: boolean }[]) {
  overrides = new Map(rows.map((r) => [`${r.role}:${r.area}`, r.allowed]));
}
export function permissionOverride(role: Role, area: string): boolean | undefined {
  return overrides.get(`${role}:${area}`);
}

/** Vorgabe eines Bereichs (ohne Einstellungen) = darf die Rolle die erste Adresse öffnen. */
export function defaultAreaAccess(role: Role, area: PermArea): boolean {
  return defaultAccess(role, area.prefixes[0]!);
}

export function canAccess(role: Role, path: string): boolean {
  if (role === 'admin' || LOCKED.some((re) => re.test(path))) return defaultAccess(role, path);
  const area = areaOf(path);
  if (area) {
    const o = overrides.get(`${role}:${area.key}`);
    if (o !== undefined) return o;
  }
  return defaultAccess(role, path);
}

/** Startseite je Rolle (Übersicht enthält Umsätze/Offene Posten → nur Büro). */
export function homeFor(role: Role): string {
  return role === 'personal' ? '/zeiterfassung' : '/';
}

const NEW_TARGET: Record<string, string> = {
  rechnung: '/rechnungen',
  angebot: '/angebote',
  kunde: '/kunden',
  interessent: '/kunden',
  objekt: '/objekte/neu',
  mitarbeiter: '/personal',
  aufgabe: '/aufgaben',
};

/** Menü-/Link-Ziel prüfen; „/neu?typ=…“ zählt wie die Seite, die damit angelegt wird. */
export function canOpen(role: Role, href: string): boolean {
  const [path, query] = href.split('?');
  if (path === '/neu') {
    const typ = new URLSearchParams(query ?? '').get('typ') ?? '';
    return canAccess(role, NEW_TARGET[typ] ?? '/');
  }
  return canAccess(role, path!);
}

/**
 * Links auf Seiten, die die Rolle nicht öffnen darf, aus fertigem HTML nehmen (Rechte-Rundgang 14.10.: Objektleitung
 * bekam z. B. Mitarbeiternamen als Link zur Personalakte → „Keine Berechtigung“). Knöpfe (class „btn“) entfallen ganz,
 * normale Links werden zu Text. Sicherheit bleibt die Regel oben – das hier ist nur Bedienung.
 */
export function stripForbiddenLinks(html: string, role: Role): string {
  return html.replace(
    /<a\b([^>]*?)\bhref="(\/[^"]*)"([^>]*)>([\s\S]*?)<\/a>/g,
    (all, pre: string, href: string, post: string, inner: string) => {
      if (href.startsWith('//')) return all;
      const path = href.replace(/&amp;/g, '&').split('#')[0]!;
      if (canOpen(role, path)) return all;
      const attrs = `${pre} ${post}`;
      if (/\bclass="[^"]*\bbtn\b/.test(attrs)) return '';
      return `<span>${inner}</span>`;
    },
  );
}
