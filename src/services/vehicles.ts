import type { Sql } from '../db/client.js';
import { addDays, todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
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
  purchase_date: string | null;
  purchase_price_cents: bigint | null;
  sold_on: string | null;
  sale_price_cents: bigint | null;
  buyer: string | null;
  estimated_value_cents: bigint | null;
  estimated_on: string | null;
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
           v.fuel_card, v.note, v.purchase_date::text, v.purchase_price_cents, v.sold_on::text, v.sale_price_cents,
           v.buyer, v.estimated_value_cents, v.estimated_on::text, v.active, v.version,
           (select count(*)::int from app.file_links l where l.entity_type = 'vehicle' and l.entity_id = v.id) as files
      from app.vehicles v left join app.employees e on e.id = v.driver_employee_id
     where ${all ? sql`true` : sql`v.active`}
     order by v.active desc, v.plate`;
}

export async function getVehicle(sql: Sql, id: string) {
  return (await listVehicles(sql, true)).find((v) => v.id === id) ?? null;
}

/**
 * Automatische Wertschätzung (Faustregel, kein Gutachten/DAT-Wert): Restwert-Kurve ab Erstzulassung
 * (1. Jahr −24 %, danach −12 % je Jahr, mindestens 10 %), bezogen auf den Kaufpreis zum Kaufdatum (gebraucht gekauft
 * = Preis enthält das Alter schon), dazu ±1 % je 5.000 km Abweichung von 20.000 km/Jahr (höchstens ±15 %).
 * Nur Eigentum mit Kaufpreis. Gerundet auf 100 €.
 */
export function autoEstimate(
  v: Pick<
    Vehicle,
    'ownership' | 'purchase_price_cents' | 'purchase_date' | 'first_registration' | 'mileage' | 'sold_on'
  >,
  today = todayBerlin(),
): bigint | null {
  if (
    v.sold_on ||
    v.ownership !== 'eigentum' ||
    v.purchase_price_cents == null ||
    v.purchase_price_cents <= 0n
  )
    return null;
  const reg = v.first_registration ?? v.purchase_date;
  const bought = v.purchase_date ?? v.first_registration;
  if (!reg || !bought) return null;
  const years = (a: string, b: string) => Math.max(0, (Date.parse(b) - Date.parse(a)) / (365.25 * 86400000));
  const curve = (y: number) => Math.max(0.1, y <= 1 ? 1 - 0.24 * y : 0.76 * Math.pow(0.88, y - 1));
  const ageNow = years(reg, today);
  let factor = curve(ageNow) / curve(years(reg, bought));
  if (v.mileage != null && ageNow > 0.25) {
    const diff = v.mileage - ageNow * 20000;
    factor *= 1 - Math.max(-0.15, Math.min(0.15, (diff / 5000) * 0.01));
  }
  factor = Math.min(1, factor);
  const cents = Math.round((Number(v.purchase_price_cents) * factor) / 10000) * 10000;
  return BigInt(cents);
}

/** Wert für Summen: eigene Schätzung geht vor, sonst automatische. */
export function vehicleValue(v: Vehicle, today = todayBerlin()) {
  if (v.estimated_value_cents != null) return { cents: v.estimated_value_cents, auto: false };
  const a = autoEstimate(v, today);
  return a == null ? null : { cents: a, auto: true };
}

/** Aktive Fahrzeuge ohne hochgeladenen Fahrzeugschein (Hinweis Startseite/Erinnerungen). */
export async function vehiclesWithoutRegistration(sql: Sql) {
  return sql<{ id: string; plate: string }[]>`
    select v.id, v.plate from app.vehicles v
     where v.active and not exists (
       select 1 from app.file_links l
        where l.entity_type = 'vehicle' and l.entity_id = v.id and l.category = 'Fahrzeugschein')
     order by v.plate`;
}

/**
 * Ab wann an eine Frist erinnert wird. HU (TÜV) ist bis Ende des Plakettenmonats fällig (gespeichert als letzter Tag)
 * → Erinnerung einen Monat vor Beginn dieses Monats (HU 11/2026 → ab 01.10.2026). Sonst 30 Tage vorher.
 */
export function remindFrom(kind: 'hu' | 'other', date: string) {
  if (kind === 'hu') {
    const [y, m] = date.split('-').map(Number) as [number, number];
    const pm = m === 1 ? 12 : m - 1;
    return `${m === 1 ? y - 1 : y}-${String(pm).padStart(2, '0')}-01`;
  }
  return addDays(date, -30);
}

/** Fristen: überfällig oder bald fällig (HU ab einen Monat vor dem HU-Monat, Inspektion/Leasingende 30 Tage). */
export function vehicleDeadlines(v: Vehicle, today = todayBerlin()) {
  const out: { label: string; date: string; overdue: boolean }[] = [];
  for (const [label, date, kind] of [
    ['HU (TÜV)', v.hu_due, 'hu'],
    ['Inspektion', v.service_due, 'other'],
    ['Leasingende', v.leasing_until, 'other'],
  ] as const)
    if (date && today >= remindFrom(kind, date)) out.push({ label, date, overdue: date < today });
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
  purchase_date?: string | null;
  /** Kaufpreis als Text („18.500,00“) */
  purchase_price?: string | null;
  sold_on?: string | null;
  sale_price?: string | null;
  buyer?: string | null;
  /** geschätzter heutiger Wert als Text */
  estimated_value?: string | null;
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
    ['Kaufdatum', p.purchase_date ?? null],
    ['Verkaufsdatum', p.sold_on ?? null],
  ] as const)
    if (d && !DATE.test(d)) throw new BusinessError(`${label}: Datum ungültig`);
  if (p.first_registration && p.first_registration > todayBerlin())
    throw new BusinessError('Erstzulassung liegt in der Zukunft');
  if (p.fuel && !(p.fuel in FUEL)) throw new BusinessError('Kraftstoff ungültig');
  if (!(p.ownership in OWNERSHIP)) throw new BusinessError('Eigentum/Leasing ungültig');
  const money = (label: string, v: string | null | undefined) => {
    if (!v?.trim()) return null;
    let c: bigint;
    try {
      let t = v.replace(/[€\s]/g, '');
      if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, ''); // „7.500“ = 7500 €
      c = parseEuro(t);
    } catch {
      throw new BusinessError(`${label}: Betrag ungültig`);
    }
    if (c < 0n) throw new BusinessError(`${label} darf nicht negativ sein`);
    return c;
  };
  const purchasePrice = money('Kaufpreis', p.purchase_price);
  const estimated = money('Geschätzter Wert', p.estimated_value);
  const [prevEst] = await sql<{ e: bigint | null; est_on: string | null }[]>`
    select estimated_value_cents as e, estimated_on::text as est_on from app.vehicles where id = ${id}`;
  // Datum der Schätzung: bleibt, solange der Wert gleich bleibt
  const estimatedOn =
    estimated == null ? null : prevEst && prevEst.e === estimated ? prevEst.est_on : todayBerlin();
  const soldOn = p.sold_on || null;
  const salePrice = soldOn ? money('Verkaufspreis', p.sale_price) : null;
  if (!soldOn && p.sale_price?.trim()) throw new BusinessError('Bitte das Verkaufsdatum angeben');
  if (soldOn && soldOn > todayBerlin()) throw new BusinessError('Verkaufsdatum liegt in der Zukunft');
  if (soldOn && p.purchase_date && soldOn < p.purchase_date)
    throw new BusinessError('Verkaufsdatum liegt vor dem Kaufdatum');
  // verkauft = nicht mehr im Bestand
  const active = soldOn ? false : p.active;
  const km = p.mileage?.replace(/[.\s]/g, '') || null;
  if (km && !/^\d{1,7}$/.test(km)) throw new BusinessError('Kilometerstand bitte als ganze Zahl');
  const [cur] = await sql<{ version: number }[]>`select version from app.vehicles where id = ${id}`;
  if (cur && p.expectedVersion != null && cur.version !== p.expectedVersion)
    throw new BusinessError('Das Fahrzeug wurde zwischenzeitlich geändert – bitte neu laden');
  const [dup] = await sql`
    select 1 from app.vehicles where active and upper(replace(plate, ' ', '')) = ${plate.replace(/ /g, '')}
       and id <> ${id}`;
  if (dup && active) throw new BusinessError(`Kennzeichen ${plate} ist schon erfasst`);
  const leasing = p.ownership === 'eigentum' ? null : p.leasing_company;
  const leasingUntil = p.ownership === 'eigentum' ? null : p.leasing_until;
  await sql`
    insert into app.vehicles (id, plate, make, model, vin, first_registration, fuel, ownership, leasing_company,
                              leasing_until, insurer, insurance_no, hu_due, service_due, mileage, mileage_date,
                              driver_employee_id, fuel_card, note, purchase_date, purchase_price_cents, sold_on,
                              sale_price_cents, buyer, estimated_value_cents, estimated_on, active)
    values (${id}, ${plate}, ${p.make}, ${p.model}, ${vin}, ${p.first_registration}, ${p.fuel}, ${p.ownership},
            ${leasing}, ${leasingUntil}, ${p.insurer}, ${p.insurance_no}, ${p.hu_due}, ${p.service_due},
            ${km ? Number(km) : null}, ${km ? (p.mileage_date ?? todayBerlin()) : null}, ${p.driver_employee_id},
            ${p.fuel_card}, ${p.note}, ${p.purchase_date ?? null}, ${purchasePrice}, ${soldOn}, ${salePrice},
            ${soldOn ? (p.buyer ?? null) : null}, ${soldOn ? null : estimated}, ${soldOn ? null : estimatedOn},
            ${active})
    on conflict (id) do update set plate = excluded.plate, make = excluded.make, model = excluded.model,
      vin = excluded.vin, first_registration = excluded.first_registration, fuel = excluded.fuel,
      ownership = excluded.ownership, leasing_company = excluded.leasing_company,
      leasing_until = excluded.leasing_until, insurer = excluded.insurer, insurance_no = excluded.insurance_no,
      hu_due = excluded.hu_due, service_due = excluded.service_due, mileage = excluded.mileage,
      mileage_date = excluded.mileage_date, driver_employee_id = excluded.driver_employee_id,
      fuel_card = excluded.fuel_card, note = excluded.note, purchase_date = excluded.purchase_date,
      purchase_price_cents = excluded.purchase_price_cents, sold_on = excluded.sold_on,
      sale_price_cents = excluded.sale_price_cents, buyer = excluded.buyer,
      estimated_value_cents = excluded.estimated_value_cents, estimated_on = excluded.estimated_on,
      active = excluded.active`;
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
