-- NU-Bestellung „je Tag“ (Ahmed 22.10.): Arbeitstage je Woche wählbar (ISO 1 = Mo … 7 = So, leer = Mo–Fr),
-- Monatsbetrag = Preis × Anzahl der Arbeitstage im Monat ohne Feiertage (Bayern) und ohne Schließzeiten.
alter table app.subcontracts add column work_days smallint[]
  check (work_days is null or (work_days <@ array[1,2,3,4,5,6,7]::smallint[] and cardinality(work_days) > 0));

-- Schließzeiten des Objekts (z. B. Schulferien, Betriebsruhe): an diesen Tagen wird nicht gereinigt
create table app.subcontract_closures (
  id uuid primary key,
  subcontract_id uuid not null references app.subcontracts (id) on delete cascade,
  date_from date not null,
  date_to date not null check (date_to >= date_from),
  note text,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index on app.subcontract_closures (subcontract_id, date_from);

alter table app.subcontract_closures enable row level security;
create policy subcontract_closures_office on app.subcontract_closures for select to authenticated
  using ((select app.is_office()));
