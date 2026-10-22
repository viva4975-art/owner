-- Glückwünsche per E-Mail an Mitarbeitende (Ahmed 22.10.): Geburtstag und Jahrestag des Eintritts, im Namen des
-- Teams und der Geschäftsführung, Absender info@. Je Person/Anlass/Jahr genau einmal (Primärschlüssel).
create table if not exists app.greeting_settings (
  id integer primary key default 1 check (id = 1),
  enabled boolean not null default false,
  from_email text not null default 'info@viva-deluxe-reinigung.de',
  send_hour integer not null default 8 check (send_hour between 0 and 23),
  birthday_text text,
  jubilee_text text,
  signed_by text,
  updated_at timestamptz not null default now()
);
insert into app.greeting_settings (id) values (1) on conflict do nothing;

create table if not exists app.greeting_sent (
  employee_id uuid not null references app.employees (id) on delete cascade,
  kind text not null check (kind in ('geburtstag', 'jubilaeum')),
  year integer not null,
  sent_to text,
  status text not null default 'gesendet',
  error text,
  created_at timestamptz not null default now(),
  primary key (employee_id, kind, year)
);

-- Mitarbeitende können widersprechen (Art. 21 DSGVO) → keine Glückwunsch-Mail
alter table app.employees add column if not exists no_greetings boolean not null default false;

alter table app.greeting_settings enable row level security;
alter table app.greeting_sent enable row level security;
create policy greeting_settings_staff on app.greeting_settings for all
  using ((select app.current_role()) in ('admin', 'personal')) with check ((select app.current_role()) in ('admin', 'personal'));
create policy greeting_sent_staff on app.greeting_sent for select
  using ((select app.current_role()) in ('admin', 'personal'));
