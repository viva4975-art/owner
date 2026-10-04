-- Planung wie Fortytools: Einsatzgruppen je Mitarbeiter, Ausnahmen je Einsatz und Tag (Ausfall, Vertretung,
-- Umplanung auf andere Uhrzeit/Mitarbeiter) – die wiederkehrende Planung bleibt unverändert.

alter table app.employees add column planning_group text;   -- Einsatzgruppe (Filter in der Planung)
alter table app.employees add column planning_notes text;   -- Planungsnotizen für Disponenten

create type app.shift_exception_kind as enum ('ausfall', 'vertretung', 'umgeplant');

create table app.shift_exceptions (
  id uuid primary key,
  shift_plan_id uuid not null references app.shift_plans (id),
  work_date date not null,
  kind app.shift_exception_kind not null,
  substitute_employee_id uuid references app.employees (id),  -- Vertretung bzw. umgeplant auf
  start_time time,                                            -- abweichende Zeit (umgeplant/Vertretung)
  end_time time,
  note text,
  created_by text not null,
  created_at timestamptz not null default now(),
  version integer not null default 1,
  unique (shift_plan_id, work_date),
  check (kind <> 'vertretung' or substitute_employee_id is not null),
  check ((start_time is null) = (end_time is null)),
  check (start_time is null or end_time > start_time)
);
create index on app.shift_exceptions (work_date);
create index on app.shift_exceptions (substitute_employee_id, work_date);
create trigger shift_exceptions_version before update on app.shift_exceptions
for each row execute function app.bump_version();

alter table app.shift_exceptions enable row level security;
create policy shift_exceptions_read on app.shift_exceptions for select to authenticated
  using ((select app.is_office()) or (select app.is_hr())
         or shift_plan_id in (select p.id from app.shift_plans p join app.sites s on s.id = p.site_id
                               where s.manager_user_id = (select auth.uid())));
grant select on app.shift_exceptions to authenticated;
grant all on app.shift_exceptions to service_role;
