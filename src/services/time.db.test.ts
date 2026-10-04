import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, easterSunday, holidaysBavaria, isoWeekday, workingDays } from '../domain/time/holidays.js';
import { decideAbsence, leaveBalance, listAbsences, requestAbsence } from './absences.js';
import { checkPinRules, login, MAX_ATTEMPTS, setPin, signSession, verifySession } from './employee-auth.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';
import {
  clockIn,
  clockOut,
  confirmPlanned,
  decideCorrection,
  entryLog,
  getEntry,
  officeSave,
  plannedShifts,
  requestCorrection,
  runningEntry,
  saveShiftPlan,
  warningsFor,
  zollCsv,
  zollReport,
} from './time.js';

describe('Feiertage Bayern', () => {
  it('Ostern und bewegliche Feiertage', () => {
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2027)).toBe('2027-03-28');
    const h = holidaysBavaria(2026);
    expect(h.get('2026-04-03')).toBe('Karfreitag');
    expect(h.get('2026-06-04')).toBe('Fronleichnam');
    expect(h.get('2026-08-15')).toBe('Mariä Himmelfahrt');
  });
  it('Arbeitstage ohne Wochenende und Feiertage', () => {
    // 28.12.2026 (Mo) – 08.01.2027 (Fr): 10 Werktage minus Neujahr und Hl. Drei Könige
    expect(workingDays('2026-12-28', '2027-01-08')).toBe(8);
    expect(isoWeekday('2026-10-05')).toBe(1);
  });
});

describe('Zeit-Hinweise', () => {
  it('Pausen nach § 4 ArbZG und 10-Stunden-Grenze', () => {
    expect(warningsFor({ gross_minutes: 6 * 60, break_minutes: 0, late: false, status: 'erfasst' })).toEqual(
      [],
    );
    expect(
      warningsFor({ gross_minutes: 6 * 60 + 1, break_minutes: 15, late: false, status: 'erfasst' })[0],
    ).toMatch(/30 Min/);
    expect(
      warningsFor({ gross_minutes: 9 * 60 + 30, break_minutes: 30, late: false, status: 'erfasst' })[0],
    ).toMatch(/45 Min/);
    expect(
      warningsFor({ gross_minutes: 11 * 60, break_minutes: 45, late: true, status: 'erfasst' }),
    ).toHaveLength(2);
  });
});

describe('PIN-Sitzung', () => {
  it('signiert und prüft, Manipulation fällt auf', () => {
    const secret = 'x'.repeat(40);
    const id = randomUUID();
    const t = signSession(secret, id);
    expect(verifySession(secret, t)).toBe(id);
    expect(verifySession(secret, t.replace(id, randomUUID()))).toBeNull();
    expect(verifySession('y'.repeat(40), t)).toBeNull();
    expect(verifySession(secret, t, Date.now() + 15 * 86400_000)).toBeNull();
  });
  it('lehnt triviale PINs ab', () => {
    expect(() => checkPinRules('1234')).toThrow(/zu einfach/);
    expect(() => checkPinRules('7777')).toThrow(/zu einfach/);
    expect(() => checkPinRules('12a4')).toThrow(/4 bis 6/);
    expect(() => checkPinRules('4821')).not.toThrow();
  });
});

const available = await dbAvailable();

describe.skipIf(!available)('Zeiterfassung, Einsatzplanung, Urlaub (Datenbank)', () => {
  let sql: Sql;
  const emp = randomUUID();
  const other = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, hourly_wage_cents)
              values (${emp}, '2001', 'Elena', 'Popescu', '2024-01-01', 1425), (${other}, '2002', 'Ana', 'Test', '2026-07-01', 1425)`;
    await sql`insert into app.employee_sites (employee_id, site_id) values (${emp}, ${DEMO.siteSchool})`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('PIN-Anmeldung mit Sperre nach Fehlversuchen', async () => {
    await setPin(sql, emp, '4821', 'buero');
    expect((await login(sql, '2001', '4821')).id).toBe(emp);
    await expect(login(sql, '9999', '4821')).rejects.toThrow(/Personalnummer oder PIN falsch/);
    for (let i = 0; i < MAX_ATTEMPTS; i++) await expect(login(sql, '2001', '0001')).rejects.toThrow(/falsch/);
    await expect(login(sql, '2001', '4821')).rejects.toThrow(/Zu viele Fehlversuche/);
    await setPin(sql, emp, '4821', 'buero'); // Büro entsperrt
    expect((await login(sql, '2001', '4821')).id).toBe(emp);
    const [row] = await sql`select pin_hash from app.employee_pins where employee_id = ${emp}`;
    expect(String(row!.pin_hash)).not.toContain('4821');
  });

  it('Stempeln: idempotent, nur einmal gleichzeitig, nur zugeordnete Objekte', async () => {
    const id = randomUUID();
    await clockIn(sql, { id, employeeId: emp, siteId: DEMO.siteSchool, viaQr: true, actor: 'm:2001' });
    await clockIn(sql, { id, employeeId: emp, siteId: DEMO.siteSchool, viaQr: true, actor: 'm:2001' }); // Funkloch → nochmal gesendet
    expect((await runningEntry(sql, emp))!.id).toBe(id);
    await expect(
      clockIn(sql, {
        id: randomUUID(),
        employeeId: emp,
        siteId: DEMO.siteSchool,
        viaQr: false,
        actor: 'm:2001',
      }),
    ).rejects.toThrow(/Schon eingestempelt/);
    await expect(
      clockIn(sql, {
        id: randomUUID(),
        employeeId: other,
        siteId: DEMO.siteSchool,
        viaQr: false,
        actor: 'm:2002',
      }),
    ).rejects.toThrow(/nicht zugeordnet/);
    expect(await clockOut(sql, { employeeId: emp, breakMinutes: 0, actor: 'm:2001' })).toBe(id);
    expect(await clockOut(sql, { employeeId: emp, breakMinutes: 0, actor: 'm:2001' })).toBeNull();
    const e = (await getEntry(sql, id))!;
    expect(e.status).toBe('erfasst');
    expect(e.via_qr).toBe(true);
    expect(e.work_date).toBe(todayBerlin());
  });

  it('Erfasste Zeiten: nicht löschbar, Änderung nur mit Begründung und protokolliert', async () => {
    const [e] = await sql<
      { id: string }[]
    >`select id from app.time_entries where employee_id = ${emp} limit 1`;
    await expect(sql`delete from app.time_entries where id = ${e!.id}`).rejects.toThrow(/nicht gelöscht/);
    await expect(sql`update app.time_entries set break_minutes = 5 where id = ${e!.id}`).rejects.toThrow(
      /Begründung/,
    );
    await expect(sql`update app.time_entry_log set reason = 'x'`).rejects.toThrow();
  });

  it('Einsatzplanung + Soll als Ist (nur nach Schichtende, nur einmal, mit Bestätigung)', async () => {
    const yesterday = addDays(todayBerlin(), -1);
    const [plan] = await saveShiftPlan(
      sql,
      randomUUID(),
      {
        employeeId: emp,
        siteId: DEMO.siteSchool,
        weekdays: [isoWeekday(yesterday)],
        startTime: '05:00',
        endTime: '08:30',
        breakMinutes: 0,
        validFrom: '2026-01-01',
        validUntil: null,
        note: null,
      },
      'buero',
    );
    // vor dem Anlegen geplanter Tage zählen nicht als Soll
    expect(await plannedShifts(sql, { from: yesterday, to: yesterday, employeeId: emp })).toHaveLength(0);
    await expect(
      confirmPlanned(sql, { employeeId: emp, planId: plan!, date: yesterday, confirmed: true, actor: 'm' }),
    ).rejects.toThrow(/Kein geplanter/);
    await sql`update app.shift_plans set created_at = now() - interval '30 days' where id = ${plan!}`;
    const shifts = await plannedShifts(sql, { from: yesterday, to: yesterday, employeeId: emp });
    expect(shifts).toHaveLength(1);
    expect(shifts[0]!.minutes).toBe(210);
    await expect(
      confirmPlanned(sql, { employeeId: emp, planId: plan!, date: yesterday, confirmed: false, actor: 'm' }),
    ).rejects.toThrow(/bestätigen/);
    const a = await confirmPlanned(sql, {
      employeeId: emp,
      planId: plan!,
      date: yesterday,
      confirmed: true,
      actor: 'm',
    });
    const b = await confirmPlanned(sql, {
      employeeId: emp,
      planId: plan!,
      date: yesterday,
      confirmed: true,
      actor: 'm',
    });
    expect(a).toBe(b);
    const e = (await getEntry(sql, a))!;
    expect(e.source).toBe('soll_bestaetigt');
    expect(
      e.start_at.toLocaleTimeString('de-DE', {
        timeZone: 'Europe/Berlin',
        hour: '2-digit',
        minute: '2-digit',
      }),
    ).toBe('05:00');
    await expect(
      confirmPlanned(sql, {
        employeeId: emp,
        planId: plan!,
        date: addDays(todayBerlin(), 7),
        confirmed: true,
        actor: 'm',
      }),
    ).rejects.toThrow(/7 Tage/);
    expect(
      (await plannedShifts(sql, { from: yesterday, to: yesterday, employeeId: emp }))[0]!.entry?.id,
    ).toBe(a);
  });

  it('Nachtrag: beantragt → Freigabe; Überschneidung wird abgelehnt', async () => {
    const day = addDays(todayBerlin(), -3);
    const id = randomUUID();
    await requestCorrection(sql, {
      id,
      employeeId: emp,
      siteId: DEMO.siteSchool,
      date: day,
      start: '17:00',
      end: '21:30',
      breakMinutes: 0,
      reason: 'Handy-Akku leer',
      actor: 'm:2001',
    });
    expect((await getEntry(sql, id))!.status).toBe('beantragt');
    await expect(
      requestCorrection(sql, {
        id: randomUUID(),
        employeeId: emp,
        siteId: DEMO.siteSchool,
        date: day,
        start: '20:00',
        end: '22:00',
        breakMinutes: 0,
        reason: 'doppelt',
        actor: 'm:2001',
      }),
    ).rejects.toThrow(/Überschneidet/);
    await decideCorrection(sql, id, true, 'objektleitung', null);
    expect((await getEntry(sql, id))!.status).toBe('freigegeben');
  });

  it('Büro-Korrektur protokolliert alten und neuen Stand', async () => {
    const day = addDays(todayBerlin(), -4);
    const id = randomUUID();
    await officeSave(sql, {
      id,
      employeeId: emp,
      siteId: DEMO.siteSchool,
      date: day,
      start: '06:00',
      end: '13:00',
      breakMinutes: 30,
      reason: 'Stundenzettel',
      expectedVersion: null,
      actor: 'buero',
    });
    const v = (await getEntry(sql, id))!.version;
    await officeSave(sql, {
      id,
      employeeId: emp,
      siteId: DEMO.siteSchool,
      date: day,
      start: '06:00',
      end: '12:30',
      breakMinutes: 30,
      reason: 'Korrektur lt. Objektleitung',
      expectedVersion: v,
      actor: 'buero',
    });
    await expect(
      officeSave(sql, {
        id,
        employeeId: emp,
        siteId: DEMO.siteSchool,
        date: day,
        start: '06:00',
        end: '12:00',
        breakMinutes: 30,
        reason: 'alter Tab',
        expectedVersion: v,
        actor: 'buero',
      }),
    ).rejects.toThrow(/zwischenzeitlich/);
    const log = await entryLog(sql, id);
    expect(log).toHaveLength(2);
    expect(log[1]!.reason).toBe('Korrektur lt. Objektleitung');
    expect(log[1]!.actor).toBe('buero');
    expect(log[1]!.old_row!.end_at).not.toEqual(log[1]!.new_row.end_at);
  });

  it('Prüfbericht § 17 MiLoG mit Beginn, Ende, Dauer, Aufzeichnungszeitpunkt', async () => {
    const from = addDays(todayBerlin(), -10);
    const { rows } = await zollReport(sql, { from, to: todayBerlin(), employeeId: emp });
    const r = rows.find((x) => x.net_minutes === 360)!; // 06:00–12:30, 30 Min. Pause
    expect(r).toBeDefined();
    const csv = zollCsv(rows);
    expect(csv).toContain('Personalnummer;Name;Datum;Objekt;Beginn;Ende');
    expect(csv).toContain('06:00;12:30;30;6:00');
  });

  it('Urlaub: Antrag, keine Überschneidung, Genehmigung, Resturlaub, Einsatz fällt aus', async () => {
    const id = randomUUID();
    await requestAbsence(sql, {
      id,
      employeeId: emp,
      kind: 'urlaub',
      start: '2026-12-28',
      end: '2027-01-08',
      halfDay: false,
      note: null,
      actor: 'm:2001',
    });
    await expect(
      requestAbsence(sql, {
        id: randomUUID(),
        employeeId: emp,
        kind: 'urlaub',
        start: '2027-01-04',
        end: '2027-01-05',
        halfDay: false,
        note: null,
        actor: 'm:2001',
      }),
    ).rejects.toThrow(/schon eine Abwesenheit/);
    let bal = await leaveBalance(sql, emp, 2026);
    expect(bal.requested).toBe(4); // 28.–31.12.
    await decideAbsence(sql, id, 'genehmigt', 'buero');
    bal = await leaveBalance(sql, emp, 2027);
    expect(bal.taken).toBe(4); // 4.–8.1. ohne Hl. Drei Könige
    expect(bal.carried).toBe(26); // Resturlaub 2026 (30 − 4) wird übertragen, nutzbar bis 31.03.2027
    expect(bal.rest).toBe(30 + 26 - 4);
    expect((await listAbsences(sql, { employeeId: emp }))[0]!.days).toBe(8);
    // anteiliger Anspruch bei Eintritt 01.07.
    expect((await leaveBalance(sql, other, 2026)).entitlement).toBe(15);
    // geplanter Einsatz im Urlaub ist markiert
    await saveShiftPlan(
      sql,
      randomUUID(),
      {
        employeeId: emp,
        siteId: DEMO.siteSchool,
        weekdays: [1, 2, 3, 4, 5],
        startTime: '17:00',
        endTime: '20:00',
        breakMinutes: 0,
        validFrom: '2026-12-01',
        validUntil: null,
        note: null,
      },
      'buero',
    );
    const s = await plannedShifts(sql, { from: '2027-01-04', to: '2027-01-04', employeeId: emp });
    expect(s.some((x) => x.absence === 'urlaub')).toBe(true);
  });
});
