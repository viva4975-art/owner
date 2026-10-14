/**
 * Stand der App (Ahmed 14.10.: Änderung „immer noch gleich“ – war das Update schon da?). deploy/update.sh schreibt vor
 * dem Bauen `version.txt` (Commit, Datum, Betreff); lokal ohne Datei: „Entwicklung“.
 */
import { readFileSync } from 'node:fs';

let cached: string | null = null;
export function appVersion(): string {
  if (cached !== null) return cached;
  try {
    cached = readFileSync(new URL('../../version.txt', import.meta.url), 'utf8').trim() || 'unbekannt';
  } catch {
    cached = 'Entwicklung (ohne version.txt)';
  }
  return cached;
}
