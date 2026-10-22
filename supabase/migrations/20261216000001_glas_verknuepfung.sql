-- Glasreinigung (Ahmed 22.10.): Glas-Objekte mit unseren Objekten (Kostenstelle) und Glas-Kunden mit unseren Kunden
-- verknüpfen. Nur Verweise, nichts wird kopiert oder gelöscht.
alter table app.glass_objects add column if not exists site_id uuid references app.sites (id) on delete set null;
alter table app.glass_customers add column if not exists customer_id uuid references app.customers (id) on delete set null;
create index if not exists glass_objects_site_idx on app.glass_objects (site_id);
