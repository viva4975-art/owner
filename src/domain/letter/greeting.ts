/*
 * Automatische Briefanrede (Ahmed 10.10.: „überall automatische Anrede“). Grundlage ist entweder eine Person mit
 * Anrede (Mitarbeiter, Kontakt) oder der freie Text „Ansprechpartner“ einer Rechnungsgruppe („Frau Dr. Anna Müller“,
 * „z. Hd. Herrn Schmidt“). Ohne erkennbares Geschlecht: „Sehr geehrte Damen und Herren,“ – bei Personen ohne Anrede
 * (divers/unbekannt) „Guten Tag Vorname Nachname,“.
 */

const NEUTRAL = 'Sehr geehrte Damen und Herren,';
const TITLE = /^(dr\.?|prof\.?|dipl\.-[\wäöü.]+|mag\.?|ing\.?)$/i;

function polite(sal: 'Frau' | 'Herr', titles: string[], last: string) {
  const name = [...titles, last].join(' ');
  return sal === 'Frau' ? `Sehr geehrte Frau ${name},` : `Sehr geehrter Herr ${name},`;
}

/** Person mit gepflegter Anrede (Herr/Frau/divers). */
export function personGreeting(p: {
  salutation?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}): string {
  const last = p.last_name?.trim();
  if (!last) return NEUTRAL;
  const s = p.salutation?.trim().toLowerCase() ?? '';
  if (s.startsWith('frau')) return polite('Frau', [], last);
  if (s.startsWith('herr')) return polite('Herr', [], last);
  const full = [p.first_name?.trim(), last].filter(Boolean).join(' ');
  return `Guten Tag ${full},`;
}

/**
 * Anrede aus einem freien Ansprechpartner-Text. Nur „Frau …“/„Herr(n) …“ ergibt eine persönliche Anrede (Nachname =
 * letztes Wort, Titel wie „Dr.“ bleiben); „Buchhaltung“, „Max Müller“ usw. → „Sehr geehrte Damen und Herren,“, sofern
 * `known` keine Person mit Anrede für diesen Namen liefert.
 */
export function contactGreeting(
  text: string | null | undefined,
  known?: { salutation?: string | null; first_name?: string | null; last_name?: string | null }[],
): string {
  const t = (text ?? '')
    .replace(/^\s*(z\.\s*hd\.?|zu händen|attn\.?)\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return NEUTRAL;
  const m = /^(frau|herrn?)\s+(.+)$/i.exec(t);
  if (m) {
    const words = m[2]!.split(' ').filter(Boolean);
    const last = words[words.length - 1]!;
    const titles = words.slice(0, -1).filter((w) => TITLE.test(w));
    return polite(/^frau/i.test(m[1]!) ? 'Frau' : 'Herr', titles, last);
  }
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const hit = known?.find(
    (k) =>
      k.last_name &&
      /^(frau|herr)/i.test(k.salutation ?? '') &&
      (norm(`${k.first_name ?? ''} ${k.last_name}`) === norm(t) || norm(k.last_name) === norm(t)),
  );
  return hit ? personGreeting(hit) : NEUTRAL;
}

export const NEUTRAL_GREETING = NEUTRAL;

/** „Sehr geehrte Damen und Herren,“ am Anfang eines gespeicherten Einleitungstextes entfernen (wird neu gesetzt). */
export function stripGreeting(t: string | null | undefined): string {
  return (t ?? '').replace(/^\s*(Sehr geehrte[^,\n]*|Guten Tag[^,\n]*),?\s*/i, '').trim();
}
