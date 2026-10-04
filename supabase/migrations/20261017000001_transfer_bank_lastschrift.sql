-- Transfer wie Fortytools: Kontoumsätze (Import CAMT.053/CSV, Abgleich mit offenen Posten), SEPA-Lastschriften
-- (Mandate, Einzug pain.008), Dokumenteneingang (Ablage zum Zuordnen).

-- ---------------------------------------------------------------- Kontoumsätze
create table app.bank_imports (
  id uuid primary key,
  filename text not null,
  format text not null check (format in ('camt053', 'csv')),
  file_path text not null,      -- Archiv (write-once), inhaltsadressiert
  file_sha256 text not null,
  line_count integer not null,
  new_count integer not null,
  created_by text not null,
  created_at timestamptz not null default now()
);

create table app.bank_transactions (
  id uuid primary key,          -- md5(Konto|Buchungstag|Betrag|Referenz|Zweck|Vorkommen) → überlappende Auszüge doppelt einlesen schadet nicht
  import_id uuid not null references app.bank_imports (id),
  account_iban text,
  booking_date date not null,
  value_date date,
  amount_cents bigint not null check (amount_cents <> 0),  -- + Eingang, − Ausgang
  counterparty_name text,
  counterparty_iban text,
  purpose text not null default '',
  end_to_end_id text,
  bank_ref text,
  status text not null default 'offen' check (status in ('offen', 'zugeordnet', 'ignoriert')),
  note text,
  matched_by text,
  matched_at timestamptz,
  created_at timestamptz not null default now()
);
create index on app.bank_transactions (status, booking_date);

-- Umsatzdaten selbst sind unveränderbar; nur Status/Notiz dürfen sich ändern, „zugeordnet“ ist endgültig.
create or replace function app.guard_bank_transaction() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Kontoumsätze können nicht gelöscht werden';
  end if;
  if (new.import_id, new.account_iban, new.booking_date, new.value_date, new.amount_cents, new.counterparty_name,
      new.counterparty_iban, new.purpose, new.end_to_end_id, new.bank_ref)
     is distinct from
     (old.import_id, old.account_iban, old.booking_date, old.value_date, old.amount_cents, old.counterparty_name,
      old.counterparty_iban, old.purpose, old.end_to_end_id, old.bank_ref) then
    raise exception 'Umsatzdaten sind unveränderbar';
  end if;
  if old.status = 'zugeordnet' then
    raise exception 'Zugeordnete Umsätze sind abgeschlossen (Korrektur über Gegenbuchung der Zahlung)';
  end if;
  return new;
end $$;
create trigger bank_transactions_guard before update or delete on app.bank_transactions
for each row execute function app.guard_bank_transaction();

alter table app.payments add column bank_transaction_id uuid references app.bank_transactions (id);
create index on app.payments (bank_transaction_id);

-- ---------------------------------------------------------------- SEPA-Lastschrift
alter table app.company add column creditor_id text;  -- Gläubiger-Identifikationsnummer (Bundesbank), z. B. DE98ZZZ09999999999

create table app.sepa_mandates (
  id uuid primary key,
  customer_id uuid not null references app.customers (id),
  mandate_ref text not null unique,          -- Mandatsreferenz (max. 35 Zeichen)
  signed_on date not null,
  account_holder text not null,
  iban text not null,
  bic text,
  scheme text not null default 'CORE' check (scheme in ('CORE', 'B2B')),
  active boolean not null default true,
  note text,
  created_by text not null,
  created_at timestamptz not null default now(),
  version integer not null default 1
);
create index on app.sepa_mandates (customer_id);
create unique index sepa_mandates_one_active on app.sepa_mandates (customer_id) where active;
create trigger sepa_mandates_version before update on app.sepa_mandates
for each row execute function app.bump_version();

create table app.direct_debit_runs (
  id uuid primary key,
  number text not null unique,               -- LS-JJJJ-NNN
  collection_date date not null,
  creditor_iban text not null,
  creditor_bic text not null,
  creditor_id text not null,
  total_cents bigint not null,
  item_count integer not null,
  message_id text not null,
  status text not null default 'erstellt' check (status in ('erstellt', 'eingezogen')),
  xml_path text,
  xml_sha256 text,
  created_by text not null,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);

create table app.direct_debit_items (
  run_id uuid not null references app.direct_debit_runs (id),
  invoice_id uuid not null references app.invoices (id),
  mandate_id uuid not null references app.sepa_mandates (id),
  amount_cents bigint not null check (amount_cents > 0),
  sequence_type text not null check (sequence_type in ('FRST', 'RCUR')),
  end_to_end_id text not null,
  remittance text not null,
  returned_at date,                          -- Rücklastschrift
  return_reason text,
  primary key (run_id, invoice_id)
);
-- jede Rechnung höchstens einmal im Einzug (außer nach Rücklastschrift)
create unique index direct_debit_items_once on app.direct_debit_items (invoice_id) where returned_at is null;

-- ---------------------------------------------------------------- Dokumenteneingang
alter table app.file_links drop constraint file_links_entity_type_check;
alter table app.file_links add constraint file_links_entity_type_check
  check (entity_type in ('offer', 'invoice', 'customer', 'site', 'employee', 'supplier', 'incoming_invoice',
                         'purchase_order', 'order', 'work_report', 'quality_check', 'inbox'));

-- ---------------------------------------------------------------- Rechte
alter table app.bank_imports enable row level security;
alter table app.bank_transactions enable row level security;
alter table app.sepa_mandates enable row level security;
alter table app.direct_debit_runs enable row level security;
alter table app.direct_debit_items enable row level security;
create policy bank_imports_office on app.bank_imports for select to authenticated using ((select app.is_office()));
create policy bank_transactions_office on app.bank_transactions for select to authenticated using ((select app.is_office()));
create policy sepa_mandates_office on app.sepa_mandates for select to authenticated using ((select app.is_office()));
create policy direct_debit_runs_office on app.direct_debit_runs for select to authenticated using ((select app.is_office()));
create policy direct_debit_items_office on app.direct_debit_items for select to authenticated using ((select app.is_office()));
grant select on app.bank_imports, app.bank_transactions, app.sepa_mandates, app.direct_debit_runs,
  app.direct_debit_items to authenticated;
grant all on app.bank_imports, app.bank_transactions, app.sepa_mandates, app.direct_debit_runs,
  app.direct_debit_items to service_role;

