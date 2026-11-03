-- Stundennachweis für den Kunden je Objekt (Ahmed 03.11.): Stunden je Tag mit „Person 1, Person 2 …“ – aus den
-- erfassten Zeiten oder der Einsatzplanung übernommen oder von Hand ergänzt (z. B. Nachunternehmer). Gibt es für ein
-- Objekt im Leistungszeitraum Zeilen, nimmt der Stundennachweis zur Rechnung diese statt der erfassten Zeiten.
create table app.site_timesheet_rows (
  id uuid primary key,
  site_id uuid not null references app.sites (id) on delete cascade,
  work_date date not null,
  person text not null check (length(trim(person)) between 1 and 120),
  employee_id uuid references app.employees (id) on delete set null,
  start_time time not null,
  end_time time not null,
  break_minutes int not null default 0 check (break_minutes between 0 and 720),
  source text not null default 'manuell' check (source in ('manuell', 'ist', 'plan')),
  created_by text not null,
  created_at timestamptz not null default now(),
  check (end_time > start_time)
);
create index on app.site_timesheet_rows (site_id, work_date);

alter table app.site_timesheet_rows enable row level security;
create policy site_timesheet_rows_office on app.site_timesheet_rows for select to authenticated
  using ((select app.is_office()));
