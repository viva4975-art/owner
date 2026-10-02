import { loadEnv } from '../config/env.js';
import { createSql } from '../db/client.js';
import { migrate } from '../db/migrate.js';

const env = loadEnv();
const sql = createSql(env.DATABASE_URL);
try {
  const done = await migrate(sql, { local: env.APP_ENV === 'dev' });
  console.log(done.length ? `Eingespielt: ${done.join(', ')}` : 'Datenbank ist aktuell.');
} finally {
  await sql.end();
}
