// Prüfsummen aller Migrationen festschreiben (nach dem Anlegen einer NEUEN Migration ausführen).
// Bestehende Einträge werden nie überschrieben – eine geänderte alte Migration fällt im Test auf.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
const dir = new URL('../supabase/migrations/', import.meta.url);
const lockFile = new URL('../supabase/migration-checksums.json', import.meta.url);
const lock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : {};
for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort())
  lock[f] ??= createHash('sha256').update(readFileSync(new URL(f, dir))).digest('hex');
writeFileSync(lockFile, JSON.stringify(lock, null, 1) + '\n');
console.log(`${Object.keys(lock).length} Migrationen festgeschrieben`);
