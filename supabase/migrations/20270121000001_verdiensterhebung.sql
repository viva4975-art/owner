-- Verdiensterhebung (Statistisches Bundesamt, monatlich, IDEV/CORE-CSV) – Ahmed 09.11.2026
-- Schlüssel je Mitarbeiter (wie in den Meldungen zur Sozialversicherung) und Betriebsangaben.
alter table app.employees
  add column if not exists deuev_group text check (deuev_group ~ '^[0-9]{3}$'),
  add column if not exists activity_key text check (activity_key ~ '^[0-9]{9}$'),
  add column if not exists nationality_key text check (nationality_key ~ '^[0-9]{3}$');

create table if not exists app.wage_stat_settings (
  id boolean primary key default true check (id),
  report_unit_id text,
  tariff_binding smallint not null default 1 check (tariff_binding between 1 and 4),
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table app.wage_stat_settings enable row level security;
create policy wage_stat_settings_hr on app.wage_stat_settings for all to authenticated
  using ((select app.is_hr())) with check ((select app.is_hr()));
