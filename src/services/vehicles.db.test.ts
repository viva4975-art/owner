import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { dbAvailable, freshDatabase } from './testing.js';
import {
  getVehicle,
  listHandoverObjects,
  saveHandoverObject,
  saveVehicle,
  autoEstimate,
  remindFrom,
  vehicleDeadlines,
  type Vehicle,
  type VehicleInput,
} from './vehicles.js';

const available = await dbAvailable();

const base = (p: Partial<VehicleInput> = {}): VehicleInput => ({
  plate: 'm-vd 123',
  make: 'VW',
  model: 'Caddy',
  vin: null,
  first_registration: '2021-03-15',
  fuel: 'diesel',
  ownership: 'eigentum',
  leasing_company: 'soll weg',
  leasing_until: null,
  insurer: null,
  insurance_no: null,
  hu_due: null,
  service_due: null,
  mileage: '45.300',
  mileage_date: '2026-10-01',
  driver_employee_id: null,
  fuel_card: null,
  note: null,
  active: true,
  expectedVersion: null,
  ...p,
});

describe.skipIf(!available)('Fahrzeuge und Übergabe-Gegenstände (Datenbank)', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Fahrzeug anlegen: Kennzeichen groß, km ohne Punkte, kein Leasinggeber bei Eigentum, FIN geprüft, Dubletten', async () => {
    const id = randomUUID();
    await expect(saveVehicle(sql, id, base({ vin: 'WVWZZZ1KZ6W00001O' }))).rejects.toThrow(/17 Zeichen/);
    await expect(saveVehicle(sql, id, base({ first_registration: '2099-01-01' }))).rejects.toThrow(/Zukunft/);
    await saveVehicle(sql, id, base({ vin: 'wvwzzz1kz6w000011' }));
    const v = (await getVehicle(sql, id))!;
    expect([v.plate, v.vin, v.mileage, v.leasing_company]).toEqual([
      'M-VD 123',
      'WVWZZZ1KZ6W000011',
      45300,
      null,
    ]);
    await expect(saveVehicle(sql, randomUUID(), base({ plate: 'M-VD123' }))).rejects.toThrow(/schon erfasst/);
    await expect(saveVehicle(sql, id, base({ expectedVersion: 99 }))).rejects.toThrow(/zwischenzeitlich/);
    await saveVehicle(sql, id, base({ hu_due: '2026-10-31', service_due: '2026-09-01', expectedVersion: 1 }));
    const d = vehicleDeadlines((await getVehicle(sql, id))!, '2026-10-06');
    expect(d.map((x) => [x.label, x.overdue])).toEqual([
      ['HU (TÜV)', false],
      ['Inspektion', true],
    ]);
  });

  it('Kaufpreis und Verkauf: Cent-genau, verkauft = inaktiv, Prüfungen', async () => {
    const id = randomUUID();
    await expect(saveVehicle(sql, id, base({ plate: 'M-VK 1', purchase_price: 'abc' }))).rejects.toThrow(
      /Kaufpreis/,
    );
    await saveVehicle(
      sql,
      id,
      base({ plate: 'M-VK 1', purchase_date: '2022-05-02', purchase_price: '18.500,50' }),
    );
    let v = (await getVehicle(sql, id))!;
    expect([v.purchase_price_cents, v.active, v.sold_on]).toEqual([1850050n, true, null]);
    await expect(
      saveVehicle(sql, id, base({ plate: 'M-VK 1', sold_on: '2022-01-01', purchase_date: '2022-05-02' })),
    ).rejects.toThrow(/vor dem Kaufdatum/);
    await saveVehicle(
      sql,
      id,
      base({
        plate: 'M-VK 1',
        purchase_price: '18500,50',
        sold_on: '2026-10-01',
        sale_price: '6.000',
        buyer: 'Autohaus X',
      }),
    );
    v = (await getVehicle(sql, id))!;
    expect([v.active, v.sold_on, v.sale_price_cents, v.buyer]).toEqual([
      false,
      '2026-10-01',
      600000n,
      'Autohaus X',
    ]);
    // gleiches Kennzeichen darf wieder neu erfasst werden
    await saveVehicle(sql, randomUUID(), base({ plate: 'M-VK 1' }));
  });

  it('automatische Wertschätzung', () => {
    const v = {
      ownership: 'eigentum',
      purchase_price_cents: 3000000n,
      purchase_date: '2024-10-22',
      first_registration: '2024-10-22',
      mileage: 40000,
      sold_on: null,
    };
    // 2 Jahre, 40.000 km wie erwartet: 30.000 × 0,76 × 0,88 = 20.064 → 20.100 €
    expect(autoEstimate(v, '2026-10-22')).toBe(2010000n);
    // viel gefahren (80.000 km) → −8 %
    expect(autoEstimate({ ...v, mileage: 80000 }, '2026-10-22')).toBe(1850000n);
    // gebraucht gekauft: Kaufpreis gilt am Kaufdatum
    expect(autoEstimate({ ...v, first_registration: '2020-10-22', mileage: null }, '2024-10-22')).toBe(
      3000000n,
    );
    expect(autoEstimate({ ...v, ownership: 'leasing' }, '2026-10-22')).toBeNull();
    expect(autoEstimate({ ...v, purchase_price_cents: null }, '2026-10-22')).toBeNull();
  });

  it('HU-Erinnerung einen Monat vor dem HU-Monat', () => {
    expect(remindFrom('hu', '2026-11-30')).toBe('2026-10-01');
    expect(remindFrom('hu', '2027-01-31')).toBe('2026-12-01');
    const v = { hu_due: '2026-11-30', service_due: null, leasing_until: null } as Vehicle;
    expect(vehicleDeadlines(v, '2026-09-30')).toEqual([]);
    expect(vehicleDeadlines(v, '2026-10-01')).toEqual([
      { label: 'HU (TÜV)', date: '2026-11-30', overdue: false },
    ]);
    expect(vehicleDeadlines(v, '2026-12-01')[0]!.overdue).toBe(true);
  });

  it('Gegenstände für Übergaben: Startliste, neu, keine Dubletten', async () => {
    expect((await listHandoverObjects(sql)).map((o) => o.name)).toContain('Tankkarte');
    await saveHandoverObject(sql, randomUUID(), { name: 'Funkgerät', active: true });
    await expect(saveHandoverObject(sql, randomUUID(), { name: 'funkgerät', active: true })).rejects.toThrow(
      /gibt es schon/,
    );
  });
});
