-- Ahmed 08.10.: Urlaubskonten und Krankheitstage aus Fortytools (Excel) übernehmen. Gespeichert wird der Stand zum
-- Stichtag je Mitarbeiter und Jahr; die App rechnet ab dem Folgetag mit den eigenen Abwesenheiten weiter
-- (Abwesenheiten bis zum Stichtag stecken schon in den Fortytools-Zahlen → nicht doppelt zählen).
create table app.leave_openings (
  employee_id uuid not null references app.employees (id),
  year integer not null check (year between 2000 and 2100),
  as_of date not null,
  carried_days numeric(5, 1),     -- Resturlaub Vorjahr
  entitlement_days numeric(5, 1), -- Anspruch aktuelles Jahr
  taken_days numeric(5, 1),       -- genommen bis Stichtag
  available_days numeric(5, 1),   -- verfügbar laut Fortytools (Resturlaub ggf. verfallen)
  sick_as_of date,
  sick_days numeric(5, 1),        -- Krankheitstage bis Stichtag
  source text not null,
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key (employee_id, year),
  check (extract(year from as_of) = year),
  check (sick_as_of is null or extract(year from sick_as_of) = year)
);
alter table app.leave_openings enable row level security;
create policy leave_openings_read on app.leave_openings for select to authenticated
  using ((select app.is_hr()) or (select app.is_office()));
