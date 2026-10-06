-- Ahmed 06.10.2026: Nachtzuschlag 30 %, regelmäßige Sonn-/Feiertagsarbeit 80 %.
alter table app.payroll_settings alter column night_bp set default 3000, alter column sunday_regular_bp set default 8000;
update app.payroll_settings set night_bp = 3000 where night_bp = 2500;
update app.payroll_settings set sunday_regular_bp = 8000 where sunday_regular_bp = 7500;

-- Qualitätsmanagement wie Fortytools: Kontrollgegenstände (Türen, Boden, Abfallbehälter …) je Nutzungsart (= Raumart).
create table app.qm_items (
  id uuid primary key,
  name text not null unique check (length(trim(name)) > 0),
  kind text not null default 'note' check (kind in ('note', 'janein')),  -- Schulnote 1–6 oder Ja/Nein
  active boolean not null default true,
  sort_order integer not null default 0,
  version integer not null default 1
);
create trigger qm_items_version before update on app.qm_items for each row execute function app.bump_version();

create table app.room_type_qm_items (
  room_type_id uuid not null references app.room_types (id) on delete cascade,
  item_id uuid not null references app.qm_items (id) on delete cascade,
  primary key (room_type_id, item_id)
);

-- Bewertung je Audit (Qualitätskontrolle), Raum und Kontrollgegenstand
create table app.quality_check_ratings (
  id uuid primary key,
  check_id uuid not null references app.quality_checks (id) on delete cascade,
  room_id uuid not null references app.rooms (id),
  item_id uuid not null references app.qm_items (id),
  value smallint check (value between 1 and 6),  -- Schulnote 1 (sehr gut) … 6; Ja = 1, Nein = 6
  skipped boolean not null default false,
  note text,
  photo_ids uuid[] not null default '{}',
  rated_by text not null,
  rated_at timestamptz not null default now(),
  unique (check_id, room_id, item_id),
  check (skipped or value is not null)
);
create index on app.quality_check_ratings (check_id, room_id);

-- abgeschlossene Audits: Bewertungen eingefroren
create or replace function app.guard_qc_ratings() returns trigger language plpgsql as $$
declare v_status text;
begin
  select status::text into v_status from app.quality_checks where id = coalesce(new.check_id, old.check_id);
  if v_status <> 'entwurf' then
    raise exception 'Abgeschlossene Audits sind unveränderbar' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;
create trigger quality_check_ratings_guard before insert or update or delete on app.quality_check_ratings
for each row execute function app.guard_qc_ratings();

alter table app.qm_items enable row level security;
alter table app.room_type_qm_items enable row level security;
alter table app.quality_check_ratings enable row level security;
create policy qm_items_read on app.qm_items for select to authenticated using (true);
create policy room_type_qm_items_read on app.room_type_qm_items for select to authenticated using (true);
create policy quality_check_ratings_read on app.quality_check_ratings for select to authenticated
  using ((select app.is_office()) or check_id in (select q.id from app.quality_checks q join app.sites s on s.id = q.site_id
                                                   where s.manager_user_id = (select auth.uid())));
grant select on app.qm_items, app.room_type_qm_items, app.quality_check_ratings to authenticated;
grant all on app.qm_items, app.room_type_qm_items, app.quality_check_ratings to service_role;

insert into app.qm_items (id, name, kind, sort_order) values
  ('00000000-0000-4000-8000-0000000f0001', 'Gesamteindruck', 'note', 10),
  ('00000000-0000-4000-8000-0000000f0002', 'Boden', 'note', 20),
  ('00000000-0000-4000-8000-0000000f0003', 'Türen', 'note', 30),
  ('00000000-0000-4000-8000-0000000f0004', 'Fensterbänke', 'note', 40),
  ('00000000-0000-4000-8000-0000000f0005', 'Tische / Arbeitsflächen', 'note', 50),
  ('00000000-0000-4000-8000-0000000f0006', 'Heizkörper', 'note', 60),
  ('00000000-0000-4000-8000-0000000f0007', 'Abfallbehälter geleert', 'janein', 70),
  ('00000000-0000-4000-8000-0000000f0008', 'Spinnweben entfernt', 'janein', 80),
  ('00000000-0000-4000-8000-0000000f0009', 'Waschbecken / Armaturen', 'note', 90),
  ('00000000-0000-4000-8000-0000000f000a', 'WC / Urinal', 'note', 100),
  ('00000000-0000-4000-8000-0000000f000b', 'Spiegel', 'note', 110),
  ('00000000-0000-4000-8000-0000000f000c', 'Verbrauchsmaterial aufgefüllt', 'janein', 120),
  ('00000000-0000-4000-8000-0000000f000d', 'Glasflächen / Türglas', 'note', 130),
  ('00000000-0000-4000-8000-0000000f000e', 'Handläufe / Geländer', 'note', 140),
  ('00000000-0000-4000-8000-0000000f000f', 'Küchenzeile / Spüle', 'note', 150)
on conflict do nothing;

-- Vorbelegung: Grundgegenstände für alle Nutzungsarten, dazu passende Zusatzgegenstände
insert into app.room_type_qm_items (room_type_id, item_id)
select t.id, i.id from app.room_types t, app.qm_items i
 where i.id in ('00000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0002',
                '00000000-0000-4000-8000-0000000f0003', '00000000-0000-4000-8000-0000000f0007',
                '00000000-0000-4000-8000-0000000f0008')
on conflict do nothing;
insert into app.room_type_qm_items (room_type_id, item_id)
select t.id, i.id from app.room_types t join app.qm_items i on
  (t.name in ('Büro', 'Besprechung', 'Klassenzimmer') and i.name in ('Fensterbänke', 'Tische / Arbeitsflächen', 'Heizkörper'))
  or (t.name in ('Sanitär / WC', 'Umkleide / Dusche') and i.name in ('Waschbecken / Armaturen', 'WC / Urinal', 'Spiegel', 'Verbrauchsmaterial aufgefüllt'))
  or (t.name in ('Flur / Treppenhaus', 'Eingangsbereich') and i.name in ('Glasflächen / Türglas', 'Handläufe / Geländer', 'Fensterbänke'))
  or (t.name = 'Teeküche / Küche' and i.name in ('Küchenzeile / Spüle', 'Tische / Arbeitsflächen', 'Verbrauchsmaterial aufgefüllt'))
on conflict do nothing;
