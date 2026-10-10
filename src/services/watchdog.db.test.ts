import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { collectReminders } from './reminders.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import { checkBackup, diskVerdict, watch } from './watchdog.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();
const GB = 1024 ** 3;

describe('Systemwächter (ohne Datenbank)', () => {
  it('Speicherplatz: rot unter 5 GB, gelb unter 15 %', () => {
    expect(diskVerdict(3 * GB, 100 * GB)).toMatchObject({ ok: false, level: 'rot' });
    expect(diskVerdict(10 * GB, 100 * GB)).toMatchObject({ ok: false, level: 'gelb' });
    expect(diskVerdict(50 * GB, 100 * GB).ok).toBe(true);
  });

  it('Sicherung: fehlt / zu alt / in Ordnung', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sich-'));
    try {
      expect((await checkBackup(dir))!.ok).toBe(false);
      const f = join(dir, 'datenbank_2026-10-10_0230.dump');
      await writeFile(f, Buffer.alloc(20_000));
      const now = new Date();
      expect((await checkBackup(dir, now))!.ok).toBe(true);
      const old = new Date(now.getTime() - 30 * 3_600_000);
      await utimes(f, old, old);
      const r = (await checkBackup(dir, now))!;
      expect(r).toMatchObject({ ok: false, level: 'rot' });
      expect(r.detail).toMatch(/30 Std\. alt/);
      expect(await checkBackup(undefined)).toBeNull();
      await rm(f);
      await writeFile(join(dir, 'letzte-sicherung.txt'), '123456\n');
      expect((await checkBackup(dir))!.ok).toBe(true);
      await writeFile(join(dir, 'letzte-sicherung.txt'), '12\n');
      expect((await checkBackup(dir))!.detail).toMatch(/verdächtig klein/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe.skipIf(!available)('Systemwächter (Datenbank)', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  let dir: string;
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
    dir = await mkdtemp(join(tmpdir(), 'sich-'));
    deps.env = {
      ...deps.env,
      BACKUP_DIR: dir,
      KOSIT_VALIDATOR_URL: 'http://127.0.0.1:9',
      ALERT_EMAIL: 'chef@example.de',
    };
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await sql?.end();
  });

  it('meldet Störung einmal am Tag, dann Entwarnung', async () => {
    const day = new Date('2026-10-10T08:00:00Z');
    expect(await watch(deps, day)).toBe(1);
    const m = deps.mailer.sent.at(-1)!;
    expect(m.subject).toMatch(/STÖRUNG.*Sicherung/);
    expect(m.text).toMatch(/KoSIT/);
    // gleiche Störung am selben Tag: keine zweite Mail
    expect(await watch(deps, new Date('2026-10-10T09:00:00Z'))).toBe(0);
    const rem = await collectReminders(sql, '2026-10-10');
    expect(rem.some((r) => r.area === 'System' && r.level === 'rot')).toBe(true);
    // Sicherung da → Entwarnung für die Sicherung (KoSIT bleibt gestört)
    await writeFile(join(dir, 'datenbank_x.dump'), Buffer.alloc(20_000));
    const n = deps.mailer.sent.length;
    expect(await watch(deps, new Date())).toBeGreaterThanOrEqual(1);
    expect(deps.mailer.sent.slice(n).some((x) => /Entwarnung.*Sicherung/.test(x.subject))).toBe(true);
  });
});
