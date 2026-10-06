-- Runde 4b: Leistungen „je Ausführung“ / „einmalig“ verrichten (wie Fortytools „Markierte Leistung(en) verrichten“).
-- Eine Ausführung ist vorgemerkt, bis sie auf einem Rechnungsentwurf steht; wird der Entwurf gelöscht, ist sie
-- wieder offen (invoice_id → null).
create table app.service_executions (
  id uuid primary key,
  service_id uuid not null references app.site_services (id),
  site_id uuid not null references app.sites (id),
  date_from date not null,
  date_to date not null,
  quantity_milli bigint not null check (quantity_milli > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),  -- Preis beim Verrichten (eingefroren)
  note text,
  invoice_id uuid references app.invoices (id) on delete set null,
  created_by text not null,
  created_at timestamptz not null default now(),
  check (date_to >= date_from)
);
create index on app.service_executions (site_id);
create index on app.service_executions (invoice_id);
create index service_executions_open on app.service_executions (created_at) where invoice_id is null;

alter table app.service_executions enable row level security;
create policy service_executions_office on app.service_executions for select to authenticated
  using ((select app.is_office()));
grant select on app.service_executions to authenticated;
grant all on app.service_executions to service_role;
