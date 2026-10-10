-- Firmenweite Angaben für alle Objektordner (Ahmed 10.10.: „alles bereits ausgefüllt“): Betriebsarzt,
-- Hautschutzprodukte, Reinigungsmittel mit Dosierung. Je Objekt kommen die Notfallangaben in sites.folder_info.
create table app.site_folder_defaults (
  id integer primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb,
  updated_by text not null,
  updated_at timestamptz not null default now()
);
alter table app.site_folder_defaults enable row level security;
create policy site_folder_defaults_read on app.site_folder_defaults for select to authenticated using (true);
grant select on app.site_folder_defaults to authenticated;
grant all on app.site_folder_defaults to service_role;
