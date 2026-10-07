-- Rechnungseingang: erwartete Rechnungen von Nachunternehmern (Ahmed 07.10.). Eine Eingangsrechnung kann mehrere
-- Aufträge und Zeiträume abdecken (z. B. Glasreinigung mehrerer Objekte auf einer Rechnung).
create table app.incoming_invoice_subcontracts (
  id uuid primary key default gen_random_uuid(),
  incoming_invoice_id uuid not null references app.incoming_invoices (id) on delete cascade,
  subcontract_id uuid not null references app.subcontracts (id),
  period_month date not null check (extract(day from period_month) = 1),  -- Beginn des Abrechnungszeitraums
  net_cents bigint,                                                       -- Anteil netto (optional)
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (incoming_invoice_id, subcontract_id, period_month)
);
create index on app.incoming_invoice_subcontracts (subcontract_id, period_month);

-- Zeitraum ausdrücklich „keine Rechnung erwartet“ (z. B. Ausfall, Urlaub des NU) – mit Grund, bleibt nachvollziehbar
create table app.subcontract_expected_skips (
  subcontract_id uuid not null references app.subcontracts (id),
  period_month date not null check (extract(day from period_month) = 1),
  reason text not null check (length(trim(reason)) > 0),
  created_by text not null,
  created_at timestamptz not null default now(),
  primary key (subcontract_id, period_month)
);

alter table app.incoming_invoice_subcontracts enable row level security;
alter table app.subcontract_expected_skips enable row level security;
create policy incoming_invoice_subcontracts_office on app.incoming_invoice_subcontracts for select to authenticated
  using ((select app.is_office()));
create policy subcontract_expected_skips_office on app.subcontract_expected_skips for select to authenticated
  using ((select app.is_office()));
grant select on app.incoming_invoice_subcontracts, app.subcontract_expected_skips to authenticated;
grant all on app.incoming_invoice_subcontracts, app.subcontract_expected_skips to service_role;

-- Bestand: bisherige Zuordnung (ein Auftrag je Rechnung) übernehmen
insert into app.incoming_invoice_subcontracts (incoming_invoice_id, subcontract_id, period_month, net_cents, created_by)
select i.id, i.subcontract_id, coalesce(i.service_month, date_trunc('month', i.invoice_date)::date), i.net_cents, 'migration'
  from app.incoming_invoices i where i.subcontract_id is not null
on conflict do nothing;
