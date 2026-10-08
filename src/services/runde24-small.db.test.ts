import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { writeLetter } from './letters.js';
import { DEMO } from './seed.js';
import { STARTUP_STEPS, createStartupPlan } from './site-startup.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Anlaufplan und Schriftverkehr (Datenbank)', () => {
  let sql: Sql;
  let dir: string;
  beforeAll(async () => {
    sql = await freshDatabase();
    dir = await mkdtemp(join(tmpdir(), 'brief-'));
  });
  afterAll(async () => {
    await sql?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('Anlaufplan: Aufgaben relativ zum Beginn, erneut erstellen verschiebt nur', async () => {
    const r = await createStartupPlan(sql, DEMO.siteSchool, '2026-12-01', 't');
    expect(r.created).toBe(STARTUP_STEPS.length);
    const t = await sql<{ title: string; due_date: string }[]>`
      select title, due_date::text from app.tasks where entity_id = ${DEMO.siteSchool} and title like 'Anlauf%' order by due_date`;
    expect(t).toHaveLength(STARTUP_STEPS.length);
    expect(t[0]!.due_date).toBe('2026-11-10');
    expect(t.at(-1)!.due_date).toBe('2026-12-31');
    const r2 = await createStartupPlan(sql, DEMO.siteSchool, '2027-01-01', 't');
    expect(r2.created).toBe(0);
    const [n] =
      await sql`select count(*)::int as n from app.tasks where entity_id = ${DEMO.siteSchool} and title like 'Anlauf%'`;
    expect(n!.n).toBe(STARTUP_STEPS.length);
  });

  it('Brief: PDF in der Kundenakte, doppelt absenden legt nichts doppelt ab', async () => {
    const formId = randomUUID();
    const p = {
      formId,
      target: 'kunde' as const,
      id: DEMO.authority,
      subject: 'Neue Anschrift',
      greeting: 'Sehr geehrte Damen und Herren,',
      body: 'Wir ziehen um.\n\nNeue Anschrift folgt.',
      date: '2026-10-08',
      actor: 't',
    };
    const a = await writeLetter(sql, { dir, maxBytes: 5e7 }, p);
    const b = await writeLetter(sql, { dir, maxBytes: 5e7 }, p);
    expect(a.fileId).toBe(b.fileId);
    const [l] =
      await sql`select category from app.file_links where file_id = ${a.fileId} and entity_type = 'customer'`;
    expect(l!.category).toBe('Schriftverkehr');
    await expect(
      writeLetter(sql, { dir, maxBytes: 5e7 }, { ...p, formId: randomUUID(), body: ' ' }),
    ).rejects.toThrow(/Text/);
  });
});
