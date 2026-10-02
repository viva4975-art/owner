import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalArchiveStore } from '../archive/store.js';
import { loadEnv } from '../config/env.js';
import { type Sql, createSql } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import type { Mailer, OutgoingMail } from '../mail/mailer.js';
import { seedDemo } from './seed.js';
import type { Deps } from './workflow.js';

/** Testdatenbank: TEST_DATABASE_URL oder lokale Standard-DB. Wird bei jedem Lauf neu aufgebaut. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:54322/viva_test';

/**
 * In der CI (REQUIRE_SERVICES=1) dürfen Integrationstests nicht still übersprungen werden.
 */
export function requireService(available: boolean, name: string): boolean {
  if (!available && process.env.REQUIRE_SERVICES === '1') {
    throw new Error(`${name} ist nicht erreichbar, wird aber in der CI benötigt`);
  }
  return available;
}

export async function kositAvailable(): Promise<boolean> {
  const url = process.env.KOSIT_VALIDATOR_URL ?? 'http://127.0.0.1:8081';
  const ok = await fetch(new URL('/server/health', url), { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false);
  return requireService(ok, 'KoSIT-Validator');
}

export async function dbAvailable(): Promise<boolean> {
  return requireService(await dbReachable(), 'Test-Datenbank');
}

async function dbReachable(): Promise<boolean> {
  const sql = createSql(TEST_DATABASE_URL);
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

export async function freshDatabase(): Promise<Sql> {
  if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(TEST_DATABASE_URL)) {
    throw new Error('Tests laufen nur gegen eine lokale Datenbank (setzt das Schema zurück!)');
  }
  const sql = createSql(TEST_DATABASE_URL);
  await sql.unsafe('drop schema if exists app cascade; drop table if exists public.schema_migrations;');
  await migrate(sql, { local: true });
  await seedDemo(sql);
  return sql;
}

export class FakeMailer implements Mailer {
  sent: OutgoingMail[] = [];
  failNext = false;
  async send(mail: OutgoingMail) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('SMTP nicht erreichbar');
    }
    this.sent.push(mail);
    return { messageId: mail.messageId };
  }
}

export async function testDeps(sql: Sql): Promise<Deps & { mailer: FakeMailer }> {
  const env = loadEnv({
    APP_ENV: 'dev',
    DATABASE_URL: TEST_DATABASE_URL,
    MAIL_TEST_RECIPIENT: 'test@viva-deluxe.local',
    APP_BASIC_AUTH: 'test:testtesttest',
    KOSIT_VALIDATOR_URL: process.env.KOSIT_VALIDATOR_URL ?? 'http://127.0.0.1:8081',
  });
  const archive = new LocalArchiveStore(await mkdtemp(join(tmpdir(), 'viva-archive-')));
  return { sql, env, archive, mailer: new FakeMailer() };
}
