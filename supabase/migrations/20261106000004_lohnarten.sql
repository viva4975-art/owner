-- Runde 11: Lohnarten je Mitarbeiter und Monat (Normalstunden, Urlaub, Krank, Zuschläge nach RTV Gebäudereinigung).
create table app.payroll_settings (
  id boolean primary key default true check (id),
  night_from time not null default '22:00',
  night_to time not null default '06:00',
  night_bp integer not null default 2500 check (night_bp between 0 and 50000),
  sunday_bp integer not null default 10000 check (sunday_bp between 0 and 50000),
  sunday_regular_bp integer not null default 7500 check (sunday_regular_bp between 0 and 50000),
  holiday_bp integer not null default 15000 check (holiday_bp between 0 and 50000),
  high_holiday_bp integer not null default 20000 check (high_holiday_bp between 0 and 50000),
  -- Lohnart-Nummern im Lohnprogramm (Lexware), frei eintragbar
  wage_type_numbers jsonb not null default '{}',
  version integer not null default 1
);
insert into app.payroll_settings (id) values (true) on conflict do nothing;
create trigger payroll_settings_version before update on app.payroll_settings for each row execute function app.bump_version();
alter table app.payroll_settings enable row level security;
create policy payroll_settings_read on app.payroll_settings for select to authenticated using ((select app.is_hr()));
grant select on app.payroll_settings to authenticated;
grant all on app.payroll_settings to service_role;

-- RTV § 10 g: Sonn-/Feiertagsarbeit, die aufgrund des Einsatzes fortlaufend am selben Arbeitsplatz anfällt → 75 %
alter table app.employees add column regular_sunday_work boolean not null default false;
