import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sql } from './client.js';

const ROOT = new URL('../../supabase/', import.meta.url).pathname;

/**
 * Spielt die SQL-Migrationen aus supabase/migrations ein (gleiche Dateien wie `supabase db push`).
 * Mit `local: true` wird vorher der Supabase-Shim für reines Postgres eingespielt.
 */
export async function migrate(sql: Sql, opts: { local: boolean }): Promise<string[]> {
  // Shim nur auf reinem Postgres – im Supabase-Image/-Projekt gibt es auth.uid() schon (und es gehört nicht uns).
  if (opts.local) {
    const [{ has }] = (await sql`select to_regprocedure('auth.uid()') is not null as has`) as unknown as [
      { has: boolean },
    ];
    if (!has) await sql.unsafe(await readFile(join(ROOT, 'local/00_supabase_shim.sql'), 'utf8'));
  }
  await sql`create table if not exists public.schema_migrations (
    version text primary key, applied_at timestamptz not null default now())`;
  const applied = new Set(
    (await sql<{ version: string }[]>`select version from public.schema_migrations`).map((r) => r.version),
  );
  const files = (await readdir(join(ROOT, 'migrations'))).filter((f) => f.endsWith('.sql')).sort();
  const done: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await readFile(join(ROOT, 'migrations', file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into public.schema_migrations (version) values (${file})`;
    });
    done.push(file);
  }
  return done;
}
