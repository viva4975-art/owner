-- Kunde: Zusatzinformationen wie Fortytools (Ahmed 06.10.2026). Kurzinfo = bisherige Spalte notes.
alter table app.customers
  add column billing_hint text,      -- Hinweise zur Rechnungsstellung: werden beim Erstellen von Rechnungen angezeigt
  add column site_notes text,        -- Einsatzort-Notizen: erscheinen in der Handy-App der Mitarbeitenden
  add column warning text,           -- Warnhinweis: hervorgehoben beim Kunden und bei Rechnungen
  add column customer_since date;    -- „Kunde seit“ (Import aus Fortytools; sonst Anlagedatum)

-- Bankverbindungen des Kunden (z. B. zum Erkennen von Zahlungseingängen)
create table app.customer_bank_accounts (
  id uuid primary key,
  customer_id uuid not null references app.customers (id),
  holder text not null check (length(trim(holder)) > 0),
  iban text not null check (iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'),
  bic text,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (customer_id, iban)
);
alter table app.customer_bank_accounts enable row level security;
create policy customer_bank_accounts_office on app.customer_bank_accounts for select to authenticated
  using ((select app.is_office()));
grant select on app.customer_bank_accounts to authenticated;
grant all on app.customer_bank_accounts to service_role;
