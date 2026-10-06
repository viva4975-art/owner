import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, holidayName, isoWeekday } from '../domain/time/holidays.js';
import {
  applyProposals,
  autoPlan,
  districtOf,
  listAppointments,
  markDone,
  openPlanning,
  saveAppointment,
  saveCustomer,
  saveObject,
  statusOf,
  suggestDays,
} from './glass.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe('Glasreinigung-Regeln', () => {
  it('Bezirk aus PLZ, Status, Arbeitstage', () => {
    expect(districtOf('80213')).toBe('M-Mitte/Altstadt');
    expect(districtOf('81375')).toBe('M-West');
    expect(districtOf('85748')).toBe('PLZ 85 748');
    expect(statusOf({ done: false, first_day: '2026-01-01' }, '2026-01-02')).toBe('ueberfaellig');
    expect(statusOf({ done: true, first_day: '2026-01-01' }, '2026-01-02')).toBe('erledigt');
    expect(suggestDays('2026-10-07', 4)).toEqual([{ date: '2026-10-07', from: '08:00', to: '12:00' }]);
    const block = suggestDays('2026-10-09', 20); // Fr → Mo, Di
    expect(block.map((d) => d.date)).toEqual(['2026-10-09', '2026-10-12', '2026-10-13']);
    expect(block.at(-1)).toMatchObject({ from: '08:00', to: '12:00' });
  });
});

describe.skipIf(!available)('Glasreinigung', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });
  const obj = (over = {}) => ({
    customer_id: null as string | null,
    name: 'Grundschule',
    address: 'Musterstr. 1, 81375 München',
    district: null,
    postal_code: null,
    caretaker_name: null,
    caretaker_phone: null,
    caretaker_email: null,
    contact_name: null,
    contact_phone: null,
    contact_email: null,
    per_year: 2,
    parts: [],
    wish_months: [
      [4, 5],
      [9, 10],
    ],
    plan_year: null,
    holiday_pref: 'waehrend',
    needs_police_cert: true,
    needs_lift: false,
    needs_other: null,
    team: 'team_a' as const,
    hours: '6',
    default_staff: null,
    wishes: null,
    note: null,
    expectedVersion: null,
    ...over,
  });

  it('Termin, Erledigt → Folgetermin genau einmal, offene Planung', async () => {
    const k = randomUUID();
    await saveCustomer(sql, k, { name: 'Stadt', address: null, note: null, contacts: [] });
    const o = randomUUID();
    await expect(saveObject(sql, o, obj())).rejects.toThrow(/Kunden/);
    await saveObject(sql, o, obj({ customer_id: k }));
    const a = randomUUID();
    const d = addDays(todayBerlin(), 3);
    await expect(
      saveAppointment(
        sql,
        a,
        {
          objectId: o,
          part: null,
          days: [{ date: d, from: '12:00', to: '08:00' }],
          hours: null,
          interval: '2x',
          team: 'team_a',
          staff: null,
          note: null,
          confirmed: false,
          confirmNote: null,
          done: false,
          expectedVersion: null,
        },
        't',
      ),
    ).rejects.toThrow(/Uhrzeit/);
    await saveAppointment(
      sql,
      a,
      {
        objectId: o,
        part: null,
        days: [{ date: d, from: '08:00', to: '14:00' }],
        hours: null,
        interval: '2x',
        team: 'team_a',
        staff: null,
        note: null,
        confirmed: false,
        confirmNote: null,
        done: false,
        expectedVersion: null,
      },
      't',
    );
    expect(await markDone(sql, a, 't')).toBe(true);
    expect(await markDone(sql, a, 't')).toBe(false);
    const all = await listAppointments(sql, { objectId: o });
    expect(all.map((x) => x.first_day)).toEqual([d, addDays(d, 182)]);
    expect(all[0]!.hours).toBe('6.00');
    const y = Number(d.slice(0, 4));
    const plan = (await openPlanning(sql, y)).find((p) => p.o.id === o)!;
    expect(plan.units[0]).toMatchObject({ perYear: 2 });
  });

  it('Auto-Plan: Wunschmonate, Ferien, keine Sonn-/Feiertage, max. 8 h je Tag, idempotent übernehmen', async () => {
    const k = randomUUID();
    await saveCustomer(sql, k, { name: 'Kunde Auto', address: null, note: null, contacts: [] });
    const y = Number(todayBerlin().slice(0, 4)) + 1;
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = randomUUID();
      ids.push(id);
      await saveObject(sql, id, obj({ customer_id: k, name: `Schule ${i}`, hours: '5', plan_year: y }));
    }
    const pr = await autoPlan(sql, { year: y, objectIds: ids, saturday: false });
    expect(pr).toHaveLength(8);
    for (const p of pr) {
      const dd = p.days[0]!.date;
      expect([4, 5, 9, 10]).toContain(Number(dd.slice(5, 7)));
      expect(isoWeekday(dd)).toBeLessThan(6);
      expect(holidayName(dd)).toBeUndefined();
    }
    const perDay = new Map<string, number>();
    for (const p of pr) for (const d of p.days) perDay.set(d.date, (perDay.get(d.date) ?? 0) + p.hours);
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(8);
    expect(await applyProposals(sql, pr, 't')).toBe(8);
    expect(await applyProposals(sql, pr, 't')).toBe(0);
    expect((await openPlanning(sql, y)).filter((p) => ids.includes(p.o.id)).every((p) => p.open === 0)).toBe(
      true,
    );
  });
});
