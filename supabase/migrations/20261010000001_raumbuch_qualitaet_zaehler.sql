-- Phase 4 Teil 2: Raumbuch mit Leistungswerten (→ Stundenvorgabe), Qualitätskontrollen, Zählerstände.

alter table app.file_links drop constraint file_links_entity_type_check;
alter table app.file_links add constraint file_links_entity_type_check
  check (entity_type in ('offer', 'invoice', 'customer', 'site', 'employee', 'supplier', 'incoming_invoice',
                         'purchase_order', 'order', 'work_report', 'quality_check'));

-- ---------------------------------------------------------------------------
-- Raumbuch
-- ---------------------------------------------------------------------------

-- Raumarten mit Leistungswert (m² je Stunde). Richtwerte – je Betrieb anpassen.
create table app.room_types (
  id uuid primary key,
  name text not null unique check (length(trim(name)) > 0),
  performance_m2_per_h integer not null check (performance_m2_per_h between 1 and 5000),
  sort_order integer not null default 0,
  active boolean not null default true,
  version integer not null default 1
);
create trigger room_types_version before update on app.room_types for each row execute function app.bump_version();

insert into app.room_types (id, name, performance_m2_per_h, sort_order) values
  ('00000000-0000-4000-8000-0000000a0001', 'Büro', 200, 10),
  ('00000000-0000-4000-8000-0000000a0002', 'Besprechung', 220, 20),
  ('00000000-0000-4000-8000-0000000a0003', 'Klassenzimmer', 220, 30),
  ('00000000-0000-4000-8000-0000000a0004', 'Flur / Treppenhaus', 300, 40),
  ('00000000-0000-4000-8000-0000000a0005', 'Eingangsbereich', 250, 50),
  ('00000000-0000-4000-8000-0000000a0006', 'Sanitär / WC', 80, 60),
  ('00000000-0000-4000-8000-0000000a0007', 'Umkleide / Dusche', 100, 70),
  ('00000000-0000-4000-8000-0000000a0008', 'Teeküche / Küche', 120, 80),
  ('00000000-0000-4000-8000-0000000a0009', 'Turnhalle', 600, 90),
  ('00000000-0000-4000-8000-0000000a000a', 'Lager / Technik', 400, 100);

create table app.rooms (
  id uuid primary key,
  site_id uuid not null references app.sites (id),
  room_no text,
  name text not null check (length(trim(name)) > 0),
  floor text,                                       -- Etage / Gebäudeteil
  room_type_id uuid not null references app.room_types (id),
  floor_covering text,                              -- Bodenbelag
  area_centi bigint not null check (area_centi > 0 and area_centi <= 100000000), -- m² × 100
  visits_per_year integer not null check (visits_per_year between 1 and 1000), -- 5×/Woche = 260
  performance_override integer check (performance_override between 1 and 5000), -- m²/h abweichend
  notes text,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  version integer not null default 1
);
create index on app.rooms (site_id);
create trigger rooms_version before update on app.rooms for each row execute function app.bump_version();

-- ---------------------------------------------------------------------------
-- Qualitätskontrolle
-- ---------------------------------------------------------------------------

create type app.qc_status as enum ('entwurf', 'abgeschlossen');
create type app.qc_rating as enum ('ok', 'mangel', 'nicht_geprueft');

create table app.quality_checks (
  id uuid primary key,
  number text not null unique,                      -- QK-JJJJ-NNNN
  site_id uuid not null references app.sites (id),
  check_date date not null,
  inspector text not null,
  attendee text,                                    -- anwesend beim Kunden
  summary text,
  status app.qc_status not null default 'entwurf',
  score_percent integer check (score_percent between 0 and 100),
  checked_count integer,
  defect_count integer,
  signed_by_name text,
  signature_path text,
  signature_sha256 text,
  pdf_path text,
  pdf_sha256 text,
  closed_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  version integer not null default 1,
  check (status = 'entwurf' or (closed_at is not null and checked_count is not null))
);
create index on app.quality_checks (site_id, check_date);
create trigger quality_checks_version before update on app.quality_checks for each row execute function app.bump_version();

create table app.quality_check_items (
  id uuid primary key,
  check_id uuid not null references app.quality_checks (id) on delete cascade,
  position integer not null,
  room_id uuid references app.rooms (id),
  area text not null,                               -- Raum/Bereich (Text eingefroren)
  rating app.qc_rating not null default 'nicht_geprueft',
  defects text[] not null default '{}',             -- Kategorien: Boden, Oberflächen, Sanitär, Abfall, Glas …
  note text,
  task_id uuid references app.tasks (id),
  unique (check_id, position)
);

-- Abgeschlossene Kontrollen sind eingefroren; nur PDF darf einmal nachgetragen werden.
create or replace function app.guard_quality_check() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'entwurf' then
      raise exception 'Abgeschlossene Qualitätskontrollen werden nicht gelöscht' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.status <> 'entwurf' and (
       (new.site_id, new.check_date, new.inspector, new.attendee, new.summary, new.status, new.score_percent,
        new.checked_count, new.defect_count, new.signed_by_name, new.signature_sha256, new.closed_at)
       is distinct from
       (old.site_id, old.check_date, old.inspector, old.attendee, old.summary, old.status, old.score_percent,
        old.checked_count, old.defect_count, old.signed_by_name, old.signature_sha256, old.closed_at)
       or (old.pdf_path is not null and new.pdf_path is distinct from old.pdf_path)) then
    raise exception 'Qualitätskontrolle % ist abgeschlossen und unveränderbar', old.number using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger quality_checks_guard before update or delete on app.quality_checks
for each row execute function app.guard_quality_check();

create or replace function app.guard_quality_check_items() returns trigger
language plpgsql as $$
declare st app.qc_status;
begin
  select status into st from app.quality_checks where id = coalesce(new.check_id, old.check_id);
  -- Ausnahme: Verweis auf die Nachbesserungs-Aufgabe darf beim Abschluss einmal gesetzt werden
  if tg_op = 'UPDATE' and st <> 'entwurf' and old.task_id is null and new.task_id is not null
     and (new.area, new.rating, new.defects, new.note, new.room_id, new.position)
         is not distinct from (old.area, old.rating, old.defects, old.note, old.room_id, old.position) then
    return new;
  end if;
  if st is not null and st <> 'entwurf' then
    raise exception 'Positionen einer abgeschlossenen Qualitätskontrolle sind unveränderbar' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;
create trigger quality_check_items_guard before insert or update or delete on app.quality_check_items
for each row execute function app.guard_quality_check_items();

-- ---------------------------------------------------------------------------
-- Zählerstände
-- ---------------------------------------------------------------------------

create type app.meter_kind as enum ('strom', 'wasser', 'gas', 'waerme', 'sonstiges');

create table app.meters (
  id uuid primary key,
  site_id uuid not null references app.sites (id),
  kind app.meter_kind not null,
  meter_no text not null check (length(trim(meter_no)) > 0),
  location text,
  unit text not null,                               -- kWh, m³, …
  active boolean not null default true,
  created_at timestamptz not null default now(),
  version integer not null default 1,
  unique (site_id, meter_no)
);
create trigger meters_version before update on app.meters for each row execute function app.bump_version();

-- Ablesungen: nur anhängen. Korrektur = neue Ablesung mit Hinweis.
create table app.meter_readings (
  id uuid primary key,                              -- feste ID aus dem Formular → kein Doppel bei Wiederholung
  meter_id uuid not null references app.meters (id),
  read_on date not null,
  value_milli bigint not null check (value_milli >= 0),
  is_replacement boolean not null default false,    -- Zählertausch: Startwert des neuen Zählers
  note text,
  recorded_by text not null,
  recorded_at timestamptz not null default now()
);
create index on app.meter_readings (meter_id, read_on);
create trigger meter_readings_append_only before update or delete on app.meter_readings
for each row execute function app.deny_change();

-- Zählerstand darf (außer bei Tausch) nicht kleiner als der vorige sein.
create or replace function app.check_meter_reading() returns trigger
language plpgsql as $$
declare prev bigint; nxt record;
begin
  perform 1 from app.meters where id = new.meter_id for update;
  -- nachgetragene Ablesung darf nicht über der nächsten (späteren) liegen
  select value_milli, is_replacement into nxt from app.meter_readings
   where meter_id = new.meter_id and read_on > new.read_on order by read_on, recorded_at limit 1;
  if found and not nxt.is_replacement and new.value_milli > nxt.value_milli then
    raise exception 'Zählerstand ist größer als eine spätere Ablesung' using errcode = 'check_violation';
  end if;
  if new.is_replacement then return new; end if;
  select value_milli into prev from app.meter_readings
   where meter_id = new.meter_id and read_on <= new.read_on
   order by read_on desc, recorded_at desc limit 1;
  if prev is not null and new.value_milli < prev then
    raise exception 'Zählerstand ist kleiner als die vorige Ablesung – bei Zählertausch bitte „Zählertausch“ ankreuzen'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger meter_readings_check before insert on app.meter_readings
for each row execute function app.check_meter_reading();

-- ---------------------------------------------------------------------------
-- RLS: Büro alles; Objektleitung Raumbuch, Kontrollen und Zähler der eigenen Objekte
-- ---------------------------------------------------------------------------

alter table app.room_types enable row level security;
create policy room_types_read on app.room_types for select to authenticated using (true);
grant select on app.room_types to authenticated;
grant all on app.room_types to service_role;

do $$
declare t text;
begin
  foreach t in array array['rooms', 'quality_checks', 'meters'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format($p$create policy %I on app.%I for select to authenticated
      using ((select app.is_office()) or site_id in (select id from app.sites where manager_user_id = (select auth.uid())))$p$,
      t || '_read', t);
    execute format('grant select on app.%I to authenticated', t);
    execute format('grant all on app.%I to service_role', t);
  end loop;
end $$;

alter table app.quality_check_items enable row level security;
create policy quality_check_items_read on app.quality_check_items for select to authenticated
  using (check_id in (select id from app.quality_checks));
alter table app.meter_readings enable row level security;
create policy meter_readings_read on app.meter_readings for select to authenticated
  using (meter_id in (select id from app.meters));
grant select on app.quality_check_items, app.meter_readings to authenticated;
grant all on app.quality_check_items, app.meter_readings to service_role;
