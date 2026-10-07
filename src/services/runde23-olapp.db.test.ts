import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Runde 23: Objektleitung-App – Personalbogen (Datenbank)', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Personalbogen mit vertraulichen Daten lesen nur Personal/Admin, nicht Objektleitung oder Büro', async () => {
    await sql`insert into app.personnel_forms (id, lang, data, created_by)
              values (${randomUUID()}, 'ro', ${sql.json({ last_name: 'Popescu', tax_id: '12345678901' })}, 'ol')`;
    const ids = { ol: randomUUID(), office: randomUUID(), hr: randomUUID() };
    await sql`insert into auth.users (id) values (${ids.ol}), (${ids.office}), (${ids.hr})`;
    await sql`insert into app.profiles (user_id, display_name, role)
              values (${ids.ol}, 'OL', 'objektleitung'), (${ids.office}, 'Büro', 'buchhaltung'), (${ids.hr}, 'Personal', 'personal')`;
    const count = (uid: string) =>
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid })}, true),
                       set_config('request.jwt.claim.sub', ${uid}, true)`;
        await tx`set local role authenticated`;
        const [r] = await tx`select count(*)::int as n from app.personnel_forms`;
        return r!.n as number;
      });
    expect(await count(ids.ol)).toBe(0);
    expect(await count(ids.office)).toBe(0);
    expect(await count(ids.hr)).toBe(1);
  });
});
