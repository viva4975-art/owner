import { loadEnv } from '../config/env.js';
import { createSql } from '../db/client.js';
import { resetPassword } from '../services/users.js';

/*
 * Passwort vergessen (auf dem Server, im Container):
 *   docker compose --env-file .env.live exec app npx tsx src/scripts/reset-password.ts <benutzername>
 * Setzt ein Einmal-Passwort (muss bei der Anmeldung geändert werden) und hebt eine Sperre nach Fehlversuchen auf.
 * Ohne Benutzername: Liste der Benutzer.
 */
const env = loadEnv();
const sql = createSql(env.DATABASE_URL);
try {
  const login = process.argv[2]?.trim().toLowerCase();
  const users = await sql<{ id: string; login: string; role: string; active: boolean }[]>`
    select a.id, a.login, p.role::text as role, a.active
      from app.user_accounts a join app.profiles p on p.user_id = a.id order by a.login`;
  const u = users.find((x) => x.login === login);
  if (!u) {
    console.log(login ? `Benutzer „${login}“ nicht gefunden.` : 'Bitte Benutzername angeben.');
    console.log(`Vorhandene Benutzer: ${users.map((x) => `${x.login} (${x.role})`).join(', ') || '–'}`);
    process.exitCode = 1;
  } else {
    const pw = await resetPassword(sql, u.id, 'server-konsole');
    console.log(`Einmal-Passwort für ${u.login}: ${pw}`);
    console.log('Damit anmelden, danach wird ein neues Passwort verlangt.');
  }
} finally {
  await sql.end();
}
