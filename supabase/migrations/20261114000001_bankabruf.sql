-- Bankabruf über Enable Banking (PSD2-Kontoinformationen, lizenzierter Dienst) statt Kontoauszug-Upload.
-- Zugang (Application-ID + privater Schlüssel) liegt nur auf dem Server, Schlüssel verschlüsselt (Schlüssel aus
-- SESSION_SECRET). Keine Lese-Policy für angemeldete Benutzer → nur der Server (Eigentümer) liest die Tabelle.
create table app.bank_feed_config (
  id integer primary key default 1 check (id = 1),
  app_id text not null,
  key_enc text not null,               -- AES-256-GCM: iv.tag.daten (base64)
  key_fingerprint text not null,       -- SHA-256 des öffentlichen Schlüssels (Anzeige)
  updated_by text not null,
  updated_at timestamptz not null default now()
);
alter table app.bank_feed_config enable row level security;
grant all on app.bank_feed_config to service_role;

-- Freigaben je Bank (Login + TAN im Fenster der Bank, ca. alle 180 Tage erneuern)
create table app.bank_connections (
  id uuid primary key,
  aspsp_name text not null,
  aspsp_country text not null default 'DE',
  state text not null unique,          -- Rückkehr-Prüfung (gegen Untergeschobenes)
  status text not null default 'angefragt' check (status in ('angefragt', 'aktiv', 'abgelaufen', 'getrennt', 'fehler')),
  session_id text,
  valid_until timestamptz,
  error text,
  created_by text not null,
  created_at timestamptz not null default now(),
  activated_at timestamptz
);
alter table app.bank_connections enable row level security;
create policy bank_connections_office on app.bank_connections for select to authenticated using ((select app.is_office()));
grant select on app.bank_connections to authenticated;
grant all on app.bank_connections to service_role;

-- Konten aus der Freigabe, mit letztem Kontostand
create table app.bank_feed_accounts (
  uid text primary key,                -- Konto-ID bei Enable Banking (je Freigabe)
  connection_id uuid not null references app.bank_connections (id),
  iban text,
  name text,
  currency text,
  balance_cents bigint,
  balance_type text,
  balance_date date,
  balance_at timestamptz,
  last_fetch_at timestamptz,
  last_fetch_error text,
  last_booking_date date,
  active boolean not null default true
);
create index on app.bank_feed_accounts (iban);
alter table app.bank_feed_accounts enable row level security;
create policy bank_feed_accounts_office on app.bank_feed_accounts for select to authenticated using ((select app.is_office()));
grant select on app.bank_feed_accounts to authenticated;
grant all on app.bank_feed_accounts to service_role;

-- Abruf = eigener „Import“ (Rohdaten write-once im Archiv)
alter table app.bank_imports drop constraint bank_imports_format_check;
alter table app.bank_imports add constraint bank_imports_format_check check (format in ('camt053', 'csv', 'api'));

-- Zuordnung wie Fortytools: Kunde / Lieferant / Mitarbeiter (Status/Notiz bleiben änderbar, Umsatzdaten nicht)
alter table app.bank_transactions add column assigned_kind text
  check (assigned_kind in ('kunde', 'lieferant', 'mitarbeiter', 'sonstiges')),
  add column assigned_id uuid;

-- Zahlungen auf Rechnungen aus Fortytools: Herkunft Kontoumsatz
alter table app.legacy_payments add column bank_transaction_id uuid references app.bank_transactions (id);
alter table app.incoming_invoices add column bank_transaction_id uuid references app.bank_transactions (id);
