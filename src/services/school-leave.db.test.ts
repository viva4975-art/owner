import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { bussUndBettag } from '../domain/time/school-holidays.js';
import { leaveBalance, requestAbsence } from './absences.js';
import { ackLeaveWarning, isOpen, leaveWarnings } from './leave-warnings.js';
import { distribute, schoolLeave, splitPeriod } from './school-leave.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();
const TODAY = '2026-10-11';

describe('Schulferien – Hilfsfunktionen', () => {
  it('Buß- und Bettag, Verteilung, Urlaub in der Mitte', () => {
    expect(bussUndBettag(2026)).toBe('2026-11-18');
    expect(bussUndBettag(2027)).toBe('2027-11-17');
    expect(distribute(10, [5, 1, 5])).toEqual([5, 1, 4]);
    expect(distribute(20, [5, 1, 5])).toEqual([5, 1, 5]);
    expect(distribute(0, [5, 5])).toEqual([0, 0]);
    // Sommerferien 2026: 03.08.–14.09. → 8 Urlaubstage in der Mitte, davor/danach unbezahlt
    const p = splitPeriod('2026-08-03', '2026-09-14', 8);
    expect(p.map((x) => x.kind)).toEqual(['unbezahlt', 'urlaub', 'unbezahlt']);
    expect(p.reduce((a, x) => a + x.days, 0)).toBe(31); // Mariä Himmelfahrt 2026 ist ein Samstag
    expect(p[1]).toMatchObject({ days: 8 });
  });
});

describe.skipIf(!available)('Schulferien automatisch, Urlaubs-Warnung (Datenbank)', () => {
  let sql: Sql;
  const a = randomUUID();
  const mixed = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`update app.sites set school_closure = true where id = ${DEMO.siteSchool}`;
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, annual_leave_days)
              values (${a}, '99201', 'Sabine', 'Schule', '2026-01-01', 10),
                     (${mixed}, '99202', 'Max', 'Gemischt', '2026-01-01', 30)`;
    const plan = (emp: string, site: string, wd: number) =>
      sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, valid_from)
          values (${randomUUID()}, ${emp}, ${site}, ${wd}, '06:00', '09:00', '2026-09-01')`;
    for (const wd of [1, 2, 3, 4, 5]) {
      await plan(a, DEMO.siteSchool, wd);
      await plan(mixed, DEMO.siteSchool, wd);
    }
    await plan(mixed, DEMO.siteOffice, 2);
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Vorschau: Resturlaub 2026 auf die restlichen Ferien, Rest unbezahlt; gemischte Einsätze übersprungen', async () => {
    const r = await schoolLeave(sql, { siteId: DEMO.siteSchool, apply: false, actor: 't', today: TODAY });
    const mine = r.planned.filter((p) => p.employee_id === a);
    const y26 = mine.filter((p) => p.to <= '2026-12-31');
    expect(y26.map((p) => p.period)).toEqual([
      'Herbstferien 2026',
      'Buß- und Bettag 2026',
      'Weihnachtsferien 2026',
    ]);
    // 11 schulfreie Arbeitstage, 10 Tage Urlaub
    expect(y26.reduce((s, p) => s + p.vacation, 0)).toBe(10);
    expect(y26.reduce((s, p) => s + p.unpaid, 0)).toBe(1);
    // 2027 (Ferien nur bis Sommer bekannt): nur ein Teil des Jahresurlaubs verplant
    const y27 = mine.filter((p) => p.from >= '2027-01-01');
    expect(y27.reduce((s, p) => s + p.vacation, 0)).toBeLessThan(10);
    expect(y27.reduce((s, p) => s + p.vacation, 0)).toBeGreaterThan(0);
    expect(r.skipped.some((x) => x.employee_id === mixed && x.reason.includes('arbeitet auch'))).toBe(true);
    expect(r.planned.some((p) => p.employee_id === mixed)).toBe(false);
  });

  it('Eintragen legt Urlaub + unbezahlt an, zweiter Lauf legt nichts doppelt an', async () => {
    const r = await schoolLeave(sql, { siteId: DEMO.siteSchool, apply: true, actor: 't', today: TODAY });
    expect(r.planned.length).toBeGreaterThan(0);
    const abs = await sql<{ kind: string; auto_school: boolean; status: string }[]>`
      select kind, auto_school, status from app.absences where employee_id = ${a}`;
    expect(abs.every((x) => x.auto_school && x.status === 'genehmigt')).toBe(true);
    expect(abs.some((x) => x.kind === 'urlaub')).toBe(true);
    expect(abs.some((x) => x.kind === 'unbezahlt')).toBe(true);
    expect((await leaveBalance(sql, a, 2026)).rest).toBe(0);
    const again = await schoolLeave(sql, { siteId: DEMO.siteSchool, apply: true, actor: 't', today: TODAY });
    expect(again.planned.filter((p) => p.employee_id === a)).toEqual([]);
    expect(again.done).toBeGreaterThan(0);
    const [n] = await sql<
      { n: number }[]
    >`select count(*)::int as n from app.absences where employee_id = ${a}`;
    expect(n!.n).toBe(abs.length);
  });

  it('Kein Resturlaub: Warnung, abhaken, Rückfrage beim Eintragen, Warnung kommt bei weiterem Minus wieder', async () => {
    let w = (await leaveWarnings(sql, TODAY)).find((x) => x.employee_id === a && x.year === 2026);
    expect(w && isOpen(w)).toBe(true);
    await ackLeaveWarning(sql, a, 2026, 't');
    w = (await leaveWarnings(sql, TODAY)).find((x) => x.employee_id === a && x.year === 2026);
    expect(w && isOpen(w)).toBe(false);
    const extra = {
      id: randomUUID(),
      employeeId: a,
      kind: 'urlaub' as const,
      start: '2026-10-20',
      end: '2026-10-20',
      halfDay: false,
      note: null,
      actor: 't',
      approved: true,
    };
    await expect(requestAbsence(sql, extra)).rejects.toMatchObject({ code: 'no_leave' });
    await requestAbsence(sql, { ...extra, allowNoLeave: true });
    expect((await leaveBalance(sql, a, 2026)).rest).toBe(-1);
    w = (await leaveWarnings(sql, TODAY)).find((x) => x.employee_id === a && x.year === 2026);
    expect(w && isOpen(w)).toBe(true);
    const [log] =
      await sql`select 1 from app.audit_log where entity_id = ${extra.id} and details ? 'urlaub_ohne_anspruch'`;
    expect(log).toBeTruthy();
  });
});
