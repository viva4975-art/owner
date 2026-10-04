import { loadEnv } from '../config/env.js';
import { createSql } from '../db/client.js';
import { migrate } from '../db/migrate.js';

/*
 * Migrationen einspielen.
 *   lokal:     npm run db:migrate
 *   Supabase:  npm run db:migrate:supabase -- --projekt=<projekt-ref>
 * Für Supabase muss der Projekt-Ref zur Sicherheit zusätzlich auf der Kommandozeile stehen und mit
 * SUPABASE_PROJECT_REF übereinstimmen (Schutz gegen das falsche Projekt; das alte Projekt lehnt loadEnv ohnehin ab).
 */
const env = loadEnv();
if (env.APP_ENV !== 'dev') {
  const arg = process.argv.find((a) => a.startsWith('--projekt='))?.slice('--projekt='.length);
  if (!arg || arg !== env.SUPABASE_PROJECT_REF) {
    console.error(
      `Abbruch: bitte --projekt=${env.SUPABASE_PROJECT_REF ?? '<ref>'} angeben (Bestätigung des Ziels, Umgebung ${env.APP_ENV}).`,
    );
    process.exit(1);
  }
  console.log(
    `Ziel: Supabase-Projekt ${env.SUPABASE_PROJECT_REF} (${env.SUPABASE_REGION}), Umgebung ${env.APP_ENV}`,
  );
}
const sql = createSql(env.DATABASE_URL);
try {
  const done = await migrate(sql, { local: env.APP_ENV === 'dev' });
  console.log(done.length ? `Eingespielt: ${done.join(', ')}` : 'Datenbank ist aktuell.');
} finally {
  await sql.end();
}
