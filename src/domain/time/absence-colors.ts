import type { AbsenceKind } from '../../services/absences.js';

/*
 * Eine Farbe je Abwesenheitsart – überall gleich (Einsatzkalender, Urlaubskalender, Stundenliste, Lohnarten, PDFs),
 * damit Urlaub, Krank, Kind krank, unbezahlt und Sonstiges auf einen Blick zu unterscheiden sind.
 * Rot bleibt „keine Zeit erfasst“, Bordeaux „Zeit bestätigt“ – deshalb Krank orange.
 */
export interface AbsenceColor {
  /** kräftig: Balken, Punkte */
  solid: string;
  /** hell: Hintergrund von Zeilen/Kacheln */
  tint: string;
  /** Schrift auf hellem Grund */
  ink: string;
  border: string;
}

export const ABSENCE_COLORS: Record<AbsenceKind, AbsenceColor> = {
  urlaub: { solid: '#2f9e5b', tint: '#dcf1e3', ink: '#1a5e37', border: '#9fd2b2' },
  krank: { solid: '#e07b1a', tint: '#fde6cf', ink: '#8a4508', border: '#f0b47a' },
  kind_krank: { solid: '#c99a00', tint: '#fbf0c4', ink: '#6b5200', border: '#e6cc6a' },
  unbezahlt: { solid: '#6b7280', tint: '#e5e7eb', ink: '#374151', border: '#b7bcc5' },
  sonstiges: { solid: '#8a5cc7', tint: '#ece3f7', ink: '#5b2f97', border: '#c7b0e6' },
};

export const ABSENCE_KINDS = Object.keys(ABSENCE_COLORS) as AbsenceKind[];

/** Hex → RGB 0..1 (für pdf-lib) */
export function rgb01(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** CSS-Regeln je Art: sel(k) liefert den Selektor, body(c) den Inhalt. */
export function absenceCss(sel: (k: AbsenceKind) => string, body: (c: AbsenceColor) => string): string {
  return ABSENCE_KINDS.map((k) => `${sel(k)}{${body(ABSENCE_COLORS[k])}}`).join('\n');
}
