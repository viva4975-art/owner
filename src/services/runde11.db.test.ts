import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { requestAbsence } from './absences.js';
import {
  employeeInput,
  employmentHistory,
  exitEmployee,
  getEmployee,
  reenterEmployee,
  saveEmployee,
} from './employees.js';
import { payrollCsv, getPayrollSettings, payrollMonth } from './payroll.js';
import { createQualityCheck } from './facility.js';
import {
  auditRooms,
  auditScore,
  createTicket,
  itemsForRoomType,
  listTickets,
  qmSites,
  saveRoomRatings,
  setTicketStatus,
  deleteQmItem,
  deleteUsageType,
  listQmItems,
  saveQmItem,
  saveUsageType,
  usageTypeItemIds,
} from './qm.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Runde 11: Lohnarten und Urlaubsanspruch (Datenbank)', () => {
  let sql: Sql;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, hourly_wage_cents, pay_model, annual_leave_days)
              values (${emp}, '4001', 'Nina', 'Lohn', '2024-01-01', 1500, 'individuell', 2)`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  const entry = async (day: string, from: string, to: string, brk = 0) =>
    sql`insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source, status, created_by)
        values (${randomUUID()}, ${emp}, ${DEMO.siteSchool}, ${day},
                (${day}::date + ${from}::time) at time zone 'Europe/Berlin',
                (${day}::date + ${to}::time + case when ${to}::time <= ${from}::time then interval '1 day' else interval '0' end) at time zone 'Europe/Berlin',
                ${brk}, 'buero', 'erfasst', 'test')`;

  it('Normalstunden, Nacht- und Sonntagszuschlag, Beträge, CSV', async () => {
    await entry('2026-10-07', '22:00', '02:00'); // Mi Nacht 4 Std.
    await entry('2026-10-11', '06:00', '10:00'); // So 4 Std.
    await entry('2026-10-03', '08:00', '10:00'); // Feiertag (Sa) 2 Std.
    const [r] = await payrollMonth(sql, '2026-10', emp);
    expect(r!.minutes.normal).toBe(600);
    expect(r!.minutes.nacht).toBe(240);
    expect(r!.minutes.sonntag).toBe(240);
    expect(r!.minutes.feiertag).toBe(120);
    expect(r!.surchargeCents.nacht).toBe(1800n); // 4 × 15 € × 30 %
    expect(r!.surchargeCents.sonntag).toBe(4800n); // 4 × 15 € × 80 %
    expect(r!.surchargeCents.feiertag).toBe(2400n); // 2 × 15 € × 80 %
    await sql`update app.employees set regular_sunday_work = true where id = ${emp}`;
    const [r2] = await payrollMonth(sql, '2026-10', emp);
    expect(r2!.surchargeCents.sonntag).toBe(4800n); // 80 %
    const csv = payrollCsv([r2!], await getPayrollSettings(sql), '2026-10');
    expect(csv).toContain('2026-10;4001;Lohn, Nina;;Zuschlag Sonntagsarbeit;4,00;80;15,00;48,00');
  });

  it('Urlaub ohne ausreichenden Anspruch wird abgelehnt', async () => {
    await expect(
      requestAbsence(sql, {
        id: randomUUID(),
        employeeId: emp,
        kind: 'urlaub',
        start: '2026-11-02',
        end: '2026-11-04',
        halfDay: false,
        note: null,
        actor: 'buero',
        approved: true,
      }),
    ).rejects.toThrow(/Kein ausreichender Urlaubsanspruch 2026: Rest 2 Tage, beantragt 3 Tage/);
    await requestAbsence(sql, {
      id: randomUUID(),
      employeeId: emp,
      kind: 'urlaub',
      start: '2026-11-02',
      end: '2026-11-03',
      halfDay: false,
      note: null,
      actor: 'buero',
      approved: true,
    });
    // Krank geht immer
    await requestAbsence(sql, {
      id: randomUUID(),
      employeeId: emp,
      kind: 'krank',
      start: '2026-11-09',
      end: '2026-11-13',
      halfDay: false,
      note: null,
      actor: 'buero',
      approved: true,
    });
  });

  it('QM-App: Tickets je Objekt, Nummern, doppelt senden, erledigt, Sichtbereich', async () => {
    const id = randomUUID();
    const p = {
      siteId: DEMO.siteSchool,
      roomId: null,
      title: 'Seife fehlt WC',
      description: null,
      priority: 'hoch',
    };
    await createTicket(sql, id, p, 'qm');
    await createTicket(sql, id, p, 'qm'); // doppelt gesendet
    let open = await listTickets(sql, { siteIds: null, siteId: DEMO.siteSchool });
    expect(open).toHaveLength(1);
    expect(open[0]!.number).toMatch(/^T-\d{4}-0001$/);
    expect((await qmSites(sql, [DEMO.siteSchool]))[0]!.open_tickets).toBe(1);
    expect(await listTickets(sql, { siteIds: [] })).toHaveLength(0);
    await setTicketStatus(sql, id, 'erledigt', 'qm');
    open = await listTickets(sql, { siteIds: null, siteId: DEMO.siteSchool });
    expect(open).toHaveLength(0);
    await expect(createTicket(sql, randomUUID(), { ...p, title: ' ' }, 'qm')).rejects.toThrow(
      /worum es geht/,
    );
  });

  it('Audit Raum für Raum: Noten, Ja/Nein, Überspringen, Ergebnis, Kontrollzeile', async () => {
    const room = randomUUID();
    await sql`insert into app.rooms (id, site_id, name, floor, room_no, room_type_id, floor_covering, area_centi, visits_per_year)
              values (${room}, ${DEMO.siteSchool}, 'Flur', 'UG', 'A 0.01', '00000000-0000-4000-8000-0000000a0001', 'Parkett', 1200, 260)`;
    const items = await itemsForRoomType(sql, '00000000-0000-4000-8000-0000000a0001');
    expect(items.map((i) => i.name)).toContain('Fensterbänke');
    const qc = randomUUID();
    await createQualityCheck(
      sql,
      qc,
      { siteId: DEMO.siteSchool, checkDate: '2026-10-06', inspector: 'QM', attendee: null },
      'qm',
    );
    const by = (n: string) => items.find((i) => i.name === n)!.id;
    await saveRoomRatings(sql, {
      checkId: qc,
      roomId: room,
      ratings: [
        { itemId: by('Gesamteindruck'), value: 4, skipped: false, note: 'gut', photoIds: [] }, // Punkte 4 von 5 = 75 %
        { itemId: by('Boden'), value: 1, skipped: false, note: null, photoIds: [] },
        { itemId: by('Abfallbehälter geleert'), value: 6, skipped: false, note: 'voll', photoIds: [] },
        { itemId: by('Türen'), value: null, skipped: true, note: null, photoIds: [] },
      ],
      actor: 'qm',
    });
    expect(await auditScore(sql, qc)).toBe(58); // (75 + 100 + 0) / 3
    const [r] = (await auditRooms(sql, qc, DEMO.siteSchool)).filter((x) => x.id === room);
    expect([r!.rated, r!.score]).toEqual([4, 58]);
    const [line] =
      await sql`select rating::text, defects from app.quality_check_items where check_id = ${qc} and room_id = ${room}`;
    expect(line!.rating).toBe('mangel');
    expect(line!.defects).toEqual(['Abfallbehälter geleert']);
    await expect(
      saveRoomRatings(sql, {
        checkId: qc,
        roomId: room,
        ratings: [{ itemId: by('Boden'), value: 9, skipped: false, note: null, photoIds: [] }],
        actor: 'qm',
      }),
    ).rejects.toThrow(/ungültig/);
  });

  it('QM-Einstellungen: Gut/Mittel/Schlecht, Nutzungsart mit Gegenständen, Löschschutz', async () => {
    const item = randomUUID();
    await saveQmItem(sql, item, { name: 'Lichtschalter T', kind: 'gms', active: true, sortOrder: null });
    const type = randomUUID();
    await expect(
      saveUsageType(sql, type, { name: 'Besprechung T', active: true, itemIds: [], expectedVersion: null }),
    ).rejects.toThrow(/mindestens einen/);
    await saveUsageType(sql, type, {
      name: 'Besprechung T',
      active: true,
      itemIds: [item, '00000000-0000-4000-8000-0000000f0002', item],
      expectedVersion: null,
    });
    expect(await usageTypeItemIds(sql, type)).toHaveLength(2);
    const room = randomUUID();
    await sql`insert into app.rooms (id, site_id, name, room_type_id, area_centi, visits_per_year)
              values (${room}, ${DEMO.siteSchool}, 'Raum T', ${type}, 2000, 52)`;
    await expect(deleteUsageType(sql, type)).rejects.toThrow(/nicht löschbar/);
    const qc = randomUUID();
    await createQualityCheck(
      sql,
      qc,
      { siteId: DEMO.siteSchool, checkDate: '2026-10-06', inspector: 'QM', attendee: null },
      'qm',
    );
    await expect(
      saveRoomRatings(sql, {
        checkId: qc,
        roomId: room,
        ratings: [{ itemId: item, value: 5, skipped: false, note: null, photoIds: [] }],
        actor: 'qm',
      }),
    ).rejects.toThrow(/ungültig/);
    await saveRoomRatings(sql, {
      checkId: qc,
      roomId: room,
      ratings: [
        { itemId: item, value: 2, skipped: false, note: null, photoIds: [] }, // Mittel = 50 %
        {
          itemId: '00000000-0000-4000-8000-0000000f0002',
          value: 1,
          skipped: false,
          note: null,
          photoIds: [],
        },
      ],
      actor: 'qm',
    });
    const [r] = (await auditRooms(sql, qc, DEMO.siteSchool)).filter((x) => x.id === room);
    expect(r!.score).toBe(75);
    await expect(deleteQmItem(sql, item)).rejects.toThrow(/nicht löschbar/);
    await expect(
      saveQmItem(sql, item, { name: 'Lichtschalter T', kind: 'note', active: true, sortOrder: null }),
    ).rejects.toThrow(/nicht änderbar/);
    const spare = randomUUID();
    await saveQmItem(sql, spare, { name: 'Spare T', kind: 'punkte', active: true, sortOrder: null });
    await deleteQmItem(sql, spare);
    expect((await listQmItems(sql)).some((i) => i.id === spare)).toBe(false);
  });

  it('Mitarbeiter: Beschäftigungsart als Tag, App-Sprache, Arbeitserlaubnis, Austritt und Wiedereintritt', async () => {
    const id = randomUUID();
    await saveEmployee(
      sql,
      id,
      employeeInput.parse({
        personnel_no: '4100',
        first_name: 'Ion',
        last_name: 'Wieder',
        employment_type: 'minijob',
        entry_date: '2024-01-01',
        weekly_hours: '10',
        tags: 'Teilzeit,Glas',
        languages: 'Arabisch,Rumänisch,Deutsch',
        pay_model: 'individuell',
        hourly_wage: '15,00',
        work_permit_until: '2027-03-31',
      }),
      'test',
    );
    let d = (await getEmployee(sql, id))!;
    expect(d.employee.tags).toEqual(['Minijob', 'Glas']);
    expect((d.employee as unknown as { app_language: string }).app_language).toBe('ro');
    expect(d.priv!.work_permit_until).toBe('2027-03-31');
    await exitEmployee(sql, id, { date: '2025-06-30', reason: 'Kündigung durch Arbeitnehmer' });
    d = (await getEmployee(sql, id))!;
    expect(d.employee.status).toBe('ausgetreten');
    await expect(reenterEmployee(sql, id, { date: '2025-06-01', actor: 't' })).rejects.toThrow(
      /nach dem letzten Austritt/,
    );
    await reenterEmployee(sql, id, { date: '2026-02-01', actor: 't' });
    d = (await getEmployee(sql, id))!;
    expect([d.employee.status, d.employee.entry_date, d.employee.exit_date]).toEqual([
      'aktiv',
      '2026-02-01',
      null,
    ]);
    expect(await employmentHistory(sql, id)).toEqual([
      { entry_date: '2024-01-01', exit_date: '2025-06-30', exit_reason: 'Kündigung durch Arbeitnehmer' },
      { entry_date: '2026-02-01', exit_date: null, exit_reason: null },
    ]);
  });
});
