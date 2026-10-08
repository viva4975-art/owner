import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { closeMonth, listClosings, monthCloseSteps } from './month-close.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Monatsabschluss (Datenbank)', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Schritte mit Zählern; offene Punkte nur mit Begründung abschließen; Abschluss unveränderbar', async () => {
    const steps = await monthCloseSteps(sql, '2026-09');
    expect(steps.map((s) => s.key)).toEqual(
      expect.arrayContaining([
        'running',
        'pending',
        'notime',
        'due',
        'drafts',
        'unsent',
        'expected',
        'cash',
        'datev',
      ]),
    );
    const open = steps.filter((s) => s.open > 0).length;
    if (open) {
      await expect(
        closeMonth(sql, { id: randomUUID(), month: '2026-09', note: null, actor: 't' }),
      ).rejects.toThrow(/begründen/);
    }
    const id = randomUUID();
    await closeMonth(sql, { id, month: '2026-09', note: 'Test', actor: 't' });
    await closeMonth(sql, { id, month: '2026-09', note: 'Test', actor: 't' }); // doppelt absenden
    const l = await listClosings(sql, '2026-09');
    expect(l).toHaveLength(1);
    expect(l[0]!.open_points).toBe(open);
    await expect(sql`delete from app.month_closings where id = ${id}`).rejects.toThrow();
  });
});
