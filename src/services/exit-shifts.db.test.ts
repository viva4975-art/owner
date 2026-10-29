import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { exitEmployee, reenterEmployee, revokeExit } from './employees.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { saveShiftPlan } from './time.js';

const available = await dbAvailable();

// Ahmed 29.10.: Ausgeschiedene bis zum Austritt planbar; beim Austritt enden die Einsätze automatisch.
describe.skipIf(!available)('Einsätze und Austritt (Datenbank)', () => {
  let sql: Sql;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, hourly_wage_cents, weekly_hours)
              values (${emp}, '3201', 'Test', 'Austritt', '2024-01-01', 1500, 20)`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  const plan = (validFrom: string, validUntil: string | null) =>
    saveShiftPlan(
      sql,
      randomUUID(),
      {
        employeeId: emp,
        siteId: DEMO.siteSchool,
        weekdays: [1],
        startTime: '06:00',
        endTime: '10:00',
        breakMinutes: 0,
        validFrom,
        validUntil,
        note: null,
      },
      'buero',
    ).then((ids) => ids[0]!);
  const row = async (id: string) =>
    (
      await sql<{ employee_id: string | null; valid_until: string | null }[]>`
        select employee_id, valid_until::text from app.shift_plans where id = ${id}`
    )[0]!;

  it('Austritt beendet laufende Einsätze, spätere werden offen; Rücknahme stellt alles wieder her', async () => {
    const laufend = await plan('2026-01-05', null);
    const befristet = await plan('2026-01-05', '2027-06-30');
    const spaeter = await plan('2027-03-01', null);
    const r = await exitEmployee(sql, emp, { date: '2027-01-31', reason: 'Kündigung', actor: 'buero' });
    expect(r).toEqual({ ended: 2, opened: 1 });
    expect((await row(laufend)).valid_until).toBe('2027-01-31');
    expect((await row(befristet)).valid_until).toBe('2027-01-31');
    expect((await row(spaeter)).employee_id).toBeNull();
    // Austritt verschoben → neuer Tag gilt
    await exitEmployee(sql, emp, { date: '2027-04-30', reason: 'Kündigung', actor: 'buero' });
    expect((await row(laufend)).valid_until).toBe('2027-04-30');
    expect((await row(spaeter)).employee_id).toBe(emp);
    expect((await row(spaeter)).valid_until).toBe('2027-04-30');
    // zurückgenommen → wie vorher
    await revokeExit(sql, emp, 'buero');
    expect((await row(laufend)).valid_until).toBeNull();
    expect((await row(befristet)).valid_until).toBe('2027-06-30');
    expect((await row(spaeter)).valid_until).toBeNull();
  });

  it('bis zum Austritt planbar, danach nicht; „bis“ wird auf den Austritt gekürzt', async () => {
    await exitEmployee(sql, emp, { date: '2026-09-30', reason: null, actor: 'buero' });
    const id = await plan('2026-09-07', null);
    expect((await row(id)).valid_until).toBe('2026-09-30');
    await expect(plan('2026-10-05', null)).rejects.toThrow(/Austritt|tritt am 30\.09\.2026 aus/);
  });

  it('Wiedereintritt stellt alte Einsätze nicht wieder her', async () => {
    const [before] = await sql<{ n: number }[]>`
      select count(*)::int as n from app.shift_plans where employee_id = ${emp} and valid_until is null`;
    await reenterEmployee(sql, emp, { date: '2027-01-01', actor: 'buero' });
    const [after] = await sql<{ n: number }[]>`
      select count(*)::int as n from app.shift_plans where employee_id = ${emp} and valid_until is null`;
    expect(after!.n).toBe(before!.n);
  });
});
