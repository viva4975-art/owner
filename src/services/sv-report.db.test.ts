import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { addDays } from '../domain/time/holidays.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { collectReminders } from './reminders.js';
import { missingDocs } from './hr-required-docs.js';
import {
  deleteSofort,
  flagWorkWithoutSofort,
  listSofort,
  missingSofort,
  recordSofort,
  sofortData,
  sofortTaskId,
} from './sv-report.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('SV-Sofortmeldung', () => {
  let sql: Sql;
  const emp = randomUUID();
  const old = randomUUID();
  const today = todayBerlin();
  const entry = addDays(today, 2) > '2026-10-08' ? addDays(today, 2) : '2026-10-10';
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`update app.company set betriebsnummer = '12345678'`;
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type, salutation)
              values (${emp}, '9781', 'Neu', 'Kraft', ${entry}, 'minijob', 'Frau'),
                     (${old}, '9782', 'Alt', 'Kraft', '2025-03-01', 'teilzeit', 'Herr')`;
    await sql`insert into app.employee_private (employee_id, birth_date, birth_place, nationality, street, postal_code, city)
              values (${emp}, '1990-05-04', 'Bukarest', 'Rumänien', 'Teststr. 1', '81375', 'München')`;
  }, 60_000);
  afterAll(async () => {
    await sql?.end();
  });

  it('fehlt für neue, nicht für Eintritte vor der Umstellung; erscheint in Erinnerungen und Unterlagen', async () => {
    const m = await missingSofort(sql);
    expect(m.map((x) => x.employee_id)).toContain(emp);
    expect(m.map((x) => x.employee_id)).not.toContain(old);
    const r = await collectReminders(sql);
    expect(r.some((x) => x.text.includes('SV-Sofortmeldung fehlt') && x.href.includes(emp))).toBe(true);
    const d = await missingDocs(sql);
    expect(d.find((x) => x.employee_id === emp)?.missing).toContain('SV-Sofortmeldung');
  });

  it('Meldedaten ohne SV-Nummer verlangen Geburtsangaben, vollständig mit Betriebsnummer', async () => {
    const { fields, complete } = await sofortData(sql, emp);
    expect(complete).toBe(true);
    expect(fields.find((f) => f.label === 'Geschlecht')?.value).toBe('weiblich');
    expect(fields.find((f) => f.label.startsWith('Betriebsnummer'))?.value).toBe('12345678');
  });

  it('Stempeln ohne Meldung legt einmal eine Aufgabe an; Festhalten erledigt sie', async () => {
    expect(await flagWorkWithoutSofort(sql, emp, 't')).toBe(true);
    expect(await flagWorkWithoutSofort(sql, emp, 't')).toBe(false);
    const id = randomUUID();
    const p = {
      id,
      employeeId: emp,
      reportedAt: new Date(Date.now() - 60_000).toISOString(),
      transferNo: 'ABC123',
      via: 'lexware' as const,
      note: null,
      actor: 't',
    };
    expect(await recordSofort(sql, p)).toBe(true);
    expect(await recordSofort(sql, p)).toBe(false); // doppelt abgesendet
    const [t] = await sql<
      { status: string }[]
    >`select status from app.tasks where id = ${sofortTaskId(emp, entry)}`;
    expect(t?.status).toBe('done');
    expect((await missingSofort(sql)).map((x) => x.employee_id)).not.toContain(emp);
    expect(await flagWorkWithoutSofort(sql, emp, 't')).toBe(false);
    await expect(
      recordSofort(sql, { ...p, id: randomUUID(), reportedAt: '2099-01-01T00:00:00Z' }),
    ).rejects.toThrow('Zukunft');
    await deleteSofort(sql, id, 't');
    expect(await listSofort(sql, emp)).toHaveLength(0);
  });
});
