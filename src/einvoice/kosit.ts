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
