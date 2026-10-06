import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { dbAvailable, freshDatabase } from './testing.js';
import {
  getVehicle,
  listHandoverObjects,
  saveHandoverObject,
  saveVehicle,
  vehicleDeadlines,
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

  it('Gegenstände für Übergaben: Startliste, neu, keine Dubletten', async () => {
    expect((await listHandoverObjects(sql)).map((o) => o.name)).toContain('Tankkarte');
    await saveHandoverObject(sql, randomUUID(), { name: 'Funkgerät', active: true });
    await expect(saveHandoverObject(sql, randomUUID(), { name: 'funkgerät', active: true })).rejects.toThrow(
      /gibt es schon/,
    );
  });
});
