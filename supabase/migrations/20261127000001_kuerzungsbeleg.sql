-- Interner Buchungsbeleg zur Forderungskürzung (Ahmed 15.10.2026: „Rechnung zu wenig bezahlt soll einen Beleg bekommen,
-- damit es der Steuerberater sicher sieht“). Nummer KB-JJJJ-NNNN, PDF write-once, geht nicht an den Kunden.
create table app.reduction_vouchers (
  id uuid primary key,
  number text not null unique,
  invoice_id uuid references app.invoices (id),
  legacy_invoice_id uuid references app.legacy_invoices (id),
  customer_id uuid not null references app.customers (id),
  invoice_number text not null,
  invoice_date date,
  voucher_date date not null,
  gross_cents bigint not null check (gross_cents > 0),
  net_cents bigint not null,
  vat_cents bigint not null,
  reason text not null,
  file_id uuid references app.files (id),
  created_by text not null,
  created_at timestamptz not null default now(),
  check ((invoice_id is null) <> (legacy_invoice_id is null))
);
create index on app.reduction_vouchers (customer_id);
create index on app.reduction_vouchers (voucher_date);
create trigger reduction_vouchers_append_only before update or delete on app.reduction_vouchers
for each row execute function app.deny_change();
alter table app.reduction_vouchers enable row level security;
create policy reduction_vouchers_office on app.reduction_vouchers for select to authenticated
  using ((select app.is_office()));
grant select on app.reduction_vouchers to authenticated;
grant all on app.reduction_vouchers to service_role;
