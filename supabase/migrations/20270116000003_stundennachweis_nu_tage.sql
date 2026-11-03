-- Stundennachweis (Ahmed 03.11.): einzelne Tage einer Nachunternehmer-Person abweichend – an dem Tag anders
-- gearbeitet (andere Zeit/Pause, auch an einem sonst freien Tag) oder nicht ausgeführt (Tag fällt weg).
-- Je Person und Tag höchstens ein Eintrag; die Person selbst (Dauereintrag) bleibt unverändert.
create table app.site_timesheet_extra_days (
  id uuid primary key,
  extra_id uuid not null references app.site_timesheet_extras (id) on delete cascade,
  day date not null,
  kind text not null check (kind in ('anders', 'entfaellt')),
  start_time time,
  end_time time,
  break_minutes int not null default 0 check (break_minutes between 0 and 720),
  note text check (note is null or length(note) <= 300),
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (extra_id, day),
  check (kind = 'entfaellt' or (start_time is not null and end_time is not null and end_time <> start_time))
);

alter table app.site_timesheet_extra_days enable row level security;
create policy site_timesheet_extra_days_office on app.site_timesheet_extra_days for select to authenticated
  using ((select app.is_office()));
