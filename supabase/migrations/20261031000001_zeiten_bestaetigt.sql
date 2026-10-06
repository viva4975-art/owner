-- „Zeiterfassung bestätigt“ je Objekt und Monat (wie Fortytools). Nur anhängen: jede Bestätigung und jede
-- Rücknahme ist ein eigener Eintrag; der aktuelle Stand ist der jüngste Eintrag je Objekt + Monat.
create table app.site_time_confirmations (
  id uuid primary key,
  site_id uuid not null references app.sites (id),
  month date not null check (extract(day from month) = 1),
  confirmed boolean not null,
  minutes integer not null check (minutes >= 0),   -- bestätigte Ist-Minuten zum Zeitpunkt der Bestätigung
  note text,
  actor text not null,
  created_at timestamptz not null default now()
);
create index on app.site_time_confirmations (site_id, month, created_at desc);

create or replace function app.guard_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'Einträge in % sind unveränderbar', tg_table_name using errcode = 'check_violation';
end $$;
create trigger site_time_confirmations_append_only before update or delete on app.site_time_confirmations
  for each row execute function app.guard_append_only();

alter table app.site_time_confirmations enable row level security;
create policy site_time_confirmations_read on app.site_time_confirmations for select to authenticated
  using ((select app.is_office()) or site_id in (select id from app.sites where manager_user_id = (select auth.uid())));
grant select on app.site_time_confirmations to authenticated;
grant all on app.site_time_confirmations to service_role;
