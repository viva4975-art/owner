-- Qualitätskontrolle: Auswertungsbericht wie Neumann & Neumann (Ahmed 11.10.) und Löschen.

-- Kontrollgegenstand: Tätigkeit/Beschreibung und Leistungsbereich (Obenarbeiten, Sanitär …) für die Auswertung
alter table app.qm_items add column description text;
alter table app.qm_items add column area_group text;

update app.qm_items set area_group = v.g, description = coalesce(description, v.d)
  from (values
    ('00000000-0000-4000-8000-0000000f0001'::uuid, 'Allgemein', 'Gesamteindruck des Raums'),
    ('00000000-0000-4000-8000-0000000f0002'::uuid, 'Bodenreinigung', 'Boden frei von Staub, Flecken und Schlieren; Ecken und Kanten'),
    ('00000000-0000-4000-8000-0000000f0003'::uuid, 'Obenarbeiten', 'Türblätter, Zargen und Griffe frei von Staub und Griffspuren'),
    ('00000000-0000-4000-8000-0000000f0004'::uuid, 'Obenarbeiten', 'Fensterbänke frei von Staub und Flecken'),
    ('00000000-0000-4000-8000-0000000f0005'::uuid, 'Obenarbeiten', 'Freie Flächen von Tischen und Arbeitsflächen feucht gereinigt'),
    ('00000000-0000-4000-8000-0000000f0006'::uuid, 'Obenarbeiten', 'Heizkörper und Rohre frei von Staub'),
    ('00000000-0000-4000-8000-0000000f0007'::uuid, 'Allgemein', 'Abfallbehälter geleert, Beutel gewechselt'),
    ('00000000-0000-4000-8000-0000000f0008'::uuid, 'Obenarbeiten', 'Wände, Decken und Ecken frei von Spinnweben'),
    ('00000000-0000-4000-8000-0000000f0009'::uuid, 'Sanitär und Nassbereiche', 'Waschbecken und Armaturen frei von Kalk, Seifenresten und Flecken'),
    ('00000000-0000-4000-8000-0000000f000a'::uuid, 'Sanitär und Nassbereiche', 'WC-Becken, Urinale, Sitze und Spülkästen innen und außen gereinigt'),
    ('00000000-0000-4000-8000-0000000f000b'::uuid, 'Sanitär und Nassbereiche', 'Spiegel streifenfrei'),
    ('00000000-0000-4000-8000-0000000f000c'::uuid, 'Sanitär und Nassbereiche', 'Seife, Papierhandtücher und Toilettenpapier aufgefüllt'),
    ('00000000-0000-4000-8000-0000000f000d'::uuid, 'Obenarbeiten', 'Glasflächen und Türglas frei von Griffspuren'),
    ('00000000-0000-4000-8000-0000000f000e'::uuid, 'Obenarbeiten', 'Handläufe und Geländer feucht gereinigt'),
    ('00000000-0000-4000-8000-0000000f000f'::uuid, 'Sanitär und Nassbereiche', 'Küchenzeile, Spüle und Armaturen gereinigt')
  ) as v(id, g, d)
 where app.qm_items.id = v.id and app.qm_items.area_group is null;

-- Schwellwerte für Ampel und Zielbereich (Auswertungsbericht, Statistik)
create table app.qm_settings (
  id smallint primary key default 1 check (id = 1),
  threshold_low smallint not null default 80 check (threshold_low between 1 and 99),
  threshold_target smallint not null default 88 check (threshold_target between 1 and 100),
  check (threshold_target > threshold_low)
);
insert into app.qm_settings (id) values (1) on conflict do nothing;
alter table app.qm_settings enable row level security;
create policy qm_settings_read on app.qm_settings for select to authenticated using (true);

-- Löschen: Entwurf wie bisher; abgeschlossene nur über app.purge (Admin, Stand vorher im Protokoll)
create or replace function app.guard_quality_check() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'entwurf' and coalesce(current_setting('app.purge', true), '') <> 'on' then
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

create or replace function app.guard_quality_check_items() returns trigger
language plpgsql as $$
declare st app.qc_status;
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.purge', true), '') = 'on' then
    return old;
  end if;
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

create or replace function app.guard_qc_ratings() returns trigger language plpgsql as $$
declare v_status text;
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.purge', true), '') = 'on' then
    return old;
  end if;
  select status::text into v_status from app.quality_checks where id = coalesce(new.check_id, old.check_id);
  if v_status <> 'entwurf' then
    raise exception 'Abgeschlossene Audits sind unveränderbar' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;

-- Tickets bleiben, verlieren nur den Verweis auf die gelöschte Kontrolle
alter table app.site_tickets drop constraint if exists site_tickets_quality_check_id_fkey;
alter table app.site_tickets add constraint site_tickets_quality_check_id_fkey
  foreign key (quality_check_id) references app.quality_checks (id) on delete set null;
