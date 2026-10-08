import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * Eingespielte Migrationen werden auf dem Server nie erneut ausgeführt. Wer eine vorhandene Datei nachträglich ändert,
 * erzeugt Server ohne die Änderung (Fund 08.10.: invoice_groups.dunning_emails). Änderungen daher immer als NEUE Datei;
 * danach `node scripts/migrations-lock.mjs`.
 */
const dir = new URL('../../supabase/migrations/', import.meta.url);
const lock = JSON.parse(
  readFileSync(new URL('../../supabase/migration-checksums.json', import.meta.url), 'utf8'),
) as Record<string, string>;

describe('Migrationen unverändert', () => {
  it('jede Migration ist festgeschrieben und seitdem nicht geändert', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
    const missing = files.filter((f) => !lock[f]);
    expect(missing, 'neue Migration: node scripts/migrations-lock.mjs ausführen').toEqual([]);
    const changed = files.filter(
      (f) =>
        createHash('sha256')
          .update(readFileSync(new URL(f, dir)))
          .digest('hex') !== lock[f],
    );
    expect(changed, 'bereits festgeschriebene Migration geändert – stattdessen neue Datei anlegen').toEqual(
      [],
    );
  });
});
