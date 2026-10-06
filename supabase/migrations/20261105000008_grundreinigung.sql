-- Planung Grundreinigung wie die alte App: Jahresplanung je Objekt, Kalkulation, Vergabe an Nachunternehmer
create table app.deep_cleaning_plans (
  id uuid primary key,
  year integer not null,
  customer text,
  object text not null check (length(trim(object)) > 0),
  site_id uuid references app.sites (id),
  date_from date, date_to date,
  execution text not null default 'sub' check (execution in ('eigen', 'sub')),
  supplier_id uuid references app.suppliers (id),
  mode text not null default 'belaege' check (mode in ('belaege', 'pauschal')),
  flat_sqm_x100 bigint,                         -- Gesamtfläche m² × 100
  flat_price_cents bigint,                      -- Verkaufspreis gesamt
  floors jsonb not null default '[]',           -- [{belag, sqm_x100, price_cents}] Preis je m²
  db_bp integer not null default 2500,          -- Deckungsbeitrag in Basispunkten (25,00 %)
  material_bp integer not null default 1000,
  devices_bp integer not null default 500,
  material_from text not null default 'uns' check (material_from in ('uns', 'sub')),
  devices_from text not null default 'uns' check (devices_from in ('uns', 'sub')),
  sub_price_cents bigint,                       -- tatsächlicher Preis an den Nachunternehmer
  max_hours numeric(8, 2),
  status text not null default 'Geplant' check (status in ('Geplant', 'Übergeben', 'Ausgeführt')),
  note text,                                    -- Bemerkung für Vorarbeiter / Kunde (auf dem PDF)
  created_by text not null,
  created_at timestamptz not null default now(),
  version integer not null default 1,
  check (date_to is null or date_from is null or date_to >= date_from)
);
create index on app.deep_cleaning_plans (year);
create trigger deep_cleaning_plans_version before update on app.deep_cleaning_plans for each row execute function app.bump_version();
alter table app.deep_cleaning_plans enable row level security;
create policy deep_cleaning_plans_office on app.deep_cleaning_plans for all to authenticated
  using ((select app.is_office())) with check ((select app.is_office()));
