-- Sammelbestellung an Nachunternehmer (Ahmed 19.10.: „nicht jede Tiefgarage einzeln bestellen“): eine Bestellung für
-- mehrere Objekte. Kosten je Objekt nach Fläche (Preis je m² oder Pauschale nach m² verteilt) oder als Anteil am
-- Umsatz bei fester Marge (z. B. 10 % bleiben bei uns, 90 % bekommt der Nachunternehmer).
alter table app.subcontracts drop constraint if exists subcontracts_billing_check;
alter table app.subcontracts add constraint subcontracts_billing_check
  check (billing in ('pauschale_monat', 'pauschale_einsatz', 'stunde', 'tag', 'qm', 'umsatz'));
-- unsere Marge in Basispunkten (1000 = 10 %) bei Abrechnung „Anteil am Umsatz“
alter table app.subcontracts add column margin_bp integer check (margin_bp between 0 and 10000);

create table app.subcontract_sites (
  subcontract_id uuid not null references app.subcontracts (id) on delete cascade,
  site_id uuid not null references app.sites (id),
  -- Fläche in m² (zwei Nachkommastellen, kein Gleitkomma)
  sqm numeric(12, 2) check (sqm >= 0),
  created_by text not null,
  created_at timestamptz not null default now(),
  primary key (subcontract_id, site_id)
);
create index on app.subcontract_sites (site_id);

alter table app.subcontract_sites enable row level security;
create policy subcontract_sites_office on app.subcontract_sites for select to authenticated
  using ((select app.is_office()));
grant select on app.subcontract_sites to authenticated;
grant all on app.subcontract_sites to service_role;
