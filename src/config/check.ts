import { loadEnv } from './env.js';

try {
  const env = loadEnv();
  console.log(
    `Konfiguration OK: ${env.APP_ENV}, Supabase ${env.SUPABASE_PROJECT_REF} (${env.SUPABASE_REGION})`,
  );
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
