-- Offene Posten wie Fortytools (Runde 23): Zahlungen und Skonto auch auf Rechnungen aus Fortytools, je Buchung eine
-- Zeile (nur anhängen). paid_part_cents bleibt die Summe der Teilzahlungen (Sicht legacy_open_items unverändert).
create table app.legacy_payments (
  id uuid primary key,
  invoice_id uuid not null references app.legacy_invoices (id),
  amount_cents bigint not null check (amount_cents > 0),
  paid_on date not null,
  method text not null check (method in ('zahlung', 'skonto')),
  reference text,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index on app.legacy_payments (invoice_id);
create trigger legacy_payments_append_only before update or delete on app.legacy_payments
for each row execute function app.deny_change();
alter table app.legacy_payments enable row level security;
create policy legacy_payments_office on app.legacy_payments for select to authenticated using ((select app.is_office()));
grant select on app.legacy_payments to authenticated;
grant all on app.legacy_payments to service_role;
