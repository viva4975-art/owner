import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { applicationDate, getAbsence, requestAbsence, updateAbsence } from '../services/absences.js';
import { dbAvailable, freshDatabase } from '../services/testing.js';
import { leaveRequestsHtml, requestsOf } from './leave-request-print.js';

const available = await dbAvailable();

it('Unterschriftsdatum: Antragsdatum, sonst 5 Tage vor Beginn', () => {
  expect(applicationDate({ start_date: '2026-11-10', applied_on: null })).toBe('2026-11-05');
  expect(applicationDate({ start_date: '2026-11-10', applied_on: '2026-10-01' })).toBe('2026-10-01');
});

describe.skipIf(!available)('Urlaubsanträge drucken (Datenbank)', () => {
  let sql: Sql;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, hourly_wage_cents)
              values (${emp}, '7801', 'Erika', 'Antrag', '2024-01-01', 1500)`;
  });
  afterAll(async () => sql?.end());

  it('Antragsdatum wird gespeichert, geändert und auf dem Antrag gedruckt', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const k = randomUUID();
    await requestAbsence(sql, {
      id: a,
      employeeId: emp,
      kind: 'urlaub',
      start: '2026-11-09',
      end: '2026-11-13',
      halfDay: false,
      note: null,
      actor: 't',
      approved: true,
      appliedOn: '2026-10-01',
      allowNoLeave: true,
    });
    await requestAbsence(sql, {
      id: b,
      employeeId: emp,
      kind: 'unbezahlt',
      start: '2026-11-23',
      end: '2026-11-24',
      halfDay: false,
      note: 'Umzug',
      actor: 't',
      approved: false,
    });
    await requestAbsence(sql, {
      id: k,
      employeeId: emp,
      kind: 'krank',
      start: '2026-11-02',
      end: '2026-11-03',
      halfDay: false,
      note: null,
      actor: 't',
      approved: true,
    });
    expect((await getAbsence(sql, a))!.applied_on).toBe('2026-10-01');
    await expect(
      requestAbsence(sql, {
        id: randomUUID(),
        employeeId: emp,
        kind: 'urlaub',
        start: '2026-12-01',
        end: '2026-12-01',
        halfDay: false,
        note: null,
        actor: 't',
        appliedOn: '2999-01-01',
      }),
    ).rejects.toThrow(/Zukunft/);

    const reqs = await requestsOf(sql, '2026-11-01', '2026-11-30', new Set([emp]));
    expect(reqs.map((r) => r.kind)).toEqual(['urlaub', 'unbezahlt']); // Krankheit ist kein Antrag
    const html = await leaveRequestsHtml(sql, reqs, new Map(), {
      name: 'Viva',
      street: 'X',
      postal_code: '81375',
      city: 'München',
    });
    expect(html).toContain('Urlaubsantrag');
    expect(html).toContain('München, 01.10.2026');
    expect(html).toContain('Antrag auf unbezahlte Freistellung');
    expect(html).toContain('München, 18.11.2026'); // 23.11. − 5 Tage
    expect(html).toContain('5 Arbeitstage');

    const cur = (await getAbsence(sql, b))!;
    await updateAbsence(
      sql,
      b,
      {
        kind: 'unbezahlt',
        start: cur.start_date,
        end: cur.end_date,
        halfDay: false,
        note: 'Umzug',
        expectedVersion: null,
        appliedOn: '2026-10-20',
      },
      't',
    );
    expect((await getAbsence(sql, b))!.applied_on).toBe('2026-10-20');
  });
});
