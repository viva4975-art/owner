import { loadEnv } from '../config/env.js';
import { createSql } from '../db/client.js';
import { ensureSiteGroups } from '../services/masterdata.js';
import { seedCompany, seedDemo, seedDemoModules } from '../services/seed.js';

const env = loadEnv();
const sql = createSql(env.DATABASE_URL);
try {
  if (process.argv.includes('--demo')) {
    if (env.APP_ENV === 'live') throw new Error('Demo-Daten niemals im Live-Betrieb');
    await seedDemo(sql);
    await seedDemoModules(sql);
    await ensureSiteGroups(sql);
    console.log('Firmenstamm und Demo-Daten angelegt.');
  } else {
    await seedCompany(sql);
    console.log('Firmenstamm angelegt.');
  }
} finally {
  await sql.end();
}
