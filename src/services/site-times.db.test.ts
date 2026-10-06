import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { DEMO } from './seed.js';
import { confirmSiteMonth, siteMonthOverview, siteTimes } from './site-times.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { clockIn, clockOut, officeSave, saveShiftPlan } from './time.js';

const available = await dbAvailable();

describe.skipIf(!available)('Erfasste Zeiten am Objekt, Zeiterfassung bestätigt', () => {
  let sql: Sql;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, hourly_wage_cents)
              values (${emp}, '3001', 'Ioana', 'Marin', '2024-01-01', 1425)`;
    await sql`insert into app.employee_sites (employee_id, site_id) values (${emp}, ${DEMO.siteOffice})`;
    await saveShiftPlan(
      sql,
      randomUUID(),
      {
        employeeId: emp,
        siteId: DEMO.siteOffice,
        weekdays: [1, 2, 3, 4, 5],
        startTime: '06:00',
        endTime: '08:00',
        breakMinutes: 0,
        validFrom: '2026-08-01',
        validUntil: null,
        note: null,
      },
      'buero',
    );
    // Einsatz gilt als schon im August angelegt (Soll zählt erst ab Anlage)
    await sql`update app.shift_plans set created_at = '2026-08-01T08:00:00Z' where employee_id = ${emp}`;
    const entry = (date: string, start: string, end: string) =>
      officeSave(sql, {
        id: randomUUID(),
        employeeId: emp,
        siteId: DEMO.siteOffice,
        date,
        start,
        end,
        breakMinutes: 0,
        reason: 'Stundenzettel',
        expectedVersion: null,
        actor: 'buero',
      });
    await entry('2026-09-01', '06:00', '08:00');
    await entry('2026-09-02', '06:00', '07:30');
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Dauer (Ist) und Geplant (Einsatzplan) je Mitarbeiter und gesamt', async () => {
    const t = await siteTimes(sql, DEMO.siteOffice, '2026-09-01', '2026-09-30');
    const me = t.sums.find((s) => s.employee_id === emp)!;
    // September 2026: 22 Arbeitstage × 2 Std.
    expect(me).toMatchObject({ entries: 2, actual: 210, planned: 22 * 120 });
    expect(t.total.actual).toBeGreaterThanOrEqual(210);
  });

  it('Monat bestätigen, Änderung danach sichtbar, Rücknahme; nur anhängen', async () => {
    await confirmSiteMonth(sql, DEMO.siteOffice, '2026-09', true, 'buero', '2026-10-06');
    let m = (await siteMonthOverview(sql, DEMO.siteOffice, '2026-09', 2)).find((r) => r.month === '2026-09')!;
    expect(m.confirmed).toMatchObject({ by: 'buero', minutes: 210 });
    expect(m.actual).toBe(210);
    // nachträglich erfasste Zeit → bestätigte Minuten weichen ab
    await officeSave(sql, {
      id: randomUUID(),
      employeeId: emp,
      siteId: DEMO.siteOffice,
      date: '2026-09-03',
      start: '06:00',
      end: '08:00',
      breakMinutes: 0,
      reason: 'nachgereicht',
      expectedVersion: null,
      actor: 'buero',
    });
    m = (await siteMonthOverview(sql, DEMO.siteOffice, '2026-09', 2)).find((r) => r.month === '2026-09')!;
    expect([m.actual, m.confirmed!.minutes]).toEqual([330, 210]);
    await confirmSiteMonth(sql, DEMO.siteOffice, '2026-09', false, 'buero', '2026-10-06');
    m = (await siteMonthOverview(sql, DEMO.siteOffice, '2026-09', 2)).find((r) => r.month === '2026-09')!;
    expect(m.confirmed).toBeNull();
    await expect(sql`update app.site_time_confirmations set confirmed = true`).rejects.toThrow(
      /unveränderbar/,
    );
    await expect(sql`delete from app.site_time_confirmations`).rejects.toThrow(/unveränderbar/);
  });

  it('Bestätigen gesperrt bei laufender Stempelung und für künftige Monate', async () => {
    const today = todayBerlin();
    await clockIn(sql, {
      id: randomUUID(),
      employeeId: emp,
      siteId: DEMO.siteOffice,
      viaQr: false,
      actor: 'm:3001',
    });
    await expect(
      confirmSiteMonth(sql, DEMO.siteOffice, today.slice(0, 7), true, 'buero', today),
    ).rejects.toThrow(/offene Zeit/);
    await clockOut(sql, { employeeId: emp, breakMinutes: 0, actor: 'm:3001' });
    await expect(confirmSiteMonth(sql, DEMO.siteOffice, '2099-01', true, 'buero', today)).rejects.toThrow(
      /künftiger/,
    );
    await expect(confirmSiteMonth(sql, DEMO.siteOffice, '2026-13', true, 'buero', today)).rejects.toThrow(
      /ungültig/,
    );
  });
});
