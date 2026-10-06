-- Runde 15: Fahrzeugliste (Inventar) und auswählbare Gegenstände für Übergaben.

create table app.vehicles (
  id uuid primary key,
  plate text not null check (length(trim(plate)) between 2 and 15),     -- Kennzeichen, z. B. M-VD 1234
  make text,                                                             -- Marke
  model text,                                                            -- Modell
  vin text check (vin is null or vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),         -- Fahrgestellnummer (FIN, 17 Zeichen, ohne I/O/Q)
  first_registration date,                                               -- Erstzulassung
  fuel text check (fuel in ('diesel', 'benzin', 'elektro', 'hybrid', 'gas')),
  ownership text not null default 'eigentum' check (ownership in ('eigentum', 'leasing', 'miete')),
  leasing_company text,
  leasing_until date,
  insurer text,
  insurance_no text,
  hu_due date,                                                           -- nächste HU (TÜV)
  service_due date,                                                      -- nächste Inspektion
  mileage integer check (mileage is null or mileage >= 0),
  mileage_date date,
  driver_employee_id uuid references app.employees (id),
  fuel_card text,
  note text,
  active boolean not null default true,
  version integer not null default 1,
  created_at timestamptz not null default now()
);
create unique index vehicles_plate_uq on app.vehicles (upper(replace(plate, ' ', ''))) where active;
create trigger vehicles_version before update on app.vehicles for each row execute function app.bump_version();

alter table app.vehicles enable row level security;
create policy vehicles_office on app.vehicles for select to authenticated using ((select app.is_office()));
grant select on app.vehicles to authenticated;
grant all on app.vehicles to service_role;

-- Fahrzeugschein & Co. als Dateien am Fahrzeug
alter table app.file_links drop constraint file_links_entity_type_check;
alter table app.file_links add constraint file_links_entity_type_check
  check (entity_type in ('offer', 'invoice', 'customer', 'site', 'employee', 'supplier', 'incoming_invoice',
                         'purchase_order', 'order', 'work_report', 'quality_check', 'inbox', 'tender', 'note',
                         'legacy_import', 'vehicle'));

-- Auswahlliste „Gegenstand“ für Übergaben (Sonstiges)
create table app.handover_objects (
  id uuid primary key,
  name text not null unique check (length(trim(name)) > 0),
  active boolean not null default true,
  sort_order integer not null default 0
);
alter table app.handover_objects enable row level security;
create policy handover_objects_read on app.handover_objects for select to authenticated using (true);
grant select on app.handover_objects to authenticated;
grant all on app.handover_objects to service_role;
insert into app.handover_objects (id, name, sort_order) values
  ('00000000-0000-4000-8000-0000000e0001', 'Diensthandy', 10),
  ('00000000-0000-4000-8000-0000000e0002', 'Tablet', 20),
  ('00000000-0000-4000-8000-0000000e0003', 'Laptop', 30),
  ('00000000-0000-4000-8000-0000000e0004', 'Tankkarte', 40),
  ('00000000-0000-4000-8000-0000000e0005', 'Fahrzeugschlüssel', 50),
  ('00000000-0000-4000-8000-0000000e0006', 'Zugangskarte / Transponder', 60),
  ('00000000-0000-4000-8000-0000000e0007', 'Dienstausweis', 70),
  ('00000000-0000-4000-8000-0000000e0008', 'Reinigungswagen', 80),
  ('00000000-0000-4000-8000-0000000e0009', 'Werkzeugkoffer', 90),
  ('00000000-0000-4000-8000-0000000e000a', 'Leiter', 100)
on conflict do nothing;
