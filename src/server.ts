import { serve } from '@hono/node-server';
import { LocalArchiveStore } from './archive/store.js';
import { loadEnv } from './config/env.js';
import { createSql } from './db/client.js';
import { createMailer } from './mail/mailer.js';
import { createApp } from './web/app.js';

const env = loadEnv();
const sql = createSql(env.DATABASE_URL);
const app = createApp({
  sql,
  env,
  archive: new LocalArchiveStore(env.ARCHIVE_DIR),
  mailer: createMailer(env),
});

serve({ fetch: app.fetch, port: env.PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`Viva-Deluxe App (${env.APP_ENV}) läuft auf http://127.0.0.1:${info.port}`);
  if (env.MAIL_TEST_RECIPIENT) console.log(`Mailversand nur an Testadresse: ${env.MAIL_TEST_RECIPIENT}`);
});

const shutdown = async () => {
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
