import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { deleteFirstAid, listFirstAid, saveFirstAid } from './first-aid.js';
import {
  addConfirmation,
  getAppointment,
  importLegacyGlass,
  removeConfirmation,
  saveAppointment,
} from './glass.js';
import { missingDocs, resetTimesheetCache, unsignedTimesheets } from './hr-required-docs.js';
import { DEMO } from './seed.js';
import { saveSiteSpecial } from './site-folder.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { officeConfirmPlanned } from './time.js';

const available = await dbAvailable();

describe.skipIf(!available)('Runde 44 (Datenbank)', () => {
  let sql: Sql;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date)
              values (${emp}, '8844', 'Verband', 'Buch', '2024-01-01')`;
    await sql`insert into app.employee_sites (employee_id, site_id) values (${emp}, ${DEMO.siteSchool})`;
    await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, valid_from, valid_until, created_at)
              values (${randomUUID()}, ${emp}, ${DEMO.siteSchool}, 1, '06:00', '09:00', '2026-10-01', '2026-10-31', '2026-09-01')`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Glas-Import: Block-Termin nur mit datum/datum_bis → Einzeltage Mo–Fr', async () => {
    await importLegacyGlass(
      sql,
      {
        objekte: [{ id: 'o44', name: 'Schule 44', kunde: 'Stadt', adresse: 'Weg 1, 81375 München' }],
        termine: [
          {
            id: 't44',
            objektid: 'o44',
            datum: '2027-03-05',
            datum_bis: '2027-03-09',
            uhrzeit: '08:00',
            uhrzeit_bis: '15:00',
          },
        ],
      },
      't',
    );
    const [a] = await sql<{ days: { date: string }[]; last_day: string }[]>`
      select days, last_day::text from app.glass_appointments where legacy_id = 'gpt:t44'`;
    expect(a!.days.map((d) => d.date)).toEqual(['2027-03-05', '2027-03-08', '2027-03-09']);
    expect(a!.last_day).toBe('2027-03-09');
  });

  it('Glas: mehrere Bestätigungen, bleiben beim Verschieben des Termins', async () => {
    const [ap] = await sql<{ id: string; object_id: string }[]>`
      select id, object_id from app.glass_appointments where legacy_id = 'gpt:t44'`;
    const e1 = randomUUID();
    await addConfirmation(
      sql,
      ap!.id,
      { id: e1, at: '2026-10-19', text: 'Hausmeister telefonisch' },
      'buero',
    );
    await addConfirmation(
      sql,
      ap!.id,
      { id: e1, at: '2026-10-19', text: 'Hausmeister telefonisch' },
      'buero',
    );
    await addConfirmation(
      sql,
      ap!.id,
      { id: randomUUID(), at: '2026-10-20', text: 'Schule per Mail' },
      'buero',
    );
    await saveAppointment(
      sql,
      ap!.id,
      {
        objectId: ap!.object_id,
        part: null,
        days: [{ date: '2027-04-12', from: '08:00', to: '15:00' }],
        hours: null,
        interval: 'einmalig',
        team: null,
        staff: null,
        note: null,
        done: false,
        expectedVersion: null,
      },
      'buero',
    );
    let a = await getAppointment(sql, ap!.id);
    expect(a!.first_day).toBe('2027-04-12');
    expect(a!.confirmations.map((k) => k.text)).toEqual(['Hausmeister telefonisch', 'Schule per Mail']);
    await removeConfirmation(sql, ap!.id, e1, 'buero');
    a = await getAppointment(sql, ap!.id);
    expect(a!.confirmations).toHaveLength(1);
    expect(a!.confirmed).toBe(true);
  });

  it('Besonderheiten am Objekt speichern und leeren', async () => {
    await saveSiteSpecial(sql, DEMO.siteSchool, 'Kita – nur nach 17 Uhr', 't');
    const [s] = await sql<
      { v: string | null }[]
    >`select folder_info ->> 'besonderheiten' as v from app.sites where id = ${DEMO.siteSchool}`;
    expect(s!.v).toBe('Kita – nur nach 17 Uhr');
    await saveSiteSpecial(sql, DEMO.siteSchool, '  ', 't');
    const [s2] = await sql<
      { v: string | null }[]
    >`select folder_info ->> 'besonderheiten' as v from app.sites where id = ${DEMO.siteSchool}`;
    expect(s2!.v).toBeNull();
  });

  it('Stundenliste nicht unterschrieben erscheint in den fehlenden Unterlagen', async () => {
    await officeConfirmPlanned(sql, {
      employeeId: emp,
      from: '2026-10-01',
      to: '2026-10-31',
      actor: 'buero',
    });
    resetTimesheetCache();
    const m = await unsignedTimesheets(sql, '2026-11-15');
    expect(m.get(emp)).toEqual(['Stundenliste Oktober 2026 nicht unterschrieben']);
    resetTimesheetCache();
    const row = (
      await missingDocs(sql, { siteIds: [DEMO.siteSchool], limited: true, today: '2026-11-15' })
    ).find((r) => r.employee_id === emp);
    expect(row?.missing.some((x) => x.startsWith('Stundenliste'))).toBe(true);
    expect(row?.missing.some((x) => x.startsWith('Stammdaten'))).toBe(false);
  });

  it('Verbandbuch: anlegen, Objektleitung nur eigene Objekte, ändern mit Protokoll, löschen', async () => {
    const id = randomUUID();
    const base = {
      id,
      employeeId: emp,
      siteId: DEMO.siteSchool,
      occurredAt: '2026-10-12T08:15',
      place: 'Treppenhaus',
      whatHappened: 'An Glasscheibe geschnitten',
      injury: 'Schnitt Finger',
      measures: 'Pflaster',
      firstAider: 'Olga',
      witnesses: null,
      doctor: false,
      lostDays: false,
      note: null,
      version: null,
    };
    await expect(saveFirstAid(sql, { ...base, siteId: null }, 'ol', [DEMO.siteSchool])).rejects.toThrow(
      'Objekte',
    );
    await saveFirstAid(sql, base, 'ol', [DEMO.siteSchool]);
    await saveFirstAid(sql, base, 'ol', [DEMO.siteSchool]); // doppelt absenden
    expect(await listFirstAid(sql, { employeeId: emp })).toHaveLength(1);
    expect(await listFirstAid(sql, { siteIds: [randomUUID()] })).toHaveLength(0);
    await saveFirstAid(sql, { ...base, injury: 'Schnitt Daumen', version: 1 }, 'buero', null);
    await expect(saveFirstAid(sql, { ...base, version: 1 }, 'buero', null)).rejects.toThrow('inzwischen');
    const [log] = await sql<{ details: { vorher: { injury: string } } }[]>`
      select details from app.audit_log where entity = 'first_aid' and entity_id = ${id} and action = 'update'`;
    expect(log!.details.vorher.injury).toBe('Schnitt Finger');
    await deleteFirstAid(sql, id, 'admin');
    expect(await listFirstAid(sql, { employeeId: emp })).toHaveLength(0);
  });
});
