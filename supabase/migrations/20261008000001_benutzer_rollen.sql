-- Phase 3 Teil 3: Benutzer und Rollen.
--
-- Prototyp: Anmeldung durch unseren Server (Benutzername + Passwort, scrypt). Konto-ID = auth.users.id, Rolle in
-- app.profiles (wie bisher für RLS vorgesehen). Beim Umzug auf Supabase übernimmt Supabase Auth die Anmeldung;
-- app.user_accounts entfällt dann, Rollen und Objekt-Zuordnung (sites.manager_user_id) bleiben.
--
-- Rollen: admin (alles), buchhaltung (Kunden, Rechnungen, Einkauf, DATEV), personal (Personal inkl. vertraulicher
-- Daten, Zeiterfassung, Urlaub, Einsatzplanung), objektleitung (nur eigene Objekte: Einsatzplanung, Zeiten, Freigaben).

create table app.user_accounts (
  id uuid primary key references auth.users (id) on delete cascade,
  login text not null unique check (login ~ '^[a-z0-9._@-]{3,64}$'),
  password_hash text not null,
  must_change_password boolean not null default true,
  active boolean not null default true,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  version integer not null default 1
);
create trigger user_accounts_version before update on app.user_accounts for each row execute function app.bump_version();

alter table app.profiles add column email text;

-- Keine Policy: Passwort-Hashes nur für den Server
alter table app.user_accounts enable row level security;
grant all on app.user_accounts to service_role;
