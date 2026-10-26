export interface ValidationMessage {
  level: 'error' | 'warning' | 'information';
  code: string;
  text: string;
}

export interface ValidationResult {
  valid: boolean;
  /** Vollständiger KoSIT-Prüfbericht (XML) – wird mit archiviert. */
  reportXml: string;
  messages: ValidationMessage[];
}

/**
 * Prüft ein E-Rechnungs-XML gegen den KoSIT-Validator (Daemon-Modus, HTTP POST).
 * Nicht erreichbar oder Zeitüberschreitung → Fehler (niemals "gültig" annehmen).
 */
export async function validateWithKosit(
  xml: string,
  baseUrl: string,
  timeoutMs = 30_000,
): Promise<ValidationResult> {
  let res: Response;
  try {
    res = await fetch(new URL('/', baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: xml,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`KoSIT-Validator nicht erreichbar (${baseUrl}): ${(err as Error).message}`, {
      cause: err,
    });
  }
  const reportXml = await res.text();
  // 200 = annehmen, 406 = ablehnen; alles andere ist ein Fehler des Validators.
  if (res.status !== 200 && res.status !== 406) {
    throw new Error(`KoSIT-Validator antwortet mit HTTP ${res.status}`);
  }
  const messages = parseMessages(reportXml);
  const valid = res.status === 200 && !messages.some((m) => m.level === 'error');
  return { valid, reportXml, messages };
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function parseMessages(reportXml: string): ValidationMessage[] {
  const out: ValidationMessage[] = [];
  const re = /<rep:message\b([^>]*)>([\s\S]*?)<\/rep:message>/g;
  for (const m of reportXml.matchAll(re)) {
    const attrs = m[1] ?? '';
    const level = /level="([a-z]+)"/.exec(attrs)?.[1] as ValidationMessage['level'] | undefined;
    const code = /code="([^"]*)"/.exec(attrs)?.[1] ?? '';
    out.push({ level: level ?? 'error', code, text: decode((m[2] ?? '').trim()) });
  }
  return out;
}

/**
 * Grund der Ablehnung in Worten, wenn der Prüfbericht keine Fehlermeldung mit Code enthält (z. B. kein Prüfszenario
 * gegriffen, Verarbeitungsfehler). Liefert den Bewertungstext aus der Erklärung bzw. die Warnungen.
 */
export function rejectReason(r: Pick<ValidationResult, 'reportXml' | 'messages'>): string {
  const strip = (h: string) =>
    decode(h.replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
  const parts: string[] = [];
  if (/noScenarioMatched|kein Pruefszenario|keinem zulässigen Dokumenttyp/i.test(r.reportXml))
    parts.push('Dokumenttyp nicht erkannt (kein Prüfszenario hat gegriffen)');
  for (const m of r.reportXml.matchAll(
    /<(?:rep:)?processingError\b[^>]*>([\s\S]*?)<\/(?:rep:)?processingError>/g,
  ))
    parts.push(`Verarbeitungsfehler: ${strip(m[1] ?? '')}`);
  const explanation = /<rep:explanation\b[^>]*>([\s\S]*?)<\/rep:explanation>/.exec(r.reportXml)?.[1] ?? '';
  for (const m of explanation.matchAll(/<p class="[^"]*error[^"]*">([\s\S]*?)<\/p>/g)) {
    const t = strip(m[1] ?? '');
    if (t) parts.push(t);
  }
  for (const w of r.messages.filter((m) => m.level === 'warning').slice(0, 5))
    parts.push(`${w.code}: ${w.text}`);
  return (
    [...new Set(parts)].join('\n') ||
    'Der Prüfbericht nennt keinen Grund – bitte „KoSIT-Prüfung“ am Entwurf öffnen.'
  );
}
