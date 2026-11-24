import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, holidayName, isoWeekday } from '../domain/time/holidays.js';
import { decideAbsence, requestAbsence } from './absences.js';
import { saveMaxAbsentPerSite, siteAbsenceDays, siteOverlaps } from './leave-overlap.js';
import { addSiteClosure } from './site-closures.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { saveShiftPlan } from './time.js';

const available = await dbAvailable();

// Ahmed 24.11.: zwei am Objekt gleichzeitig im Urlaub → dem dritten nicht ohne Rückfrage gewähren.
describe.skipIf(!available)('Gleichzeitig abwesend je Objekt (Datenbank)', () => {
  let sql: Sql;
  const emps = [randomUUID(), randomUUID(), randomUUID()];
  let day = '';
  beforeAll(async () => {
    sql = await freshDatabase();
    day = addDays(todayBerlin(), 14);
    while (isoWeekday(day) >= 6 || holidayName(day)) day = addDays(day, 1);
    for (const [i, id] of emps.entries()) {
      await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, hourly_wage_cents, weekly_hours, employment_type)
                values (${id}, ${`39${i}0`}, 'Test', ${`Gleich${i}`}, '2024-01-01', 1500, 20, 'teilzeit')`;
      await saveShiftPlan(
        sql,
        randomUUID(),
        {
          employeeId: id,
          siteId: DEMO.siteSchool,
          weekdays: [1, 2, 3, 4, 5],
          startTime: '06:00',
          endTime: '10:00',
          breakMinutes: 0,
          validFrom: todayBerlin(),
          validUntil: null,
          note: null,
        },
        'buero',
      );
    }
    await saveMaxAbsentPerSite(sql, 2, 'buero');
  });
  afterAll(async () => {
    await sql?.end();
  });

  const req = (emp: string, extra: Record<string, unknown> = {}) =>
    requestAbsence(sql, {
      id: randomUUID(),
      employeeId: emp,
      kind: 'urlaub',
      start: day,
      end: day,
      halfDay: false,
      note: null,
      actor: 'buero',
      approved: true,
      allowNoLeave: true,
      ...extra,
    });

  it('zwei gehen, der dritte braucht die Rückfrage', async () => {
    await req(emps[0]!);
    await req(emps[1]!);
    await expect(req(emps[2]!)).rejects.toMatchObject({ code: 'leave_overlap' });
    const days = await siteAbsenceDays(sql, DEMO.siteSchool, day, day);
    expect(days[0]?.absent.length).toBe(2);
    await req(emps[2]!, { allowOverlap: true });
    expect((await siteAbsenceDays(sql, DEMO.siteSchool, day, day))[0]?.absent.length).toBe(3);
  });

  it('Krankheit wird nie gesperrt, Antrag aus der App erst beim Genehmigen geprüft', async () => {
    let d2 = addDays(day, 7);
    while (isoWeekday(d2) >= 6 || holidayName(d2)) d2 = addDays(d2, 1);
    await req(emps[0]!, { start: d2, end: d2 });
    await req(emps[1]!, { start: d2, end: d2 });
    // krank: keine Rückfrage
    await req(emps[2]!, { kind: 'krank', start: d2, end: d2 });
    let d3 = addDays(d2, 7);
    while (isoWeekday(d3) >= 6 || holidayName(d3)) d3 = addDays(d3, 1);
    await req(emps[0]!, { start: d3, end: d3 });
    await req(emps[1]!, { start: d3, end: d3 });
    // Antrag aus der App (nicht genehmigt) geht durch …
    const id = randomUUID();
    await requestAbsence(sql, {
      id,
      employeeId: emps[2]!,
      kind: 'urlaub',
      start: d3,
      end: d3,
      halfDay: false,
      note: null,
      actor: 'm:3920',
      allowNoLeave: true,
    });
    // … das Genehmigen fragt nach
    await expect(decideAbsence(sql, id, 'genehmigt', 'buero', true)).rejects.toMatchObject({
      code: 'leave_overlap',
    });
    await decideAbsence(sql, id, 'genehmigt', 'buero', true, true);
    // Warnung aus: keine Rückfrage
    await saveMaxAbsentPerSite(sql, null, 'buero');
    await req(emps[2]!, { start: addDays(d3, 7), end: addDays(d3, 7) }).catch((e: { code?: string }) => {
      expect(e.code).not.toBe('leave_overlap');
    });
  });

  it('Übersicht Überschneidungen: ab 2 gleichzeitig, nicht an Schließtagen', async () => {
    const ov = await siteOverlaps(sql, { from: day, to: day });
    const o = ov.find((x) => x.siteId === DEMO.siteSchool);
    expect(o?.ranges[0]?.absent.length).toBe(3);
    // Objekt an dem Tag geschlossen → keine Überschneidung
    await addSiteClosure(
      sql,
      { id: randomUUID(), siteId: DEMO.siteSchool, from: day, to: day, note: 'Ferien' },
      'buero',
    );
    let d3 = addDays(day, 1);
    while (isoWeekday(d3) >= 6 || holidayName(d3)) d3 = addDays(d3, 1);
    const ov2 = await siteOverlaps(sql, { from: day, to: d3 });
    expect(ov2.find((x) => x.siteId === DEMO.siteSchool)).toBeUndefined();
  });
});
