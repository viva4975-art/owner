import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, isoWeekday } from '../domain/time/holidays.js';
import { decideAbsence, listAbsenceHours, requestAbsence, saveAbsenceHours } from './absences.js';
import { employeeInput, saveEmployee } from './employees.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase, testDeps } from './testing.js';
import { autoBreak, clockOut, getEntry, placeBreak, saveShiftPlan, setRunningBreak } from './time.js';
import { monthRange, monthToSign, signTimesheet, signable, timesheet } from './timesheet.js';
import type { Deps } from './workflow.js';

describe('Automatische Pause (§ 4 ArbZG)', () => {
  it('Dauer nach Arbeitszeit, Beginn nach 4 Std.', () => {
    const s = new Date('2026-10-05T04:00:00Z');
    expect(autoBreak(s, 6 * 60)).toEqual({ minutes: 0, start: null });
    expect(autoBreak(s, 7 * 60)).toEqual({ minutes: 30, start: new Date('2026-10-05T08:00:00Z') });
    expect(autoBreak(s, 9 * 60 + 1).minutes).toBe(45);
  });
  it('kurze Schicht: Pause liegt vor dem Ende', () => {
    const s = new Date('2026-10-05T04:00:00Z');
    const e = new Date('2026-10-05T07:00:00Z');
    expect(placeBreak(s, e, 15)).toEqual(new Date('2026-10-05T06:45:00Z'));
    expect(placeBreak(s, e, 0)).toBeNull();
  });
  it('Monat zum Unterschreiben', () => {
    expect(monthToSign('2026-10-31')).toBe('2026-10');
    expect(monthToSign('2026-11-03')).toBe('2026-10');
    expect(signable('2026-10', '2026-10-30')).toBe(false);
    expect(signable('2026-10', '2026-10-31')).toBe(true);
    expect(monthRange('2028-02').to).toBe('2028-02-29');
  });
});

const available = await dbAvailable();

describe.skipIf(!available)('Runde 10 (Datenbank)', () => {
  let sql: Sql;
  let deps: Deps;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, hourly_wage_cents, weekly_hours)
              values (${emp}, '3001', 'Maria', 'Test', '2024-01-01', 1500, 20)`;
    await sql`insert into app.employee_sites (employee_id, site_id) values (${emp}, ${DEMO.siteSchool})`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  const running = async (hoursAgo: number) => {
    const id = randomUUID();
    await sql`insert into app.time_entries (id, employee_id, site_id, work_date, start_at, source, status, created_by)
              values (${id}, ${emp}, ${DEMO.siteSchool}, (now() at time zone 'Europe/Berlin')::date,
                      date_trunc('minute', now()) - make_interval(hours => ${hoursAgo}), 'stempel', 'laeuft', 'test')`;
    return id;
  };

  it('Ausstempeln ohne Änderung → gesetzliche Pause automatisch nach 4 Std.', async () => {
    const id = await running(7);
    await clockOut(sql, { employeeId: emp, breakMinutes: null, actor: 'm:3001' });
    const e = (await getEntry(sql, id))!;
    expect(e.break_minutes).toBe(30);
    expect(e.break_auto).toBe(true);
    expect(e.break_start_at!.getTime() - e.start_at.getTime()).toBe(4 * 3600e3);
  });

  it('Pause in der App geändert → genau so übernommen', async () => {
    const id = await running(8);
    const [{ hhmm }] = (await sql`
      select to_char((date_trunc('minute', now()) - interval '2 hours') at time zone 'Europe/Berlin', 'HH24:MI') as hhmm`) as unknown as [
      { hhmm: string },
    ];
    await setRunningBreak(sql, { employeeId: emp, start: hhmm, minutes: 45, actor: 'm:3001' });
    await clockOut(sql, { employeeId: emp, breakMinutes: null, actor: 'm:3001' });
    const e = (await getEntry(sql, id))!;
    expect(e.break_minutes).toBe(45);
    expect(e.break_auto).toBe(false);
    expect(e.break_start_at!.getTime() - e.start_at.getTime()).toBe(6 * 3600e3);
    await expect(
      setRunningBreak(sql, { employeeId: emp, start: '10:00', minutes: 30, actor: 'm:3001' }),
    ).rejects.toThrow(/Nicht eingestempelt/);
  });

  it('Urlaub/Krank/unbezahlt gelten für die geplanten Einsätze, Stunden änderbar', async () => {
    // nächster Monat: Einsätze Mo–Fr 06:00–10:00
    const next = addDays(monthRange(todayBerlin().slice(0, 7)).to, 1).slice(0, 7);
    const { from } = monthRange(next);
    await saveShiftPlan(
      sql,
      randomUUID(),
      {
        employeeId: emp,
        siteId: DEMO.siteSchool,
        weekdays: [1, 2, 3, 4, 5],
        startTime: '06:00',
        endTime: '10:00',
        breakMinutes: 0,
        validFrom: from,
        validUntil: null,
        note: null,
      },
      'buero',
    );
    // erste volle Arbeitswoche im Monat (Montag)
    let mon = from;
    while (isoWeekday(mon) !== 1) mon = addDays(mon, 1);
    const vac = randomUUID();
    await requestAbsence(sql, {
      id: vac,
      employeeId: emp,
      kind: 'urlaub',
      start: mon,
      end: addDays(mon, 4),
      halfDay: false,
      note: null,
      actor: 'buero',
      approved: true,
    });
    const hours = await listAbsenceHours(sql, { absenceId: vac });
    const workdays = hours.length;
    expect(workdays).toBeGreaterThanOrEqual(4); // ggf. ein Feiertag in der Woche
    expect(hours.every((h) => h.minutes === 240 && h.paid)).toBe(true);
    // Büro ändert einen Tag auf 2 Std.
    await saveAbsenceHours(sql, vac, [{ id: hours[0]!.id, minutes: 120, paid: true }], 'buero');
    // unbezahlt in der Folgewoche (beantragt → genehmigt)
    const unpaid = randomUUID();
    await requestAbsence(sql, {
      id: unpaid,
      employeeId: emp,
      kind: 'unbezahlt',
      start: addDays(mon, 7),
      end: addDays(mon, 7),
      halfDay: false,
      note: null,
      actor: 'm:3001',
    });
    expect(await listAbsenceHours(sql, { absenceId: unpaid })).toHaveLength(0);
    await decideAbsence(sql, unpaid, 'genehmigt', 'buero');
    const u = await listAbsenceHours(sql, { absenceId: unpaid });
    expect(u.map((h) => [h.minutes, h.paid])).toEqual([[240, false]]);
    const sheet = await timesheet(sql, emp, next);
    expect(sheet.totals.vacation).toBe(240 * (workdays - 1) + 120);
    expect(sheet.totals.unpaid).toBe(240);
    expect(sheet.totals.paid).toBe(sheet.totals.work + sheet.totals.vacation);
    // Storno → Stunden entfallen
    await decideAbsence(sql, unpaid, 'storniert', 'buero');
    expect(await listAbsenceHours(sql, { absenceId: unpaid })).toHaveLength(0);
  });

  it('Stundenzettel unterschreiben: erst am Monatsende, Änderung danach erkennbar', async () => {
    const prev = addDays(`${todayBerlin().slice(0, 7)}-01`, -1).slice(0, 7);
    const day = `${prev}-10`;
    await sql`insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source, status, created_by)
              values (${randomUUID()}, ${emp}, ${DEMO.siteSchool}, ${day},
                      (${day}::date + time '06:00') at time zone 'Europe/Berlin',
                      (${day}::date + time '13:00') at time zone 'Europe/Berlin', 30, 'buero', 'erfasst', 'buero')`;
    const png = new Uint8Array(400).fill(7);
    const cur = todayBerlin().slice(0, 7);
    if (monthRange(cur).to !== todayBerlin())
      await expect(
        signTimesheet(deps, { employeeId: emp, month: cur, png, confirmed: true, ip: null, userAgent: null }),
      ).rejects.toThrow(/Monatsende/);
    await expect(
      signTimesheet(deps, { employeeId: emp, month: prev, png, confirmed: false, ip: null, userAgent: null }),
    ).rejects.toThrow(/bestätigen/);
    await signTimesheet(deps, {
      employeeId: emp,
      month: prev,
      png,
      confirmed: true,
      ip: '1.2.3.4',
      userAgent: 'x',
    });
    await signTimesheet(deps, {
      employeeId: emp,
      month: prev,
      png,
      confirmed: true,
      ip: '1.2.3.4',
      userAgent: 'x',
    });
    const sigs =
      await sql`select * from app.timesheet_signatures where employee_id = ${emp} and month = ${prev}`;
    expect(sigs).toHaveLength(1);
    const sheet = await timesheet(sql, emp, prev);
    expect(sigs[0]!.sheet_hash).toBe(sheet.hash);
    const row = sheet.rows.find((r) => r.date === day)!;
    expect([row.start, row.end, row.breakFrom, row.breakTo, row.workMinutes]).toEqual([
      '06:00',
      '13:00',
      '10:00',
      '10:30',
      390,
    ]);
    await expect(sql`delete from app.timesheet_signatures where employee_id = ${emp}`).rejects.toThrow(
      /nur anhängbar/,
    );
    // nachträgliche Änderung → andere Prüfsumme
    await sql.begin(async (tx) => {
      await tx`select set_config('app.actor', 'buero', true), set_config('app.reason', 'Test', true)`;
      await tx`update app.time_entries set break_minutes = 45 where employee_id = ${emp} and work_date = ${day}`;
    });
    expect((await timesheet(sql, emp, prev)).hash).not.toBe(sigs[0]!.sheet_hash);
  });

  it('Vergütung: Tariflohn, Festgehalt (Stundensatz), Pflichtangaben', async () => {
    const [lg1] = await sql<{ id: string; hourly_wage_cents: bigint }[]>`
      select id, hourly_wage_cents from app.wage_levels where name = 'Tariflohn 1'`;
    expect(lg1!.hourly_wage_cents).toBe(1500n);
    const base = {
      personnel_no: '3002',
      first_name: 'Ion',
      last_name: 'Tarif',
      employment_type: 'teilzeit',
      entry_date: '2025-01-01',
      weekly_hours: '30',
      carry_over_leave: 'on',
    };
    expect(employeeInput.safeParse({ ...base, employment_type: '' }).error?.issues[0]?.message).toMatch(
      /Beschäftigungsart/,
    );
    expect(employeeInput.safeParse({ ...base, pay_model: 'tarif' }).success).toBe(false);
    const id = randomUUID();
    await saveEmployee(
      sql,
      id,
      employeeInput.parse({ ...base, pay_model: 'tarif', wage_level_id: lg1!.id, hourly_wage: '20,00' }),
      'test',
    );
    const [w1] =
      await sql`select app.effective_wage_cents(e) as c, e.hourly_wage_cents from app.employees e where id = ${id}`;
    expect([w1!.c, w1!.hourly_wage_cents]).toEqual([1500n, null]);
    await saveEmployee(
      sql,
      id,
      employeeInput.parse({ ...base, pay_model: 'festgehalt', monthly_salary: '2.600,00' }),
      'test',
    );
    // 2.600 € ÷ 4,33 ÷ 30 Std. = 20,02 €/Std.
    const [w2] =
      await sql`select app.effective_wage_cents(e) as c, e.wage_level_id from app.employees e where id = ${id}`;
    expect([w2!.c, w2!.wage_level_id]).toEqual([2002n, null]);
    expect(
      employeeInput.safeParse({ ...base, weekly_hours: '', pay_model: 'festgehalt', monthly_salary: '2600' })
        .success,
    ).toBe(false);
  });
});
