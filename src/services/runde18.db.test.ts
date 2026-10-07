import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { deleteAbsence, getAbsence, requestAbsence, updateAbsence } from './absences.js';
import { getApplicant, saveApplicant } from './applicants.js';
import { birthPin, login } from './employee-auth.js';
import { exitEmployee, revokeExit } from './employees.js';
import { saveDraft } from './invoices.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { getEntry, officeRemove, officeSave } from './time.js';

const available = await dbAvailable();

describe.skipIf(!available)('Runde 18 (Datenbank)', () => {
  let sql: Sql;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, annual_leave_days)
              values (${emp}, '8801', 'Rita', 'Runde', '2024-01-01', 30)`;
    await sql`insert into app.employee_private (employee_id, birth_date) values (${emp}, '1985-03-15')`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Austritt zurücknehmen', async () => {
    await exitEmployee(sql, emp, { date: '2026-01-31', reason: 'Sonstiges' });
    await revokeExit(sql, emp);
    const [e] = await sql`select exit_date, exit_reason, status from app.employees where id = ${emp}`;
    expect(e).toMatchObject({ exit_date: null, exit_reason: null, status: 'aktiv' });
    await expect(revokeExit(sql, emp)).rejects.toThrow(/kein Austritt/);
  });

  it('Handy-PIN ohne eigene PIN = Geburtsdatum TTMMJJ, Fehlversuche zählen', async () => {
    expect(birthPin('1985-03-15')).toBe('150385');
    await expect(login(sql, '8801', '111111')).rejects.toThrow(/falsch/);
    const [p] = await sql`select failed_attempts, set_by from app.employee_pins where employee_id = ${emp}`;
    expect(p).toMatchObject({ failed_attempts: 1, set_by: 'Geburtsdatum (automatisch)' });
    const ok = await login(sql, '8801', '150385');
    expect(ok.id).toBe(emp);
  });

  it('Zeit entfernen: zählt nicht mehr, bleibt im Protokoll', async () => {
    const id = randomUUID();
    await officeSave(sql, {
      id,
      employeeId: emp,
      siteId: DEMO.siteSchool,
      date: '2026-10-01',
      start: '06:00',
      end: '10:00',
      breakMinutes: 0,
      reason: 'Test',
      expectedVersion: null,
      actor: 'buero',
    });
    await expect(officeRemove(sql, id, ' ', 'buero')).rejects.toThrow(/begründen/);
    await officeRemove(sql, id, 'doppelt erfasst', 'buero');
    expect((await getEntry(sql, id))?.status).toBe('abgelehnt');
    const log = await sql`select reason from app.time_entry_log where entry_id = ${id} order by id`;
    expect(log.at(-1)?.reason).toBe('entfernt: doppelt erfasst');
    await expect(sql`delete from app.time_entries where id = ${id}`).rejects.toThrow(/nicht gelöscht/);
  });

  it('Abwesenheit ändern und löschen', async () => {
    const id = randomUUID();
    await requestAbsence(sql, {
      id,
      employeeId: emp,
      kind: 'urlaub',
      start: '2026-11-02',
      end: '2026-11-03',
      halfDay: false,
      note: null,
      actor: 'buero',
      approved: true,
    });
    const a = await getAbsence(sql, id);
    await updateAbsence(
      sql,
      id,
      {
        kind: 'krank',
        start: '2026-11-04',
        end: '2026-11-06',
        halfDay: false,
        note: 'AU',
        expectedVersion: a!.version,
      },
      'buero',
    );
    expect(await getAbsence(sql, id)).toMatchObject({
      kind: 'krank',
      start_date: '2026-11-04',
      end_date: '2026-11-06',
    });
    await expect(
      updateAbsence(
        sql,
        id,
        {
          kind: 'krank',
          start: '2026-11-04',
          end: '2026-11-06',
          halfDay: false,
          note: null,
          expectedVersion: 1,
        },
        'buero',
      ),
    ).rejects.toThrow(/zwischenzeitlich/);
    await deleteAbsence(sql, id, 'buero');
    expect(await getAbsence(sql, id)).toBeUndefined();
    const [log] =
      await sql`select details from app.audit_log where entity = 'absence' and entity_id = ${id} and action = 'delete'`;
    expect(log?.details).toMatchObject({ kind: 'krank' });
  });

  it('Bewerber: Stunden mit Komma', async () => {
    const id = randomUUID();
    await saveApplicant(
      sql,
      id,
      {
        name: 'Komma Test',
        phone: null,
        email: null,
        postalCode: null,
        city: null,
        language: null,
        jobType: null,
        hours: 32.5,
        timeOfDay: null,
        experience: null,
        available: null,
        drivingLicence: false,
        note: null,
        expectedVersion: null,
      },
      'buero',
    );
    expect((await getApplicant(sql, id))?.a.hours).toBe(32.5);
  });

  it('Interner Bereich: Objekt „Büro“ vorhanden, keine Rechnungen', async () => {
    const [s] = await sql<
      { customer_id: string }[]
    >`select customer_id from app.sites where site_no = 'INT-BUERO'`;
    expect(s).toBeTruthy();
    await expect(
      saveDraft(
        sql,
        randomUUID(),
        { customerId: s!.customer_id, kind: 'invoice', lines: [] } as never,
        'buero',
      ),
    ).rejects.toThrow(/keine Rechnungen/);
  });
});
