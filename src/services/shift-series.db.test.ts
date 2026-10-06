import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, mondayOf } from '../domain/time/holidays.js';
import { employeeInput, saveEmployee } from './employees.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { getShiftSeries, occursOn, plannedShifts, saveShiftSeries, type ShiftSeriesInput } from './time.js';

const available = await dbAvailable();

describe('Termin-Wiederholung', () => {
  const base = { weekday: 1, valid_from: '2026-10-05' }; // Montag
  it('wöchentlich, alle 2 Wochen, ausgewählte Monate', () => {
    expect(occursOn({ ...base, recurrence: 'woechentlich', every: 1 }, '2026-10-12')).toBe(true);
    expect(occursOn({ ...base, recurrence: 'woechentlich', every: 1 }, '2026-10-13')).toBe(false);
    expect(occursOn({ ...base, recurrence: 'woechentlich', every: 2 }, '2026-10-12')).toBe(false);
    expect(occursOn({ ...base, recurrence: 'woechentlich', every: 2 }, '2026-10-19')).toBe(true);
    expect(occursOn({ ...base, recurrence: 'woechentlich', months: [11] }, '2026-10-12')).toBe(false);
    expect(occursOn({ ...base, recurrence: 'woechentlich', months: [11] }, '2026-11-02')).toBe(true);
  });
  it('monatlich am selben Tag, alle n Monate; einmalig', () => {
    expect(occursOn({ ...base, recurrence: 'monatlich', every: 1 }, '2026-11-05')).toBe(true);
    expect(occursOn({ ...base, recurrence: 'monatlich', every: 1 }, '2026-11-06')).toBe(false);
    expect(occursOn({ ...base, recurrence: 'monatlich', every: 3 }, '2026-11-05')).toBe(false);
    expect(occursOn({ ...base, recurrence: 'monatlich', every: 3 }, '2027-01-05')).toBe(true);
    expect(occursOn({ ...base, recurrence: 'einmalig' }, '2026-10-05')).toBe(true);
    expect(occursOn({ ...base, recurrence: 'einmalig' }, '2026-10-12')).toBe(false);
  });
});

describe.skipIf(!available)('Terminserien (Planung wie Fortytools)', () => {
  let sql: Sql;
  const anna = randomUUID();
  const ben = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    for (const [id, no, first] of [
      [anna, '3101', 'Anna'],
      [ben, '3102', 'Ben'],
    ] as const)
      await saveEmployee(
        sql,
        id,
        employeeInput.parse({
          personnel_no: no,
          first_name: first,
          last_name: 'Serie',
          employment_type: 'teilzeit',
          entry_date: '2025-01-01',
          exit_date: '',
          weekly_hours: '20',
          hourly_wage: '15,00',
          phone: '',
          email: '',
          languages: '',
          version: '',
          private_version: '',
        }),
        'test',
      );
  });
  afterAll(async () => {
    await sql?.end();
  });

  const nextMonday = mondayOf(addDays(todayBerlin(), 7));
  const input = (over: Partial<ShiftSeriesInput> = {}): ShiftSeriesInput => ({
    siteId: DEMO.siteSchool,
    employeeIds: [anna, ben],
    recurrence: 'woechentlich',
    every: 1,
    weekdays: [1, 3],
    months: null,
    startTime: '17:00',
    endTime: '19:00',
    breakMinutes: 0,
    validFrom: nextMonday,
    validUntil: null,
    note: 'Treppenhaus',
    planningGroup: 'Team Nord',
    ...over,
  });

  it('je Mitarbeiter × Wochentag ein Einsatz, doppelt speichern legt nichts doppelt an, Ändern behält IDs', async () => {
    const series = randomUUID();
    const ids = await saveShiftSeries(sql, series, input(), 't');
    expect(ids).toHaveLength(4);
    expect(await saveShiftSeries(sql, series, input(), 't')).toEqual(ids);
    const s = (await getShiftSeries(sql, series))!;
    expect(s.weekdays).toEqual([1, 3]);
    expect(s.employeeIds.sort()).toEqual([anna, ben].sort());
    // Ben fällt raus, Freitag kommt dazu → Annas Mo/Mi behalten ihre IDs, Bens Einsätze sind beendet/entfernt
    const ids2 = await saveShiftSeries(sql, series, input({ employeeIds: [anna], weekdays: [1, 3, 5] }), 't');
    expect(ids2.filter((i) => ids.includes(i))).toHaveLength(2);
    const week = await plannedShifts(sql, { from: nextMonday, to: addDays(nextMonday, 6) });
    const mine = week.filter((w) => w.plan.series_id === series);
    expect(mine.map((w) => w.plan.employee_name).every((n) => n.startsWith('Serie, Anna'))).toBe(true);
    expect(mine).toHaveLength(3);
  });

  it('offener Termin erscheint nur mit includeOpen (zu planende Einsätze)', async () => {
    const series = randomUUID();
    await saveShiftSeries(sql, series, input({ employeeIds: [null], recurrence: 'einmalig' }), 't');
    const without = await plannedShifts(sql, { from: nextMonday, to: nextMonday });
    expect(without.some((w) => w.plan.series_id === series)).toBe(false);
    const withOpen = await plannedShifts(sql, {
      from: nextMonday,
      to: addDays(nextMonday, 6),
      includeOpen: true,
    });
    const open = withOpen.filter((w) => w.plan.series_id === series);
    expect(open).toHaveLength(1);
    expect(open[0]!.plan.employee_id).toBeNull();
    expect(open[0]!.date).toBe(nextMonday);
  });

  it('alle 2 Wochen und Ende vor Beginn abgelehnt', async () => {
    const series = randomUUID();
    await saveShiftSeries(sql, series, input({ employeeIds: [anna], weekdays: [2], every: 2 }), 't');
    const four = await plannedShifts(sql, { from: nextMonday, to: addDays(nextMonday, 27) });
    expect(four.filter((w) => w.plan.series_id === series)).toHaveLength(2);
    await expect(
      saveShiftSeries(sql, randomUUID(), input({ validUntil: addDays(nextMonday, -1) }), 't'),
    ).rejects.toThrow(/Enddatum/);
  });
});
