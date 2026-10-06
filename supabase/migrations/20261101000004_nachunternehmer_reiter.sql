-- Runde 4d: Abrechnung von Nachunternehmern auch je Tag; Ansprechpartner je Lieferant/Nachunternehmer (mehrere).
alter table app.subcontracts drop constraint if exists subcontracts_billing_check;
alter table app.subcontracts add constraint subcontracts_billing_check
  check (billing in ('pauschale_monat', 'pauschale_einsatz', 'stunde', 'tag'));

create table app.supplier_contacts (
  id uuid primary key,
  supplier_id uuid not null references app.suppliers (id),
  name text not null check (length(trim(name)) > 0),
  role text,
  phone text,
  mobile text,
  email text,
  note text,
  is_primary boolean not null default false,
  version integer not null default 1,
  created_at timestamptz not null default now()
);
create index on app.supplier_contacts (supplier_id);
create trigger supplier_contacts_version before update on app.supplier_contacts
  for each row execute function app.bump_version();
alter table app.supplier_contacts enable row level security;
create policy supplier_contacts_office on app.supplier_contacts for select to authenticated
  using ((select app.is_office()));
grant select on app.supplier_contacts to authenticated;
grant all on app.supplier_contacts to service_role;

-- Bestehenden Ansprechpartner übernehmen
insert into app.supplier_contacts (id, supplier_id, name, phone, email, is_primary)
select gen_random_uuid(), id, contact_name, phone, email, true from app.suppliers
 where contact_name is not null and trim(contact_name) <> '';
