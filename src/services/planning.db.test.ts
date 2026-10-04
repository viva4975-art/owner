import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, holidayName, isoWeekday } from '../domain/time/holidays.js';
import { requestAbsence } from './absences.js';
import { employeeInput, planningGroups, saveEmployee } from './employees.js';
import { sollPlanIst } from './hr-month.js';
import { deleteException, saveException, substituteCandidates, uncoveredShifts } from './planning.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { clockIn, clockOut, confirmPlanned, plannedShifts, saveShiftPlan } from './time.js';

const available = await dbAvailable();

describe.skipIf(!available)('Planung: Vertretung, Ausfall, Umplanung', () => {
  let sql: Sql;
  const anna = randomUUID();
  const ben = randomUUID();
  const plan = randomUUID();
  const benPlan = randomUUID();
  // ein Werktag in der vergangenen Woche (Soll als Ist geht nur 7 Tage zurück), kein Feiertag
  let day = '';
  beforeAll(async () => {
    sql = await freshDatabase();
    const today = todayBerlin();
    day = addDays(today, -1);
    while (isoWeekday(day) > 5 || holidayName(day)) day = addDays(day, -1);
    const emp = (id: string, no: string, first: string, group: string) =>
      saveEmployee(
        sql,
        id,
        employeeInput.parse({
          personnel_no: no,
          first_name: first,
          last_name: 'Test',
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
          planning_group: group,
        }),
        'test',
      );
    await emp(anna, '2001', 'Anna', 'Team Süd');
    await emp(ben, '2002', 'Ben', 'Team Nord');
    const shift = (id: string, employeeId: string, start: string, end: string) =>
      saveShiftPlan(
        sql,
        id,
        {
          employeeId,
          siteId: DEMO.siteSchool,
          weekdays: [isoWeekday(day)],
          startTime: start,
          endTime: end,
          breakMinutes: 0,
          validFrom: '2025-01-01',
          validUntil: null,
          note: null,
        },
        'test',
      );
    await shift(plan, anna, '06:00', '09:00');
    await shift(benPlan, ben, '08:00', '10:00');
    await sql`update app.shift_plans set created_at = '2025-01-01'`;
    // Ben ist dem Objekt nicht zugeordnet → darf dort nur als Vertretung stempeln
    await sql`delete from app.employee_sites where employee_id = ${ben}`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  const input = (over: Partial<Parameters<typeof saveException>[2]> = {}) => ({
    planId: plan,
    date: day,
    kind: 'vertretung' as const,
    substituteId: ben,
    start: null,
    end: null,
    note: null,
    expectedVersion: null,
    ...over,
  });

  it('Einsatzgruppen', async () => {
    expect(await planningGroups(sql)).toEqual(['Team Nord', 'Team Süd']);
  });

  it('Urlaub ohne Regelung erscheint als offener Einsatz', async () => {
    await requestAbsence(sql, {
      id: randomUUID(),
      employeeId: anna,
      kind: 'urlaub',
      start: day,
      end: day,
      halfDay: false,
      note: null,
      actor: 't',
      approved: true,
    });
    const open = await uncoveredShifts(sql, day, day);
    expect(open.map((s) => s.plan.id)).toEqual([plan]);
    expect(await uncoveredShifts(sql, day, day, ['00000000-0000-4000-8000-0000000000ff'])).toEqual([]);
  });

  it('Vertretung mit Überschneidung wird abgelehnt, mit anderer Zeit angenommen', async () => {
    const shift = (await plannedShifts(sql, { from: day, to: day })).find((s) => s.plan.id === plan)!;
    const cand = (await substituteCandidates(sql, shift)).find((c) => c.id === ben)!;
    expect(cand.busy).toMatch(/08:00–10:00/);
    await expect(saveException(sql, randomUUID(), input(), 't')).rejects.toThrow(/Überschneidung/);
    await expect(
      saveException(sql, randomUUID(), input({ start: '05:00', end: '07:00' }), 't'),
    ).resolves.toBeUndefined();
    expect(await uncoveredShifts(sql, day, day)).toEqual([]);
  });

  it('Vertretung sieht den Einsatz, kann ihn bestätigen; die Abwesende nicht', async () => {
    const mine = await plannedShifts(sql, { from: day, to: day, employeeId: ben });
    const sub = mine.find((s) => s.plan.id === plan)!;
    expect(sub.exception?.kind).toBe('vertretung');
    expect(sub.plan.start_time).toBe('05:00');
    expect(sub.minutes).toBe(120);
    expect((await plannedShifts(sql, { from: day, to: day, employeeId: anna })).length).toBe(0);
    await expect(
      confirmPlanned(sql, { employeeId: anna, planId: plan, date: day, confirmed: true, actor: 't' }),
    ).rejects.toThrow(/Kein geplanter Einsatz/);
    const id = await confirmPlanned(sql, {
      employeeId: ben,
      planId: plan,
      date: day,
      confirmed: true,
      actor: 't',
    });
    const [e] = await sql<{ employee_id: string; start: string }[]>`
      select employee_id, to_char(start_at at time zone 'Europe/Berlin', 'HH24:MI') as start from app.time_entries where id = ${id}`;
    expect(e).toEqual({ employee_id: ben, start: '05:00' });
    // nach erfasster Zeit keine Änderung der Ausnahme mehr
    await expect(deleteException(sql, plan, day, 't')).rejects.toThrow(/schon eine Zeit/);
  });

  it('Vertretung darf am fremden Objekt stempeln (nur rund um den Vertretungstag)', async () => {
    // eigenen Einsatz am Objekt vorübergehend wegnehmen → Zugriff nur über die Vertretung
    await sql`update app.shift_plans set employee_id = ${anna} where id = ${benPlan}`;
    const c = randomUUID();
    await expect(
      clockIn(sql, { id: c, employeeId: ben, siteId: DEMO.siteSchool, viaQr: false, actor: 't' }),
    ).resolves.toBe(c);
    await clockOut(sql, { employeeId: ben, breakMinutes: 0, actor: 't' });
    // ohne Vertretung kein Zugriff
    const other = randomUUID();
    await sql`update app.shift_exceptions set work_date = work_date - 30 where shift_plan_id = ${plan}`;
    await expect(
      clockIn(sql, { id: other, employeeId: ben, siteId: DEMO.siteSchool, viaQr: false, actor: 't' }),
    ).rejects.toThrow(/nicht zugeordnet/);
    await sql`update app.shift_plans set employee_id = ${ben} where id = ${benPlan}`;
    await sql`update app.shift_exceptions set work_date = work_date + 30 where shift_plan_id = ${plan}`;
  });

  it('Ausfall: zählt nicht im Plan, Versionsprüfung, Zurücksetzen', async () => {
    const before = (await sollPlanIst(sql, ben, day.slice(0, 7))).plan;
    const benDay = (await plannedShifts(sql, { from: day, to: day, employeeId: ben })).find(
      (s) => s.plan.id === benPlan,
    )!;
    expect(benDay.minutes).toBe(120);
    await saveException(
      sql,
      randomUUID(),
      input({ planId: benPlan, kind: 'ausfall', substituteId: null, note: 'Schule zu' }),
      't',
    );
    expect(
      (await plannedShifts(sql, { from: day, to: day, employeeId: ben })).some((s) => s.plan.id === benPlan),
    ).toBe(false);
    const withCancelled = await plannedShifts(sql, {
      from: day,
      to: day,
      employeeId: ben,
      includeCancelled: true,
    });
    expect(withCancelled.find((s) => s.plan.id === benPlan)!.minutes).toBe(0);
    expect((await sollPlanIst(sql, ben, day.slice(0, 7))).plan).toBe(before - 120);
    // veralteter Stand
    await expect(
      saveException(
        sql,
        randomUUID(),
        input({
          planId: benPlan,
          kind: 'umgeplant',
          substituteId: null,
          start: '11:00',
          end: '12:00',
          expectedVersion: 99,
        }),
        't',
      ),
    ).rejects.toThrow();
    await deleteException(sql, benPlan, day, 't');
    expect((await sollPlanIst(sql, ben, day.slice(0, 7))).plan).toBe(before);
  });

  it('falscher Wochentag wird abgelehnt', async () => {
    await expect(saveException(sql, randomUUID(), input({ date: addDays(day, 1) }), 't')).rejects.toThrow(
      /nicht geplant/,
    );
  });
});
