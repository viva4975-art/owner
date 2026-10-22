-- Ausschreibungssuche (Ahmed 22.10.): täglich neue Bekanntmachungen aus dem Bekanntmachungsservice des Bundes
-- (oeffentlichevergabe.de, Open-Data-Export) und TED holen, nach Leistung (CPV/Stichwort) und Umkreis filtern.
-- Treffer landen im Eingang „Gefundene Ausschreibungen“ und werden erst per Klick zur Ausschreibung.

create table app.tender_feed_settings (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default true,
  -- CPV-Anfänge (z. B. '9091' = alle Reinigungsdienste)
  cpv_prefixes text[] not null default array['9091', '90921', '90620', '90630', '98341140'],
  -- Stichwörter im Titel/Beschreibung (zusätzlich zu CPV)
  keywords text[] not null default array[
    'Unterhaltsreinigung', 'Gebäudereinigung', 'Glasreinigung', 'Fensterreinigung', 'Grundreinigung',
    'Bauendreinigung', 'Bauschlussreinigung', 'Sonderreinigung', 'Büroreinigung', 'Schulreinigung',
    'Tiefgaragenreinigung', 'Reinigungsleistungen', 'Reinigungsdienstleistungen', 'Hausmeister', 'Winterdienst'],
  -- Umkreise: [{"name":"München","lat":48.1374,"lng":11.5755,"km":100}, …]
  regions jsonb not null default '[{"name":"München","lat":48.1374,"lng":11.5755,"km":100},
                                    {"name":"Stuttgart","lat":48.7758,"lng":9.1829,"km":20}]'::jsonb,
  -- Ohne erkennbaren Ort: aufnehmen, wenn die Region (NUTS) in Bayern/Baden-Württemberg liegt
  keep_unknown boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into app.tender_feed_settings (id) values (1) on conflict do nothing;

create table app.tender_feed_runs (
  source text not null check (source in ('bund', 'ted')),
  day date not null,
  fetched_at timestamptz not null default now(),
  notices int not null default 0,
  hits int not null default 0,
  error text,
  primary key (source, day)
);

create table app.tender_feed_hits (
  id uuid primary key,
  source text not null check (source in ('bund', 'ted')),
  external_id text not null,
  title text not null,
  description text,
  authority text,
  place text,
  postal_code text,
  nuts text,
  distance_km numeric(6, 1),
  region text,
  deadline_at timestamptz,
  published_on date,
  cpv text[] not null default '{}',
  url text,
  docs_url text,
  procedure text,
  value_cents bigint,
  matched text,
  status text not null default 'neu' check (status in ('neu', 'uebernommen', 'verworfen', 'doppelt')),
  tender_id uuid references app.tenders (id) on delete set null,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source, external_id)
);
create index tender_feed_hits_status on app.tender_feed_hits (status, deadline_at);

-- Ort → Koordinaten (Nominatim), damit jeder Ort nur einmal abgefragt wird
create table app.geo_cache (
  key text primary key,
  lat double precision,
  lng double precision,
  found boolean not null,
  fetched_at timestamptz not null default now()
);

alter table app.tender_feed_settings enable row level security;
alter table app.tender_feed_runs enable row level security;
alter table app.tender_feed_hits enable row level security;
alter table app.geo_cache enable row level security;
create policy tender_feed_settings_read on app.tender_feed_settings for select using ((select app.is_office()));
create policy tender_feed_runs_read on app.tender_feed_runs for select using ((select app.is_office()));
create policy tender_feed_hits_read on app.tender_feed_hits for select using ((select app.is_office()));
create policy geo_cache_read on app.geo_cache for select using ((select app.is_office()));
