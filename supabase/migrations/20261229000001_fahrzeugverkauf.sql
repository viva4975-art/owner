-- Fahrzeugverkauf (Ahmed 27.10.): Formular mit Punkten zum Ausfüllen → Kaufvertrag + Rechnung (mit 19 % USt oder
-- steuerfrei mit Grund) als PDF. Jeder Verkauf und jedes Storno mit eigener Nummer FV-JJJJ-NNN, nur anhängen,
-- PDF write-once am Fahrzeug.
create table app.vehicle_sales (
  id uuid primary key,
  sale_no text not null unique,
  kind text not null default 'verkauf' check (kind in ('verkauf', 'storno')),
  original_id uuid references app.vehicle_sales (id),
  vehicle_id uuid not null references app.vehicles (id),
  sale_date date not null,
  tax_mode text not null check (tax_mode in ('ust19', 'ig', 'export', 'frei28')),
  net_cents bigint not null,
  vat_cents bigint not null,
  gross_cents bigint not null,
  buyer_name text not null,
  data jsonb not null,
  reason text,
  file_id uuid references app.files (id),
  created_by text not null,
  created_at timestamptz not null default now(),
  check (gross_cents = net_cents + vat_cents),
  check ((kind = 'storno') = (original_id is not null))
);
create index on app.vehicle_sales (vehicle_id, created_at desc);
-- je Verkauf höchstens ein Storno
create unique index vehicle_sales_one_storno on app.vehicle_sales (original_id) where original_id is not null;

create trigger vehicle_sales_append_only before update or delete on app.vehicle_sales
for each row execute function app.deny_change();

alter table app.vehicle_sales enable row level security;
create policy vehicle_sales_office on app.vehicle_sales for select to authenticated
  using ((select app.is_office()));
grant select on app.vehicle_sales to authenticated;
grant all on app.vehicle_sales to service_role;
