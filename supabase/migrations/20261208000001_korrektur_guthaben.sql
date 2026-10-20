-- Rechnungskorrektur separat verrechnen (Ahmed 20.10.): Der Kunde zahlt die Rechnung voll und zieht die Korrektur erst
-- mit einer späteren Zahlung ab. Der zu viel gezahlte Betrag wird als Guthaben aus der Korrektur festgehalten und beim
-- nächsten Zahlungseingang auf eine andere Rechnung verrechnet. Beides nur anhängen.
create table app.correction_credits (
  id uuid primary key,
  correction_id uuid not null unique references app.invoices (id),
  customer_id uuid not null references app.customers (id),
  amount_cents bigint not null check (amount_cents > 0),
  received_on date not null,
  bank_transaction_id uuid references app.bank_transactions (id),
  created_by text not null,
  created_at timestamptz not null default now()
);
create index on app.correction_credits (customer_id);

create table app.correction_credit_uses (
  id uuid primary key,
  credit_id uuid not null references app.correction_credits (id),
  invoice_id uuid references app.invoices (id),
  legacy_invoice_id uuid references app.legacy_invoices (id),
  amount_cents bigint not null check (amount_cents > 0),
  used_on date not null,
  bank_transaction_id uuid references app.bank_transactions (id),
  created_by text not null,
  created_at timestamptz not null default now(),
  check ((invoice_id is null) <> (legacy_invoice_id is null))
);
create index on app.correction_credit_uses (credit_id);

create trigger correction_credits_append_only before update or delete on app.correction_credits
for each row execute function app.deny_change();
create trigger correction_credit_uses_append_only before update or delete on app.correction_credit_uses
for each row execute function app.deny_change();

alter table app.correction_credits enable row level security;
alter table app.correction_credit_uses enable row level security;
create policy correction_credits_office on app.correction_credits for select to authenticated
  using ((select app.is_office()));
create policy correction_credit_uses_office on app.correction_credit_uses for select to authenticated
  using ((select app.is_office()));
grant select on app.correction_credits, app.correction_credit_uses to authenticated;
grant all on app.correction_credits, app.correction_credit_uses to service_role;

-- Verrechnung des Guthabens auch auf Rechnungen von vor der Umstellung
alter table app.legacy_payments drop constraint if exists legacy_payments_method_check;
alter table app.legacy_payments add constraint legacy_payments_method_check
  check (method in ('zahlung', 'skonto', 'kuerzung', 'verrechnung'));
