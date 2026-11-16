-- Auftragsgruppen (Ahmed 16.11.): mehrere Objekte (z. B. alle Lose einer Ausschreibung) gemeinsam in Nach- und
-- Plan-Kalkulation bewerten. Jedes Objekt höchstens in einer Gruppe.
create table if not exists app.contract_groups (
  id uuid primary key,
  name text not null check (length(trim(name)) between 1 and 200),
  note text,
  tender_id uuid references app.tenders(id) on delete set null,
  created_by text not null,
  created_at timestamptz not null default now()
);
create table if not exists app.contract_group_sites (
  site_id uuid primary key references app.sites(id) on delete cascade,
  group_id uuid not null references app.contract_groups(id) on delete cascade
);
create index if not exists contract_group_sites_group_idx on app.contract_group_sites (group_id);
alter table app.contract_groups enable row level security;
alter table app.contract_group_sites enable row level security;
create policy contract_groups_office on app.contract_groups for all to authenticated
  using ((select app.is_office())) with check ((select app.is_office()));
create policy contract_group_sites_office on app.contract_group_sites for all to authenticated
  using ((select app.is_office())) with check ((select app.is_office()));
