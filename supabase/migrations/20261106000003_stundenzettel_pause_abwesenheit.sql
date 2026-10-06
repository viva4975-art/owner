-- Runde 10: automatische Pause (von–bis), Abwesenheiten als Stunden auf Einsätze, Stundenzettel mit Unterschrift.

-- 1) Pause mit Lage (§ 4 ArbZG: im Voraus feststehend; Beginn/Ende für den Stundenzettel)
alter table app.time_entries
  add column break_start_at timestamptz,
  add column break_auto boolean not null default false;   -- true = automatisch gesetzt (vom Mitarbeiter nicht geändert)

-- 2) Abwesenheit → Stunden je Tag/Einsatz (Urlaub/Krank bezahlt, unbezahlt = 0 bezahlt)
create table app.absence_hours (
  id uuid primary key,
  absence_id uuid not null references app.absences (id),
  employee_id uuid not null references app.employees (id),
  work_date date not null,
  shift_plan_id uuid references app.shift_plans (id),
  site_id uuid references app.sites (id),
  minutes integer not null check (minutes between 0 and 960),
  paid boolean not null,
  manual boolean not null default false,       -- im Büro von Hand geändert
  version integer not null default 1
);
create unique index absence_hours_uq on app.absence_hours
  (absence_id, work_date, coalesce(shift_plan_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index on app.absence_hours (employee_id, work_date);
create trigger absence_hours_version before update on app.absence_hours for each row execute function app.bump_version();
alter table app.absence_hours enable row level security;
create policy absence_hours_read on app.absence_hours for select to authenticated
  using ((select app.is_office()) or (select app.is_hr()));
grant select on app.absence_hours to authenticated;
grant all on app.absence_hours to service_role;

-- 3) Stundenzettel-Unterschrift je Mitarbeiter und Monat (nur anhängen; neue Unterschrift nach Änderungen möglich)
create table app.timesheet_signatures (
  id uuid primary key,
  employee_id uuid not null references app.employees (id),
  month text not null check (month ~ '^\d{4}-\d{2}$'),
  sheet_hash text not null,                    -- SHA-256 des Stundenzettel-Inhalts zum Zeitpunkt der Unterschrift
  snapshot jsonb not null,                     -- Zeilen + Summen, wie unterschrieben
  signature_path text not null,                -- Unterschrift (PNG) im write-once-Archiv
  signature_sha256 text not null,
  signed_at timestamptz not null default now(),
  ip text,
  user_agent text,
  unique (employee_id, month, sheet_hash)
);
create trigger timesheet_signatures_append_only before update or delete on app.timesheet_signatures
for each row execute function app.deny_change();
alter table app.timesheet_signatures enable row level security;
create policy timesheet_signatures_read on app.timesheet_signatures for select to authenticated
  using ((select app.is_office()) or (select app.is_hr()));
grant select on app.timesheet_signatures to authenticated;
grant all on app.timesheet_signatures to service_role;
