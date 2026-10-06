import type { Sql } from '../db/client.js';
import { addDays, todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from './errors.js';

/*
 * Fahrzeugliste (Inventar): Kennzeichen, Marke/Modell, FIN, Erstzulassung, Leasing, Versicherung, HU/Inspektion,
 * Kilometerstand, Fahrer, Tankkarte. Fahrzeugschein und weitere Unterlagen als Dateien am Fahrzeug (write-once).
 */

export const FUEL: Record<string, string> = {
  diesel: 'Diesel',
  benzin: 'Benzin',
  elektro: 'Elektro',
  hybrid: 'Hybrid',
  gas: 'Gas (LPG/CNG)',
};
export const OWNERSHIP: Record<string, string> = { eigentum: 'Eigentum', leasing: 'Leasing', miete: 'Miete' };

export interface Vehicle {
  id: string;
  plate: string;
  make: string | null;
  model: string | null;
  vin: string | null;
  first_registration: string | null;
  fuel: string | null;
  ownership: string;
  leasing_company: string | null;
  leasing_until: string | null;
  insurer: string | null;
  insurance_no: string | null;
  hu_due: string | null;
  service_due: string | null;
  mileage: number | null;
  mileage_date: string | null;
  driver_employee_id: string | null;
  driver_name: string | null;
  fuel_card: string | null;
  note: string | null;
  active: boolean;
  version: number;
  files: number;
}

export async function listVehicles(sql: Sql, all = false) {
  return sql<Vehicle[]>`
    select v.id, v.plate, v.make, v.model, v.vin, v.first_registration::text, v.fuel, v.ownership, v.leasing_company,
           v.leasing_until::text, v.insurer, v.insurance_no, v.hu_due::text, v.service_due::text, v.mileage,
           v.mileage_date::text, v.driver_employee_id,
           case when e.id is null then null else e.first_name || ' ' || e.last_name end as driver_name,
           v.fuel_card, v.note, v.active, v.version,
           (select count(*)::int from app.file_links l where l.entity_type = 'vehicle' and l.entity_id = v.id) as files
      from app.vehicles v left join app.employees e on e.id = v.driver_employee_id
     where ${all ? sql`true` : sql`v.active`}
     order by v.active desc, v.plate`;
}

export async function getVehicle(sql: Sql, id: string) {
  return (await listVehicles(sql, true)).find((v) => v.id === id) ?? null;
}

/** Fristen: überfällig oder in den nächsten 30 Tagen (HU, Inspektion, Leasingende). */
export function vehicleDeadlines(v: Vehicle, today = todayBerlin()) {
  const soon = addDays(today, 30);
  const out: { label: string; date: string; overdue: boolean }[] = [];
  for (const [label, date] of [
    ['HU (TÜV)', v.hu_due],
    ['Inspektion', v.service_due],
    ['Leasingende', v.leasing_until],
  ] as const)
    if (date && date <= soon) out.push({ label, date, overdue: date < today });
  return out;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface VehicleInput {
  plate: string;
  make: string | null;
  model: string | null;
  vin: string | null;
  first_registration: string | null;
  fuel: string | null;
  ownership: string;
  leasing_company: string | null;
  leasing_until: string | null;
  insurer: string | null;
  insurance_no: string | null;
  hu_due: string | null;
  service_due: string | null;
  mileage: string | null;
  mileage_date: string | null;
  driver_employee_id: string | null;
  fuel_card: string | null;
  note: string | null;
  active: boolean;
  expectedVersion: number | null;
}

export async function saveVehicle(sql: Sql, id: string, p: VehicleInput) {
  const plate = p.plate.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!plate) throw new BusinessError('Bitte Kennzeichen angeben');
  if (plate.length < 2 || plate.length > 15) throw new BusinessError('Kennzeichen ungültig');
  const vin = p.vin?.replace(/\s/g, '').toUpperCase() || null;
  if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin))
    throw new BusinessError('Fahrgestellnummer (FIN) muss 17 Zeichen haben (ohne I, O, Q)');
  for (const [label, d] of [
    ['Erstzulassung', p.first_registration],
    ['Leasingende', p.leasing_until],
    ['HU', p.hu_due],
    ['Inspektion', p.service_due],
    ['Datum Kilometerstand', p.mileage_date],
  ] as const)
    if (d && !DATE.test(d)) throw new BusinessError(`${label}: Datum ungültig`);
  if (p.first_registration && p.first_registration > todayBerlin())
    throw new BusinessError('Erstzulassung liegt in der Zukunft');
  if (p.fuel && !(p.fuel in FUEL)) throw new BusinessError('Kraftstoff ungültig');
  if (!(p.ownership in OWNERSHIP)) throw new BusinessError('Eigentum/Leasing ungültig');
  const km = p.mileage?.replace(/[.\s]/g, '') || null;
  if (km && !/^\d{1,7}$/.test(km)) throw new BusinessError('Kilometerstand bitte als ganze Zahl');
  const [cur] = await sql<{ version: number }[]>`select version from app.vehicles where id = ${id}`;
  if (cur && p.expectedVersion != null && cur.version !== p.expectedVersion)
    throw new BusinessError('Das Fahrzeug wurde zwischenzeitlich geändert – bitte neu laden');
  const [dup] = await sql`
    select 1 from app.vehicles where active and upper(replace(plate, ' ', '')) = ${plate.replace(/ /g, '')}
       and id <> ${id}`;
  if (dup && p.active) throw new BusinessError(`Kennzeichen ${plate} ist schon erfasst`);
  const leasing = p.ownership === 'eigentum' ? null : p.leasing_company;
  const leasingUntil = p.ownership === 'eigentum' ? null : p.leasing_until;
  await sql`
    insert into app.vehicles (id, plate, make, model, vin, first_registration, fuel, ownership, leasing_company,
                              leasing_until, insurer, insurance_no, hu_due, service_due, mileage, mileage_date,
                              driver_employee_id, fuel_card, note, active)
    values (${id}, ${plate}, ${p.make}, ${p.model}, ${vin}, ${p.first_registration}, ${p.fuel}, ${p.ownership},
            ${leasing}, ${leasingUntil}, ${p.insurer}, ${p.insurance_no}, ${p.hu_due}, ${p.service_due},
            ${km ? Number(km) : null}, ${km ? (p.mileage_date ?? todayBerlin()) : null}, ${p.driver_employee_id},
            ${p.fuel_card}, ${p.note}, ${p.active})
    on conflict (id) do update set plate = excluded.plate, make = excluded.make, model = excluded.model,
      vin = excluded.vin, first_registration = excluded.first_registration, fuel = excluded.fuel,
      ownership = excluded.ownership, leasing_company = excluded.leasing_company,
      leasing_until = excluded.leasing_until, insurer = excluded.insurer, insurance_no = excluded.insurance_no,
      hu_due = excluded.hu_due, service_due = excluded.service_due, mileage = excluded.mileage,
      mileage_date = excluded.mileage_date, driver_employee_id = excluded.driver_employee_id,
      fuel_card = excluded.fuel_card, note = excluded.note, active = excluded.active`;
}

// ---------------------------------------------------------------- Gegenstände für Übergaben (Auswahlliste)

export async function listHandoverObjects(sql: Sql, all = false) {
  return sql<{ id: string; name: string; active: boolean; sort_order: number }[]>`
    select * from app.handover_objects where ${all ? sql`true` : sql`active`} order by sort_order, name`;
}

export async function saveHandoverObject(sql: Sql, id: string, p: { name: string; active: boolean }) {
  const name = p.name.trim();
  if (!name) throw new BusinessError('Bitte Bezeichnung angeben');
  const [dup] =
    await sql`select 1 from app.handover_objects where lower(name) = lower(${name}) and id <> ${id}`;
  if (dup) throw new BusinessError(`„${name}“ gibt es schon`);
  await sql`
    insert into app.handover_objects (id, name, active, sort_order)
    values (${id}, ${name}, ${p.active}, (select coalesce(max(sort_order), 0) + 10 from app.handover_objects))
    on conflict (id) do update set name = excluded.name, active = excluded.active`;
}
