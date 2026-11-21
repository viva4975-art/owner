-- Fahrzeugverkauf Export (Ahmed 21.11.): Ausfuhrnachweis und Kaution je Verkauf festhalten (nur anhängen),
-- EORI-Nummer der Firma (Ausfuhranmeldung beim Zoll).
alter table app.company add column if not exists eori_no text;

create table app.vehicle_export_events (
  id uuid primary key,
  sale_id uuid not null references app.vehicle_sales (id),
  kind text not null check (kind in ('nachweis', 'kaution_zurueck', 'kaution_verrechnet')),
  event_date date not null,
  mrn text,
  note text,
  file_id uuid references app.files (id),
  created_by text not null,
  created_at timestamptz not null default now()
);
create index on app.vehicle_export_events (sale_id, created_at);
-- je Verkauf höchstens ein Ausfuhrnachweis und ein Kautionsabschluss
create unique index vehicle_export_events_one_proof on app.vehicle_export_events (sale_id) where kind = 'nachweis';
create unique index vehicle_export_events_one_deposit on app.vehicle_export_events (sale_id)
  where kind in ('kaution_zurueck', 'kaution_verrechnet');

create trigger vehicle_export_events_append_only before update or delete on app.vehicle_export_events
for each row execute function app.deny_change();

alter table app.vehicle_export_events enable row level security;
create policy vehicle_export_events_office on app.vehicle_export_events for select to authenticated
  using ((select app.is_office()));
grant select on app.vehicle_export_events to authenticated;
grant all on app.vehicle_export_events to service_role;
