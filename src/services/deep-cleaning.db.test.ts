import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { calc, getPlan, listPlans, savePlan } from './deep-cleaning.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();
const base = {
  mode: 'belaege' as const,
  flat_price_cents: null,
  floors: [
    { belag: 'Linoleum', sqm_x100: 12000, price_cents: 250 },
    { belag: 'Fliesen', sqm_x100: 3350, price_cents: 333 },
  ],
  db_bp: 2500,
  material_bp: 1000,
  devices_bp: 500,
  material_from: 'uns' as const,
  devices_from: 'sub' as const,
  sub_price_cents: null,
};

describe('Kalkulation Grundreinigung', () => {
  it('rechnet cent-genau wie die alte App', () => {
    const k = calc(base);
    expect(k.vk).toBe(30000n + 11156n); // 120 m² × 2,50 + 33,5 m² × 3,33 = 111,555 → 111,56
    expect(k.db).toBe(10289n); // 25 % von 411,56 = 102,89
    expect(k.mat).toBe(4116n);
    expect(k.proposal).toBe(41156n - 10289n - 4116n); // Geräte vom Sub → nicht abgezogen
    expect(k.effDb).toBe(10289n);
    expect(calc({ ...base, sub_price_cents: 25000n }).effDb).toBe(41156n - 25000n - 4116n);
    expect(calc({ ...base, mode: 'pauschal', flat_price_cents: 800000n }).hours100).toBe(20000n); // 8000 € / 40 € = 200 h
  });
});

describe.skipIf(!available)('Planung Grundreinigung', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('speichert, Sub gewählt → Übergeben, Pflichtfelder', async () => {
    const [sup] = await sql<{ id: string }[]>`
      insert into app.suppliers (id, supplier_no, name, kind) values (${randomUUID()}, 'NU-T1', 'Sub GmbH', 'nachunternehmer') returning id`;
    const id = randomUUID();
    const inp = {
      ...base,
      customer: 'Stadt',
      object: 'Schule\nMusterstr. 1',
      site_id: null,
      date_from: '2027-08-02',
      date_to: '2027-08-06',
      execution: 'sub' as const,
      supplier_id: sup!.id,
      flat_sqm_x100: null,
      max_hours: null,
      status: 'Geplant',
      note: 'Schlüssel beim Hausmeister',
      expectedVersion: null,
    };
    await expect(savePlan(sql, id, { ...inp, floors: [] }, 't')).rejects.toThrow(/Belag/);
    await expect(savePlan(sql, id, { ...inp, date_to: '2027-08-01' }, 't')).rejects.toThrow(/Bis/);
    await savePlan(sql, id, inp, 't');
    const p = await getPlan(sql, id);
    expect(p).toMatchObject({ year: 2027, status: 'Übergeben', supplier_name: 'Sub GmbH' });
    expect((await listPlans(sql, 2027)).map((x) => x.id)).toEqual([id]);
  });
});
