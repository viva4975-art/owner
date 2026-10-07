import { serve } from '@hono/node-server';
import { LocalArchiveStore } from './archive/store.js';
import { loadEnv } from './config/env.js';
import { createSql } from './db/client.js';
import { createMailer } from './mail/mailer.js';
import { configureAuthAdmin } from './services/auth-users.js';
import { applyDueHours } from './services/employee-hours.js';
import { createApp } from './web/app.js';

const env = loadEnv();
const sql = createSql(env.DATABASE_URL);
// In Supabase: Konten über die Auth-Admin-API anlegen (Service-Key bleibt auf dem Server)
if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
  configureAuthAdmin({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY });
}
const app = createApp({
  sql,
  env,
  archive: new LocalArchiveStore(env.ARCHIVE_DIR),
  mailer: createMailer(env),
});

// Im Container (HOST=0.0.0.0) von außen erreichbar, sonst nur lokal
const hostname = process.env.HOST ?? '127.0.0.1';
serve({ fetch: app.fetch, port: env.PORT, hostname }, (info) => {
  console.log(`Viva-Deluxe App (${env.APP_ENV}) läuft auf http://${hostname}:${info.port}`);
  if (!env.SMTP_HOST) console.log('Hinweis: kein SMTP-Zugang – Mailversand ist abgeschaltet.');
  if (env.MAIL_TEST_RECIPIENT) console.log(`Mailversand nur an Testadresse: ${env.MAIL_TEST_RECIPIENT}`);
});

// Wochenstunden mit „gültig ab“ in der Zukunft: am Stichtag übernehmen (beim Start und stündlich)
const dueHours = () => applyDueHours(sql).catch((e) => console.error('Wochenstunden übernehmen:', e));
void dueHours();
setInterval(dueHours, 60 * 60 * 1000).unref();

const shutdown = async () => {
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
