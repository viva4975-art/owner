-- Outlook-Kalender (IONOS Exchange) in der App (Ahmed 01.11.): je Benutzer ein verbundenes Postfach. Passwort
-- AES-256-GCM verschlüsselt (Schlüssel aus SESSION_SECRET), nur der Server liest es – keine Lese-Policy.
create table app.exchange_accounts (
  user_id uuid primary key,
  email text not null,
  login text not null,
  ews_url text not null,
  secret_enc text not null,
  connected_at timestamptz not null default now(),
  last_ok_at timestamptz,
  last_error text
);
alter table app.exchange_accounts enable row level security;
grant all on app.exchange_accounts to service_role;
