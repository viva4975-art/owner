-- Objektordner je Objekt (Runde 23): Ahmeds Vorlagenpaket (ZIP, einmal unter Einstellungen hochgeladen) wird je
-- Objekt mit den Objektdaten ausgefüllt; fehlende Angaben fragt die App ab (sites.folder_info).
create table app.site_folder_package (
  id integer primary key default 1 check (id = 1),
  storage_path text not null,           -- Archiv (write-once), objektordner/<sha256>.zip
  sha256 text not null,
  file_name text not null,
  uploaded_by text not null,
  uploaded_at timestamptz not null default now()
);
alter table app.site_folder_package enable row level security;
create policy site_folder_package_read on app.site_folder_package for select to authenticated using (true);
grant select on app.site_folder_package to authenticated;
grant all on app.site_folder_package to service_role;

alter table app.sites add column folder_info jsonb not null default '{}'::jsonb;
