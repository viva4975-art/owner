-- Kostenstellen: jedes Objekt ist eine Kostenstelle; dazu allgemeine Kostenstellen (Verwaltung, Fahrzeuge …).
-- Eingangsrechnungen (auch Nachunternehmer) werden auf Kostenstellen und Leistungsmonate aufgeteilt (Cent-genau);
-- die Nachkalkulation rechnet mit dieser Aufteilung.

create table app.cost_centers (
  id uuid primary key,
  number text not null unique check (length(trim(number)) > 0),
  name text not null check (length(trim(name)) > 0),
  active boolean not null default true,
  version integer not null default 1
);
create trigger cost_centers_version before update on app.cost_centers for each row execute function app.bump_version();
insert into app.cost_centers (id, number, name) values
  ('00000000-0000-4000-8000-0000000cc001', '9000', 'Verwaltung / Büro'),
  ('00000000-0000-4000-8000-0000000cc002', '9100', 'Fahrzeuge'),
  ('00000000-0000-4000-8000-0000000cc003', '9200', 'Lager / Material allgemein'),
  ('00000000-0000-4000-8000-0000000cc004', '9300', 'Werbung / Akquise'),
  ('00000000-0000-4000-8000-0000000cc005', '9400', 'Personal allgemein (Schulung, Arbeitskleidung)')
on conflict (id) do nothing;

create table app.cost_allocations (
  id uuid primary key,
  incoming_invoice_id uuid not null references app.incoming_invoices (id) on delete cascade,
  site_id uuid references app.sites (id),
  cost_center_id uuid references app.cost_centers (id),
  month date not null check (extract(day from month) = 1),
  net_cents bigint not null check (net_cents <> 0),
  auto boolean not null default false,          -- aus Objekt/Leistungsmonat der Rechnung automatisch angelegt
  note text,
  created_by text not null,
  created_at timestamptz not null default now(),
  check ((site_id is null) <> (cost_center_id is null))
);
create index on app.cost_allocations (incoming_invoice_id);
create index on app.cost_allocations (site_id, month);
create index on app.cost_allocations (cost_center_id, month);

-- Bestand: Rechnungen mit Objekt werden vollständig diesem Objekt und dem Leistungsmonat zugeordnet
insert into app.cost_allocations (id, incoming_invoice_id, site_id, month, net_cents, auto, created_by)
select gen_random_uuid(), i.id, i.site_id, coalesce(i.service_month, date_trunc('month', i.invoice_date)::date), i.net_cents, true, 'migration'
  from app.incoming_invoices i
 where i.site_id is not null and i.net_cents <> 0;

alter table app.cost_centers enable row level security;
alter table app.cost_allocations enable row level security;
create policy cost_centers_read on app.cost_centers for select to authenticated using ((select app.is_office()));
create policy cost_allocations_office on app.cost_allocations for select to authenticated using ((select app.is_office()));
grant select on app.cost_centers, app.cost_allocations to authenticated;
grant all on app.cost_centers, app.cost_allocations to service_role;
