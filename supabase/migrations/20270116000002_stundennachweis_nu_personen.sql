-- Stundennachweis (Ahmed 03.11.): Leute vom Nachunternehmer als Dauereintrag – Person, Uhrzeit von–bis (über
-- Mitternacht möglich), Pause, Wochentage, ab Datum, optional bis Datum. Daraus entstehen im PDF die Tageszeilen
-- (ohne Feiertage und Schließzeiten des Objekts). Die eigenen Leute kommen aus der Einsatzplanung.
create table app.site_timesheet_extras (
  id uuid primary key,
  site_id uuid not null references app.sites (id) on delete cascade,
  person text not null check (length(trim(person)) between 1 and 120),
  start_time time not null,
  end_time time not null check (end_time <> start_time),
  break_minutes int not null default 0 check (break_minutes between 0 and 720),
  weekdays smallint[] not null default '{1,2,3,4,5}' check (weekdays <@ '{1,2,3,4,5,6,7}' and cardinality(weekdays) > 0),
  valid_from date not null,
  valid_until date check (valid_until is null or valid_until >= valid_from),
  created_by text not null,
  created_at timestamptz not null default now()
);
create index on app.site_timesheet_extras (site_id);

alter table app.site_timesheet_extras enable row level security;
create policy site_timesheet_extras_office on app.site_timesheet_extras for select to authenticated
  using ((select app.is_office()));
