-- Fotos mit Stempel (Ahmed 18.10.): QM-App und Verwaltung → Foto. Gespeichert wird das gestempelte Bild (sichtbar
-- in der Kontrolle bzw. unter Objekt → Dokumente / Dokumenteneingang); das Original ohne Stempel bleibt write-once
-- als eigene Datei ohne Verknüpfung (nur Nachweis). Je Foto: Objekt (optional), Serverzeit, Standort-Bewertung.
create table app.photo_stamps (
  file_id uuid primary key references app.files (id),
  original_file_id uuid not null references app.files (id),
  site_id uuid references app.sites (id),
  source text not null check (source in ('qm', 'foto')),
  taken_at timestamptz not null default now(),
  geo text check (geo in ('am_objekt', 'entfernt', 'ungenau', 'kein_standort', 'objekt_ohne_standort')),
  geo_m integer,
  geo_acc_m integer,
  lat numeric(8, 5) check (lat between -90 and 90),
  lng numeric(8, 5) check (lng between -180 and 180),
  note text,
  created_by text not null
);
create index on app.photo_stamps (site_id, taken_at desc);
create index on app.photo_stamps (created_by, taken_at desc);

alter table app.photo_stamps enable row level security;
create policy photo_stamps_read on app.photo_stamps for select to authenticated
  using ((select app.is_office()) or site_id in (select s.id from app.sites s where s.manager_user_id = (select auth.uid())));
grant select on app.photo_stamps to authenticated;
grant all on app.photo_stamps to service_role;

create or replace function app.photo_stamps_immutable() returns trigger language plpgsql as $$
begin
  -- nur das Objekt darf wechseln (Objekte zusammenführen)
  if tg_op = 'UPDATE' and (to_jsonb(new) - 'site_id') = (to_jsonb(old) - 'site_id') then
    return new;
  end if;
  raise exception 'Foto-Stempel sind unveränderbar';
end $$;
create trigger photo_stamps_immutable before update or delete on app.photo_stamps
  for each row execute function app.photo_stamps_immutable();
