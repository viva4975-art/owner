-- Stempeln mit Standort (Ahmed 08.10.): Position nur im Moment des Stempelns, gespeichert wird nur die Entfernung zum
-- Objekt und die Genauigkeit – keine Koordinaten der Mitarbeitenden, kein Bewegungsprofil (Datensparsamkeit, DSGVO).
alter table app.sites
  add column if not exists geo_lat numeric(9, 6) check (geo_lat between -90 and 90),
  add column if not exists geo_lng numeric(9, 6) check (geo_lng between -180 and 180),
  add column if not exists geo_radius_m integer not null default 250 check (geo_radius_m between 50 and 5000);
alter table app.time_settings add column if not exists geo_check boolean not null default false;
alter table app.time_entries
  add column if not exists start_geo text check (start_geo in ('am_objekt', 'entfernt', 'ungenau', 'kein_standort', 'objekt_ohne_standort')),
  add column if not exists start_geo_m integer,
  add column if not exists start_geo_acc_m integer,
  add column if not exists end_geo text check (end_geo in ('am_objekt', 'entfernt', 'ungenau', 'kein_standort', 'objekt_ohne_standort')),
  add column if not exists end_geo_m integer,
  add column if not exists end_geo_acc_m integer;
