-- Phase 3: Einsatzplanung (Soll), Zeiterfassung (Ist, § 17 MiLoG), Abwesenheiten (Urlaub/Krank).
--
-- § 17 MiLoG (Gebäudereinigung ist in § 2a SchwarzArbG genannt): Beginn, Ende und Dauer der täglichen
-- Arbeitszeit spätestens bis zum Ablauf des 7. auf den Arbeitstag folgenden Kalendertags aufzeichnen und
-- mindestens 2 Jahre aufbewahren. Daher: Zeiteinträge werden nie gelöscht, jede Änderung wird mit altem
-- und neuem Stand protokolliert, der Aufzeichnungszeitpunkt (recorded_at) wird festgehalten.

-- ---------------------------------------------------------------------------
-- Mitarbeiter-Zugang (PIN) und Objekt-QR
-- ---------------------------------------------------------------------------

create table app.employee_pins (
  employee_id uuid primary key references app.employees (id) on delete cascade,
  pin_hash text not null,              -- scrypt, nie im Klartext
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  set_at timestamptz not null default now(),
  set_by text not null
);

alter table app.employees add column annual_leave_days numeric(4, 1) not null default 30
  check (annual_leave_days between 0 and 60);
alter table app.employees add column app_language text not null default 'de';

-- Token im QR-Code am Objekt (zufällig, 128 Bit). Neu erzeugen = alte Aushänge ungültig.
alter table app.sites add column clock_token text unique
  default replace(gen_random_uuid()::text, '-', '');
update app.sites set clock_token = replace(gen_random_uuid()::text, '-', '') where clock_token is null;
alter table app.sites alter column clock_token set not null;

-- ---------------------------------------------------------------------------
-- Einsatzplanung (Soll): wer arbeitet wann wo, wiederkehrend je Wochentag
-- ---------------------------------------------------------------------------

create table app.shift_plans (
  id uuid primary key,
  employee_id uuid not null references app.employees (id),
  site_id uuid not null references app.sites (id),
  weekday smallint not null check (weekday between 1 and 7), -- 1 = Montag (ISO)
  start_time time not null,
  end_time time not null,
  break_minutes integer not null default 0 check (break_minutes between 0 and 180),
  valid_from date not null,
  valid_until date,
  note text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_time > start_time),
  check (valid_until is null or valid_until >= valid_from)
);
create index on app.shift_plans (site_id);
create index on app.shift_plans (employee_id);
create trigger shift_plans_version before update on app.shift_plans for each row execute function app.bump_version();

-- ---------------------------------------------------------------------------
-- Zeiterfassung (Ist)
-- ---------------------------------------------------------------------------

create type app.time_source as enum ('stempel', 'soll_bestaetigt', 'nachtrag', 'buero');
create type app.time_status as enum ('laeuft', 'erfasst', 'beantragt', 'freigegeben', 'abgelehnt');

create table app.time_entries (
  id uuid primary key,                 -- vom Gerät erzeugt → Stempeln mehrfach senden = einmal gebucht
  employee_id uuid not null references app.employees (id),
  site_id uuid not null references app.sites (id),
  work_date date not null,             -- Arbeitstag (Europe/Berlin)
  start_at timestamptz not null,
  end_at timestamptz,
  break_minutes integer not null default 0 check (break_minutes between 0 and 240),
  source app.time_source not null,
  status app.time_status not null,
  via_qr boolean not null default false,
  shift_plan_id uuid references app.shift_plans (id),
  note text,
  recorded_at timestamptz not null default now(),  -- wann aufgezeichnet (7-Tage-Frist)
  created_by text not null,
  decided_by text,
  decided_at timestamptz,
  version integer not null default 1,
  check (end_at is null or end_at > start_at),
  check (end_at is null or end_at - start_at <= interval '16 hours'),
  check ((status = 'laeuft') = (end_at is null))
);
create index on app.time_entries (employee_id, work_date);
create index on app.time_entries (site_id, work_date);
create index on app.time_entries (status) where status in ('laeuft', 'beantragt');
-- je Mitarbeiter höchstens eine laufende Stempelung
create unique index time_entries_one_running on app.time_entries (employee_id) where status = 'laeuft';
create trigger time_entries_version before update on app.time_entries for each row execute function app.bump_version();

-- Änderungsprotokoll: jede Änderung mit altem und neuem Stand, wer und warum (unveränderbar)
create table app.time_entry_log (
  id bigint generated always as identity primary key,
  entry_id uuid not null references app.time_entries (id),
  at timestamptz not null default now(),
  actor text,
  reason text,
  old_row jsonb,
  new_row jsonb not null
);
create index on app.time_entry_log (entry_id);
create trigger time_entry_log_append_only before update or delete on app.time_entry_log
for each row execute function app.deny_change();

create or replace function app.log_time_entry() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Zeiteinträge werden nicht gelöscht (§ 17 MiLoG: 2 Jahre aufbewahren) – bitte ablehnen oder korrigieren'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and old.status in ('erfasst', 'freigegeben')
     and (new.start_at, new.end_at, new.break_minutes, new.site_id, new.work_date)
         is distinct from (old.start_at, old.end_at, old.break_minutes, old.site_id, old.work_date)
     and coalesce(current_setting('app.reason', true), '') = '' then
    raise exception 'Änderung an erfasster Arbeitszeit nur mit Begründung' using errcode = 'check_violation';
  end if;
  insert into app.time_entry_log (entry_id, actor, reason, old_row, new_row)
  values (new.id, nullif(current_setting('app.actor', true), ''), nullif(current_setting('app.reason', true), ''),
          case when tg_op = 'UPDATE' then to_jsonb(old) end, to_jsonb(new));
  return new;
end $$;
create trigger time_entries_log after insert or update on app.time_entries
for each row execute function app.log_time_entry();
create trigger time_entries_no_delete before delete on app.time_entries
for each row execute function app.log_time_entry();

-- ---------------------------------------------------------------------------
-- Abwesenheiten
-- ---------------------------------------------------------------------------

create type app.absence_kind as enum ('urlaub', 'krank', 'kind_krank', 'unbezahlt', 'sonstiges');
create type app.absence_status as enum ('beantragt', 'genehmigt', 'abgelehnt', 'storniert');

create table app.absences (
  id uuid primary key,
  employee_id uuid not null references app.employees (id),
  kind app.absence_kind not null,
  start_date date not null,
  end_date date not null,
  half_day boolean not null default false,
  status app.absence_status not null,
  note text,
  requested_by text not null,
  requested_at timestamptz not null default now(),
  decided_by text,
  decided_at timestamptz,
  version integer not null default 1,
  check (end_date >= start_date),
  check (not half_day or start_date = end_date)
);
create index on app.absences (employee_id, start_date);
create trigger absences_version before update on app.absences for each row execute function app.bump_version();

-- Einstellungen (eine Zeile): Mindestlohn zur Prüfung
create table app.time_settings (
  id boolean primary key default true check (id),
  min_wage_cents bigint not null,
  min_wage_note text
);
insert into app.time_settings (min_wage_cents, min_wage_note)
values (1390, 'Gesetzlicher Mindestlohn 2026. Branchen-Mindestlohn Gebäudereinigung (Lohngruppe 1) liegt darüber – bitte aktuellen Wert eintragen.');

-- ---------------------------------------------------------------------------
-- RLS: Lesen für Büro/Personal; Objektleitung sieht Einsätze und Zeiten ihrer Objekte.
-- Mitarbeiter greifen nur über den Server zu (PIN-Anmeldung), nie direkt auf die Datenbank.
-- ---------------------------------------------------------------------------

alter table app.employee_pins enable row level security; -- keine Policy: nur Server
alter table app.time_settings enable row level security;
create policy time_settings_read on app.time_settings for select to authenticated using ((select app.is_office()));

do $$
declare t text;
begin
  foreach t in array array['shift_plans', 'time_entries'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format($p$create policy %I on app.%I for select to authenticated
      using ((select app.is_office()) or (select app.is_hr())
             or site_id in (select id from app.sites where manager_user_id = (select auth.uid())))$p$, t || '_read', t);
    execute format('grant select on app.%I to authenticated', t);
  end loop;
end $$;
alter table app.time_entry_log enable row level security;
create policy time_entry_log_read on app.time_entry_log for select to authenticated
  using ((select app.is_office()) or (select app.is_hr()));
alter table app.absences enable row level security;
create policy absences_read on app.absences for select to authenticated
  using ((select app.is_office()) or (select app.is_hr()));

grant select on app.time_entry_log, app.absences, app.time_settings to authenticated;
grant all on app.employee_pins, app.shift_plans, app.time_entries, app.time_entry_log, app.absences,
  app.time_settings to service_role;
