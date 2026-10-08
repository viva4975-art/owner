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
  [/^\/benutzer(\/|$)/, ['admin']],
  [/^\/einstellungen\/firma(\/|$)/, ['admin']],
  [/^\/einstellungen\/nummernkreise(\/|$)/, ['admin']],
  [/^\/einstellungen\/erinnerungen(\/|$)/, ['admin', 'buchhaltung']],
  [/^\/erinnerungen(\/|$)/, ['admin', 'buchhaltung']],
  [/^\/monatsabschluss(\/|$)/, ['admin', 'buchhaltung']],
  [/^\/personal\/lohnabrechnungen(\/|$)/, ['admin', 'personal', 'buchhaltung']],
  [/^\/grundreinigung\/objektleitung$/, ['admin', 'buchhaltung', 'personal', 'objektleitung']],
  [/^\/einstellungen\/?$/, ['admin', 'buchhaltung', 'personal']],
  [/^\/einstellungen\/word-vorlagen(\/|$)/, ['admin', 'buchhaltung', 'personal']],
  [/^\/einstellungen\/objektordner(\/|$)/, ['admin', 'buchhaltung', 'personal']],
  [/^\/word-vorlagen\/(erzeugen|ausfuellen)$/, ALL],
  [/^\/transfer\/import\/(dubletten|abgleich)$/, ['admin']],
  [/^\/vorlagen\/?$/, ['admin', 'buchhaltung', 'personal']],
  [/^\/auswertungen\/kostenstellen([/.]|$)/, ['admin', 'buchhaltung']],
  [/^\/personal\/export/, HR],
  [/^\/bewerber(\/|$)/, HR],
  [/^\/personal(\/|$)/, HR],
  [/^\/zeiterfassung\/(meine(\/|$)|plan-als-ist$)/, ALL],
  [/^\/zeiterfassung\/(stundenzettel|lohnarten|arbeitszeitkonto)/, ['admin', 'personal', 'buchhaltung']],
  [/^\/zeiterfassung\/(monat|pruefbericht|einstellungen)/, HR],
  [/^\/(zeiterfassung|einsatzplanung)(\/|$)/, ['admin', 'personal', 'objektleitung']],
  // Buchhaltung braucht Urlaub/Krank für den Lohn (Ahmed 07.10.)
  [/^\/urlaub(\/|$)/, ['admin', 'personal', 'buchhaltung']],
  [/^\/auswertungen\/(urlaub|krankheit)([/.]|$)/, ['admin', 'personal', 'buchhaltung']],
  [/^\/auswertungen\/stunden([/.]|$)/, HR],
  [/^\/auswertungen\/dienste([/.]|$)/, ALL],
  [/^\/auswertungen\/?$/, ALL],
  // Objekte: Objektleitung nur eigene und ohne Preise/Rechnungen/Bearbeiten
  [
    /^\/objekte\/[0-9a-f-]{36}\/(leistungen|rechnungen|rechnungsangaben|bearbeiten|regie-abrechnen|angebote)/,
    OFFICE,
  ],
  [/^\/objekte\/(export\.csv|qr-druck)$/, ['admin', 'buchhaltung', 'objektleitung']],
  [/^\/arbeitsscheine(\/|$)/, ['admin', 'buchhaltung', 'objektleitung']],
  [/^\/qm(\/|$)/, ALL],
  [/^\/(qualitaet|zaehler)(\/|$)/, ['admin', 'buchhaltung', 'objektleitung']],
  [
    /^\/objekte\/[0-9a-f-]{36}(\/(einsaetze|zeiten|qr|notizen|aufgaben|arbeitsscheine|raumbuch|stundenvorgabe|qualitaet|zaehler|dokumente|schluessel|uebergaben|objektordner)([/.]|$)|$)/,
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

export function canAccess(role: Role, path: string): boolean {
  for (const [re, roles] of RULES) if (re.test(path)) return roles.includes(role);
  return OFFICE.includes(role); // alles andere: Büro/Buchhaltung
}

/** Startseite je Rolle (Übersicht enthält Umsätze/Offene Posten → nur Büro). */
export function homeFor(role: Role): string {
  return role === 'objektleitung' ? '/zeiterfassung' : role === 'personal' ? '/zeiterfassung' : '/';
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
