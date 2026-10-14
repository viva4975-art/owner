-- QK-Fotos (Ahmed 14.10.): nur direkt mit der Kamera aufgenommen, mit Zeitpunkt und Standort-Kennzeichen.
-- Je Foto: Aufnahmezeitpunkt (Server), Bewertung des Standorts gegenüber dem Objekt, Entfernung, Genauigkeit und
-- die Koordinaten des Fotos (wie das Geotag einer Kamera – Nachweis, wo die Kontrolle stattfand). Nur anhängen.
create table app.qm_photo_tags (
  file_id uuid primary key references app.files (id),
  check_id uuid not null references app.quality_checks (id) on delete cascade,
  taken_at timestamptz not null default now(),
  geo text not null check (geo in ('am_objekt', 'entfernt', 'ungenau', 'kein_standort', 'objekt_ohne_standort')),
  geo_m integer,
  geo_acc_m integer,
  lat numeric(8, 5) check (lat between -90 and 90),
  lng numeric(8, 5) check (lng between -180 and 180),
  created_by text not null
);
create index on app.qm_photo_tags (check_id);

alter table app.qm_photo_tags enable row level security;
create policy qm_photo_tags_read on app.qm_photo_tags for select to authenticated
  using ((select app.is_office()) or check_id in (select q.id from app.quality_checks q join app.sites s on s.id = q.site_id
                                                   where s.manager_user_id = (select auth.uid())));
grant select on app.qm_photo_tags to authenticated;
grant all on app.qm_photo_tags to service_role;
