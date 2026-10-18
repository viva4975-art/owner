-- Fotos als Gruppe (Ahmed 18.10.): ein Absenden in Verwaltung → Foto = eine Gruppe mit Ort/Adresse und Schaden/
-- Bemerkung (beides steht auf jedem Foto). Im Dokumenteneingang (bzw. beim Objekt) liegt je Gruppe EIN PDF mit allen
-- Fotos. Löschen = Gruppe ausblenden und PDF-Verknüpfung entfernen (Stand im Protokoll); Dateien bleiben write-once.
create table app.photo_groups (
  id uuid primary key,
  site_id uuid references app.sites (id),
  place text,
  note text,
  photo_count integer not null default 0,
  pdf_file_id uuid references app.files (id),
  created_by text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by text
);
create index on app.photo_groups (created_by, created_at desc);
create index on app.photo_groups (site_id, created_at desc);

alter table app.photo_groups enable row level security;
create policy photo_groups_read on app.photo_groups for select to authenticated
  using ((select app.is_office()) or site_id in (select s.id from app.sites s where s.manager_user_id = (select auth.uid())));
grant select on app.photo_groups to authenticated;
grant all on app.photo_groups to service_role;

alter table app.photo_stamps add column group_id uuid references app.photo_groups (id);
create index on app.photo_stamps (group_id);
