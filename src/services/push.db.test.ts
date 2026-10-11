import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { savePushSubscription, sendPush, vapidKeys } from './push.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();
const env = { SESSION_SECRET: 'x'.repeat(40), APP_BASIC_AUTH: 'admin:test', APP_ENV: 'test' } as const;
const b64u = (b: Buffer) => b.toString('base64url');

describe.skipIf(!available)('Push-Nachrichten', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Schlüssel einmal erzeugt, Abo geprüft, Nachricht mit Schlüssel nur einmal', async () => {
    const k1 = await vapidKeys(sql, env);
    expect(k1.publicKey.length).toBeGreaterThan(80);
    const [cfg] = await sql<{ n: number }[]>`select count(*)::int as n from app.push_config`;
    expect(cfg!.n).toBe(1);

    await expect(
      savePushSubscription(sql, { endpoint: 'http://x' }, { userId: randomUUID() }, null),
    ).rejects.toThrow('Ungültiges Push-Abo');
    const emp = { id: randomUUID() };
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type)
              values (${emp.id}, '9901', 'Push', 'Test', '2026-01-01', 'minijob')`;
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const sub = {
      endpoint: 'https://127.0.0.1:9/push/' + randomUUID(),
      keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(randomBytes(16)) },
    };
    await savePushSubscription(sql, sub, { employeeId: emp.id }, 'Test');
    await savePushSubscription(sql, sub, { userId: randomUUID() }, 'Test');
    const [row] = await sql<{ employee_id: string; user_id: string | null }[]>`
      select employee_id, user_id from app.push_subscriptions where endpoint = ${sub.endpoint}`;
    expect(row!.employee_id).toBe(emp.id); // zweites Abo behält den Mitarbeiter
    expect(row!.user_id).not.toBeNull();

    // Ziel nicht erreichbar → kein Erfolg, Fehlerzähler steigt; zweiter Versuch mit gleichem Schlüssel sendet nicht
    expect(await sendPush(sql, env, { employeeIds: [emp.id] }, { title: 'T', body: 'B' }, 'test:1')).toBe(0);
    const [f1] = await sql<
      { failures: number }[]
    >`select failures from app.push_subscriptions where endpoint = ${sub.endpoint}`;
    expect(f1!.failures).toBe(1);
    await sendPush(sql, env, { employeeIds: [emp.id] }, { title: 'T', body: 'B' }, 'test:1');
    const [f2] = await sql<
      { failures: number }[]
    >`select failures from app.push_subscriptions where endpoint = ${sub.endpoint}`;
    expect(f2!.failures).toBe(1);
  }, 30_000);
});
