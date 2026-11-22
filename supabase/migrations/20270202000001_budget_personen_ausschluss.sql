-- Budgetplanung (Ahmed 22.11.): Personalkosten der Gemeinkosten je Person einsehbar, Zuordnung je Person änderbar
-- (Objektleitung / Büro / Geschäftsführer / nicht berücksichtigen) und Objekte aus dem Budget herausnehmen
-- (z. B. abgeschlossene Baureinigung).
create table if not exists app.budget_cost_persons (
  budget_id uuid not null references app.budgets(id) on delete cascade,
  employee_id uuid not null references app.employees(id) on delete cascade,
  category text not null check (category in ('lead', 'office', 'gf', 'none')),
  auto_category text not null check (auto_category in ('lead', 'office', 'gf')),
  name text not null,
  personnel_no text,
  pay text,
  minutes integer[] not null check (cardinality(minutes) = 12),
  gross bigint[] not null check (cardinality(gross) = 12),
  employer bigint[] not null check (cardinality(employer) = 12),
  amounts bigint[] not null check (cardinality(amounts) = 12),
  primary key (budget_id, employee_id)
);

create table if not exists app.budget_person_overrides (
  budget_id uuid not null references app.budgets(id) on delete cascade,
  employee_id uuid not null references app.employees(id) on delete cascade,
  category text not null check (category in ('lead', 'office', 'gf', 'none')),
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key (budget_id, employee_id)
);

create table if not exists app.budget_excluded_sites (
  budget_id uuid not null references app.budgets(id) on delete cascade,
  site_id uuid not null references app.sites(id) on delete cascade,
  reason text,
  created_by text not null,
  created_at timestamptz not null default now(),
  primary key (budget_id, site_id)
);

alter table app.budget_cost_persons enable row level security;
alter table app.budget_person_overrides enable row level security;
alter table app.budget_excluded_sites enable row level security;
create policy budget_cost_persons_office on app.budget_cost_persons for all to authenticated
  using ((select app.is_office())) with check ((select app.is_office()));
create policy budget_person_overrides_office on app.budget_person_overrides for all to authenticated
  using ((select app.is_office())) with check ((select app.is_office()));
create policy budget_excluded_sites_office on app.budget_excluded_sites for all to authenticated
  using ((select app.is_office())) with check ((select app.is_office()));
