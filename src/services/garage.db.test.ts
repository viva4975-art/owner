import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import {
  applyTgPlan,
  autoPlanTg,
  createWorkReport,
  durationMinutes,
  listTgAppointments,
  nextValidDay,
  noticesPdf,
  saveTgAppointment,
  saveTgObject,
} from './garage.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();
const base = {
  customer: 'Dawonia',
  name: 'TG',
  address: null,
  postal_code: '81375',
  city: 'München',
  sqm: null,
  we_no: '4711',
  spaces_fixed: 40,
  spaces_duplex: 0,
  duration: '4 Std.',
  tob_name: null,
  tob_email: null,
  deputy_email: null,
  tob_mobile: null,
  owner_company: 'Besitz GmbH',
  object_no: null,
  site_id: null as string | null,
  active: true,
  paused: false,
  expectedVersion: null,
};
const opts = {
  customer: null,
  kind: 'Nassreinigung',
  start: '2027-03-01',
  dayStart: '07:00',
  hoursPerDay: 8.5,
  skipHolidays: true,
  blockFrom: null,
  blockTo: null,
  onlyWithout: true,
};

describe('Tiefgarage-Regeln', () => {
  it('Dauer aus Freitext, gültige Tage', () => {
    expect(durationMinutes('4 Std.', 510)).toBe(240);
    expect(durationMinutes('1 Tag', 510)).toBe(510);
    expect(durationMinutes('1/2 Tag', 510)).toBe(255);
    expect(durationMinutes('2 Tage', 510)).toBe(1020);
    expect(durationMinutes('3', 510)).toBe(180);
    expect(durationMinutes('', 510)).toBeNull();
    expect(nextValidDay('2027-03-27', { skipHolidays: true, blockFrom: null, blockTo: null })).toBe(
      '2027-03-30',
    ); // Sa → Di (Ostermontag)
    expect(nextValidDay('2027-03-26', { skipHolidays: true, blockFrom: null, blockTo: null })).toBe(
      '2027-03-30',
    ); // Karfreitag 26.03.
  });
});

describe.skipIf(!available)('Tiefgarage', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Auto-Planer packt nach Dauer, nur neue, übernimmt idempotent', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await saveTgObject(sql, ids[0]!, { ...base, name: 'A', postal_code: '81371', duration: '4 Std.' });
    await saveTgObject(sql, ids[1]!, { ...base, name: 'B', postal_code: '81372', duration: '4 Std.' });
    await saveTgObject(sql, ids[2]!, { ...base, name: 'C', postal_code: '81373', duration: '2 Tage' });
    await saveTgObject(sql, randomUUID(), { ...base, name: 'pausiert', paused: true });
    const plan = await autoPlanTg(sql, opts);
    expect(plan.map((p) => [p.object.name, p.days.map((d) => `${d.date} ${d.from}-${d.to}`)])).toEqual([
      ['A', ['2027-03-01 07:00-11:00']],
      ['B', ['2027-03-01 11:00-15:00']],
      ['C', ['2027-03-02 07:00-15:30', '2027-03-03 07:00-15:30']],
    ]);
    expect(await applyTgPlan(sql, opts, false, 't')).toBe(3);
    expect(await autoPlanTg(sql, opts)).toHaveLength(0); // nur Objekte ohne Termin
  });

  it('Arbeitsschein mit Dawonia-Positionen nur mit verknüpftem Objekt; Aushang-PDF', async () => {
    const id = randomUUID();
    await saveTgObject(sql, id, { ...base, name: 'Dawonia TG', spaces_duplex: 6 });
    const a = randomUUID();
    await saveTgAppointment(
      sql,
      a,
      {
        objectId: id,
        days: [{ date: '2099-05-03', from: '07:00', to: '12:00' }],
        kind: 'Grundreinigung',
        note: null,
        expectedVersion: null,
      },
      't',
    );
    await expect(createWorkReport(sql, a, 't')).rejects.toThrow(/verknüpfen/);
    await saveTgObject(sql, id, { ...base, name: 'Dawonia TG', spaces_duplex: 6, site_id: DEMO.siteSchool });
    const wr = await createWorkReport(sql, a, 't');
    expect(await createWorkReport(sql, a, 't')).toBe(wr);
    const lines = await sql<{ description: string; quantity: bigint }[]>`
      select description, quantity_milli as quantity from app.work_report_lines where work_report_id = ${wr} order by position`;
    expect(lines).toHaveLength(13);
    expect(lines.find((l) => l.description.startsWith('03.01'))!.quantity).toBe(40000n);
    expect(lines.find((l) => l.description.startsWith('05.01'))!.quantity).toBe(6000n);
    expect((await listTgAppointments(sql, id))[0]!.work_report_id).toBe(wr);
    expect((await noticesPdf(sql, [id])).length).toBeGreaterThan(1000);
  });
});
