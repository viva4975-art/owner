-- Kalender-Abo (ICS-Link für iPhone, Outlook, Google): je Benutzer bzw. Mitarbeiter ein geheimer Link.
-- Der Link ist das Passwort → keine Lese-Policy für angemeldete Nutzer; neu erzeugen macht den alten ungültig.
create table if not exists app.calendar_feeds (
  id uuid primary key,
  user_id uuid unique,
  employee_id uuid unique references app.employees(id),
  token text not null unique check (length(token) >= 32),
  created_at timestamptz not null default now(),
  last_fetched_at timestamptz,
  check (user_id is not null or employee_id is not null)
);
alter table app.calendar_feeds enable row level security;
grant all on app.calendar_feeds to service_role;
