import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { DEMO } from './seed.js';
import { bookTimeAccount, setStartMonth, timeAccount } from './time-account.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Arbeitszeitkonto (Datenbank)', () => {
  let sql: Sql;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, weekly_hours)
              values (${emp}, '7701', 'Konto', 'Test', '2026-01-01', 10)`;
    // Soll = Wochenstunden × 4,33 (Ahmed 09.10.) → 10 h × 4,33 = 43,3 h = 2598 Min.
    const add = (day: string, from: string, to: string) =>
      sql`insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source, status, created_by)
          values (${randomUUID()}, ${emp}, ${DEMO.siteSchool}, ${day},
                  (${day}::date + ${from}::time) at time zone 'Europe/Berlin',
                  (${day}::date + ${to}::time) at time zone 'Europe/Berlin', 0, 'buero', 'erfasst', 't')`;
    for (let d = 1; d <= 25; d++) await add(`2026-09-${String(d).padStart(2, '0')}`, '06:00', '08:00'); // 25 × 2 h = 50 h
    await setStartMonth(sql, '2026-09', 't');
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Soll aus Wochenstunden, Saldo und Kontostand mit Buchungen; Warnung über 50 %', async () => {
    const { rows } = await timeAccount(sql, '2026-09', emp);
    const r = rows.find((x) => x.employee_id === emp)!;
    expect(r.soll).toBe(2598);
    expect(r.ist).toBe(50 * 60);
    expect(r.saldo).toBe(3000 - 2598);
    expect(r.balance).toBe(3000 - 2598);
    expect(r.warn).toBe(false);
    await expect(
      bookTimeAccount(sql, {
        id: randomUUID(),
        employeeId: emp,
        month: '2026-09',
        minutes: 120,
        kind: 'auszahlung',
        note: 'x',
        actor: 't',
      }),
    ).rejects.toThrow(/Minus/);
    await bookTimeAccount(sql, {
      id: randomUUID(),
      employeeId: emp,
      month: '2026-09',
      minutes: 20 * 60,
      kind: 'startsaldo',
      note: 'Übernahme',
      actor: 't',
    });
    const r2 = (await timeAccount(sql, '2026-09', emp)).rows.find((x) => x.employee_id === emp)!;
    expect(r2.balance).toBe(3000 - 2598 + 20 * 60);
    expect(r2.warn).toBe(true); // 26,7 h > 50 % von 43,3 h
    // Oktober ohne Zeiten: Kontostand läuft weiter (Soll 21 Arbeitstage → −42 h)
    const r3 = (await timeAccount(sql, '2026-10', emp)).rows.find((x) => x.employee_id === emp)!;
    expect(r3.balance).toBe(3000 - 2598 + 20 * 60 + r3.saldo!);
  });
});
