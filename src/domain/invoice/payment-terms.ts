/**
 * Zahlungsbedingungen zur Auswahl (Ahmed 10.10.: „nicht hinschreiben, sondern auswählen“). Standard, wenn nichts
 * bekannt ist: 10 Tage netto ohne Skonto. Wert im Formular: „Tage“ oder „Tage/Skonto-%/Skonto-Tage“ (z. B. 20/3/7);
 * „andere“ blendet die Einzelfelder ein (z. B. für übernommene Sonderfälle).
 */
export interface PaymentTerms {
  days: number;
  /** Skonto in Basispunkten (300 = 3 %) */
  skontoBp: number | null;
  skontoDays: number | null;
}

export const DEFAULT_TERMS: PaymentTerms = { days: 10, skontoBp: null, skontoDays: null };

export const TERMS_PRESETS: PaymentTerms[] = [
  { days: 10, skontoBp: null, skontoDays: null },
  { days: 0, skontoBp: null, skontoDays: null },
  { days: 7, skontoBp: null, skontoDays: null },
  { days: 14, skontoBp: null, skontoDays: null },
  { days: 20, skontoBp: null, skontoDays: null },
  { days: 30, skontoBp: null, skontoDays: null },
  { days: 45, skontoBp: null, skontoDays: null },
  { days: 60, skontoBp: null, skontoDays: null },
  { days: 14, skontoBp: 200, skontoDays: 7 },
  { days: 20, skontoBp: 300, skontoDays: 7 },
  { days: 30, skontoBp: 200, skontoDays: 10 },
  { days: 30, skontoBp: 300, skontoDays: 10 },
  { days: 30, skontoBp: 300, skontoDays: 14 },
  { days: 60, skontoBp: 300, skontoDays: 14 },
];

export const termsKey = (t: PaymentTerms) =>
  t.skontoBp && t.skontoDays ? `${t.days}/${t.skontoBp / 100}/${t.skontoDays}` : String(t.days);

export function termsLabel(t: PaymentTerms): string {
  const net = t.days === 0 ? 'sofort ohne Abzug' : `${t.days} Tage netto`;
  if (!t.skontoBp || !t.skontoDays) return t.days === 0 ? net : `${net} ohne Skonto`;
  return `${net}, ${String(t.skontoBp / 100).replace('.', ',')} % Skonto bei Zahlung in ${t.skontoDays} Tagen`;
}

export function parseTermsKey(key: string): PaymentTerms | null {
  const m = /^(\d{1,3})(?:\/(\d+(?:[.,]\d{1,2})?)\/(\d{1,2}))?$/.exec(key.trim());
  if (!m) return null;
  return {
    days: Number(m[1]),
    skontoBp: m[2] ? Math.round(Number(m[2].replace(',', '.')) * 100) : null,
    skontoDays: m[3] ? Number(m[3]) : null,
  };
}

/** Ist die Bedingung eine der Vorgaben? Sonst zeigt das Formular „andere …“ mit den Einzelfeldern. */
export const isPreset = (t: PaymentTerms) => TERMS_PRESETS.some((p) => termsKey(p) === termsKey(t));

/**
 * Formularfeld `<prefix>terms` (Auswahl) in die Einzelfelder übersetzen. Bei „andere“ bleiben die Einzelfelder.
 * names: Feldnamen für Tage, Skonto-% (als Text „3“) und Skonto-Tage.
 */
export function applyTermsChoice(
  body: Record<string, unknown>,
  choiceField: string,
  names: { days: string; percent: string; skontoDays: string },
) {
  const v = body[choiceField];
  if (typeof v !== 'string' || v === '' || v === 'andere') return body;
  const t = parseTermsKey(v);
  if (!t) return body;
  return {
    ...body,
    [names.days]: String(t.days),
    [names.percent]: t.skontoBp ? String(t.skontoBp / 100) : '',
    [names.skontoDays]: t.skontoDays ? String(t.skontoDays) : '',
  };
}
