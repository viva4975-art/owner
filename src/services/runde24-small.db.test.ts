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

describe.skipIf(!available)('Mehrarbeitszuschlag (Datenbank)', () => {
  let sql: Sql;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, hourly_wage_cents)
              values (${emp}, '7901', 'Mehr', 'Arbeit', '2024-01-01', 1500)`;
    // Woche Mo 28.09. – So 04.10.2026: Mo–Do je 9 Std. (36), Fr 02.10. 6 Std. → 3 Std. über 39 im Oktober
    const add = (day: string, h: number) =>
      sql`insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source, status, created_by)
          values (${randomUUID()}, ${emp}, ${DEMO.siteSchool}, ${day},
                  (${day}::date + time '06:00') at time zone 'Europe/Berlin',
                  (${day}::date + time '06:00' + make_interval(hours => ${h})) at time zone 'Europe/Berlin', 0, 'buero', 'erfasst', 't')`;
    for (const d of ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']) await add(d, 9);
    await add('2026-10-02', 6);
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('je Woche über 39 Std., dem Monat zugeordnet, in dem die Stunden anfallen', async () => {
    const { payrollMonth } = await import('./payroll.js');
    const sep = (await payrollMonth(sql, '2026-09', emp))[0]!;
    const oct = (await payrollMonth(sql, '2026-10', emp))[0]!;
    expect(sep.minutes.mehrarbeit).toBe(0);
    expect(oct.minutes.mehrarbeit).toBe(180);
    expect(oct.overtimeCents).toBe(1125n); // 3 Std. × 15,00 € × 25 %
  });
});
