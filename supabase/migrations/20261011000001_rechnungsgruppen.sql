-- Rechnungsgruppen (wie Fortytools): mehrere Objekte eines Kunden werden im Monatslauf auf EINER Rechnung
-- abgerechnet (Sammelrechnung), optional mit eigener Leitweg-ID / Bestellnummer der Gruppe.

create table app.invoice_groups (
  id uuid primary key,
  customer_id uuid not null references app.customers (id),
  name text not null check (length(trim(name)) > 0),
  buyer_reference text,                             -- abweichende Leitweg-ID (BT-10), sonst die des Kunden
  order_reference text,                             -- Bestellnummer (BT-13) für die Sammelrechnung
  note text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  version integer not null default 1,
  unique (customer_id, name)
);
create trigger invoice_groups_version before update on app.invoice_groups
for each row execute function app.bump_version();

alter table app.sites add column invoice_group_id uuid references app.invoice_groups (id);
create index on app.sites (invoice_group_id);
alter table app.invoices add column invoice_group_id uuid references app.invoice_groups (id);

-- Objekt und Rechnungsgruppe müssen zum selben Kunden gehören.
create or replace function app.check_site_invoice_group() returns trigger
language plpgsql as $$
begin
  if new.invoice_group_id is not null and not exists (
       select 1 from app.invoice_groups g where g.id = new.invoice_group_id and g.customer_id = new.customer_id) then
    raise exception 'Rechnungsgruppe gehört zu einem anderen Kunden' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger sites_invoice_group before insert or update of invoice_group_id, customer_id on app.sites
for each row execute function app.check_site_invoice_group();

-- Je Objekt und Monat höchstens eine Monatsrechnung – egal ob einzeln oder in einer Gruppe abgerechnet.
-- (Schutz, falls ein Objekt im laufenden Monat in eine Gruppe wechselt oder sie verlässt.)
create table app.monthly_run_sites (
  site_id uuid not null references app.sites (id),
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  invoice_id uuid not null references app.invoices (id) on delete cascade,
  primary key (site_id, month)
);
create index on app.monthly_run_sites (invoice_id);

-- Bestand übernehmen (bisherige Schlüssel „<objekt>:<JJJJ-MM>“)
insert into app.monthly_run_sites (site_id, month, invoice_id)
select site_id, split_part(monthly_run_key, ':', 2), id
  from app.invoices
 where site_id is not null and monthly_run_key ~ '^[0-9a-f-]{36}:\d{4}-\d{2}$'
on conflict do nothing;

alter table app.invoice_groups enable row level security;
create policy invoice_groups_office on app.invoice_groups for select to authenticated using ((select app.is_office()));
alter table app.monthly_run_sites enable row level security;
create policy monthly_run_sites_office on app.monthly_run_sites for select to authenticated using ((select app.is_office()));
grant select on app.invoice_groups, app.monthly_run_sites to authenticated;
grant all on app.invoice_groups, app.monthly_run_sites to service_role;
