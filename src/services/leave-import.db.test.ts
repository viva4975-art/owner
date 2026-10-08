import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { leaveBalance, requestAbsence } from './absences.js';
import { applyLeaveImport, parseLeaveSheet, planLeaveImport, yearAndDateOf } from './leave-import.js';
import { sickDays } from './reports.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();
const csv = (s: string) => new TextEncoder().encode(s);

describe('Urlaubskonten-Datei lesen', () => {
  it('Spalten wie Fortytools, Jahr und Stichtag aus dem Dateinamen', () => {
    const s = parseLeaveSheet(
      csv(
        'Mitarbeiter;Personalnummer;Resturlaub Vorjahr;Anspruch Aktuell;Genommene Urlaubstage;Verfügbare Urlaubstage\n' +
          'Muster, Max;7801;23;30;47;-17\nTest, Tina;7802;0;13,5;0;13,5\n',
      ),
    );
    expect(s.kind).toBe('urlaub');
    expect(s.rows[0]).toMatchObject({
      personnel_no: '7801',
      carried: 23,
      entitlement: 30,
      taken: 47,
      available: -17,
    });
    expect(s.rows[1]!.entitlement).toBe(13.5);
    expect(parseLeaveSheet(csv('Mitarbeiter;Personalnummer;Erfasst\nA, B;7801;2\n')).kind).toBe('krank');
    expect(yearAndDateOf('urlaubskonten_2026_2026-10-08.xlsx')).toEqual({ year: 2026, asOf: '2026-10-08' });
  });
});

describe.skipIf(!available)('Urlaub/Krankheit übernehmen (Datenbank)', () => {
  let sql: Sql;
  const a = randomUUID();
  const b = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, annual_leave_days)
              values (${a}, '7801', 'Max', 'Muster', '2020-01-01', 30), (${b}, '7802', 'Tina', 'Test', '2020-01-01', 30)`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Stand zum Stichtag: Rest wie Fortytools, App-Urlaub zählt erst danach, nichts doppelt', async () => {
    // Urlaub in der App vor dem Stichtag (steckt schon in Fortytools) und danach
    await requestAbsence(sql, {
      id: randomUUID(),
      employeeId: b,
      kind: 'urlaub',
      start: '2026-09-07',
      end: '2026-09-08',
      halfDay: false,
      note: null,
      actor: 't',
      approved: true,
    }).catch(() => undefined); // ohne Stand ggf. kein Anspruch – egal
    const sheet = parseLeaveSheet(
      csv(
        'Mitarbeiter;Personalnummer;Resturlaub Vorjahr;Anspruch Aktuell;Genommene Urlaubstage;Verfügbare Urlaubstage\n' +
          'Muster, Max;7801;23;30;47;-17\nTest, Tina;7802;8;30;10;20\nUnbekannt, U;9999;0;30;0;30\n',
      ),
    );
    const plan = await planLeaveImport(sql, sheet);
    expect(plan.map((r) => r.error)).toEqual([null, null, 'Personalnummer 9999 nicht in der App']);
    const r = await applyLeaveImport(sql, sheet, {
      year: 2026,
      asOf: '2026-10-08',
      actor: 't',
      source: 'test',
    });
    expect(r).toEqual({ saved: 2, skipped: 1 });
    const ba = await leaveBalance(sql, a, 2026);
    expect([ba.entitlement, ba.carried, ba.carriedExpired, ba.taken, ba.rest]).toEqual([30, 23, 23, 47, -17]);
    expect((await leaveBalance(sql, b, 2026)).rest).toBe(20);
    await requestAbsence(sql, {
      id: randomUUID(),
      employeeId: b,
      kind: 'urlaub',
      start: '2026-10-12',
      end: '2026-10-13',
      halfDay: false,
      note: null,
      actor: 't',
      approved: true,
    });
    const bb = await leaveBalance(sql, b, 2026);
    expect([bb.taken, bb.rest, bb.openingAsOf]).toEqual([12, 18, '2026-10-08']);
    // erneut importieren ersetzt den Stand
    await applyLeaveImport(sql, sheet, { year: 2026, asOf: '2026-10-08', actor: 't', source: 'test' });
    expect((await leaveBalance(sql, b, 2026)).rest).toBe(18);
  });

  it('Krankheitstage: übernommen + App ab Folgetag', async () => {
    const sheet = parseLeaveSheet(csv('Mitarbeiter;Personalnummer;Erfasst\nMuster, Max;7801;5\n'));
    await applyLeaveImport(sql, sheet, { year: 2026, asOf: '2026-10-08', actor: 't', source: 'test' });
    for (const [s, e] of [
      ['2026-10-05', '2026-10-06'],
      ['2026-10-19', '2026-10-20'],
    ] as const)
      await requestAbsence(sql, {
        id: randomUUID(),
        employeeId: a,
        kind: 'krank',
        start: s,
        end: e,
        halfDay: false,
        note: null,
        actor: 't',
        approved: true,
      });
    const row = (await sickDays(sql, 2026)).find((x) => x.id === a)!;
    expect([row.imported, row.total, row.cases]).toEqual([5, 7, 1]);
    // Urlaubsstand bleibt beim Krank-Import erhalten
    expect((await leaveBalance(sql, a, 2026)).rest).toBe(-17);
  });
});
