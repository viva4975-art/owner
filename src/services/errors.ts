/** Fachlicher Fehler: wird dem Benutzer als Meldung angezeigt (kein Programmfehler). */
export class BusinessError extends Error {
  /** Kennung für übersetzte Meldungen (Mitarbeiter-Ansicht in mehreren Sprachen). */
  readonly code: string | undefined;
  readonly params: Record<string, string>;
  constructor(message?: string, code?: string, params: Record<string, string> = {}) {
    super(message);
    this.code = code;
    this.params = params;
  }
}
