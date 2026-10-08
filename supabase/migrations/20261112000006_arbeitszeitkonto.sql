-- Arbeitszeitkonto: Saldo = Ist (gearbeitet + bezahlte Abwesenheit) − Soll (Wochenstunden ÷ 5 × Arbeitstage) je Monat,
-- fortlaufend ab Startmonat. Buchungen (Startsaldo, Auszahlung, Freizeitausgleich, Korrektur) nur anhängen.
create table app.time_account_settings (
  id integer primary key default 1 check (id = 1),
  start_month text check (start_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  updated_at timestamptz not null default now()
);
insert into app.time_account_settings (id) values (1) on conflict do nothing;
create table app.time_account_bookings (
  id uuid primary key,
  employee_id uuid not null references app.employees (id),
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  minutes integer not null check (minutes <> 0),
  kind text not null check (kind in ('startsaldo', 'auszahlung', 'freizeitausgleich', 'korrektur')),
  note text not null check (length(trim(note)) > 0),
  actor text not null,
  created_at timestamptz not null default now()
);
create index on app.time_account_bookings (employee_id, month);
create trigger time_account_bookings_append_only before update or delete on app.time_account_bookings
  for each row execute function app.guard_append_only();
alter table app.time_account_settings enable row level security;
alter table app.time_account_bookings enable row level security;
create policy time_account_settings_hr on app.time_account_settings for select to authenticated using ((select app.is_office()));
create policy time_account_bookings_hr on app.time_account_bookings for select to authenticated using ((select app.is_office()));
