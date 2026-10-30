-- Schließzeiten am Objekt (Ahmed 30.10.): an diesen Tagen wird nicht gereinigt. Wirkt auf Leistungen „nach
-- Arbeitstagen“ (Rechnungsmenge), NU-Bestellungen „je Tag“ an diesem Objekt und eingeplante Einsätze (entfallen).
create table app.site_closures (
  id uuid primary key,
  site_id uuid not null references app.sites (id) on delete cascade,
  date_from date not null,
  date_to date not null check (date_to >= date_from),
  note text,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index on app.site_closures (site_id, date_from);

alter table app.site_closures enable row level security;
create policy site_closures_office on app.site_closures for select to authenticated
  using ((select app.is_office()));
