-- Sammelbestellung: einzelne Objekte kündigen (Ahmed 26.11.). Bis einschließlich valid_to zählt das Objekt,
-- im Monat des Endes anteilig nach Kalendertagen, danach nicht mehr. Leer = läuft mit der Bestellung.
alter table app.subcontract_sites
  add column if not exists valid_to date,
  add column if not exists end_reason text,
  add column if not exists ended_at timestamptz,
  add column if not exists ended_by text,
  add column if not exists end_file_id uuid;
comment on column app.subcontract_sites.valid_to is 'Objekt gekündigt zum (einschließlich); leer = läuft mit der Bestellung';
