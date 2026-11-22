-- Budgetplanung je Jahr (Ahmed 22.11.): Umsatz je Objekt aus den laufenden Leistungen (monatlich, Turnus/jährlich,
-- einmalig, Sonderleistungen wie Vorjahr), direkte Kosten (Lohn laut Einsatzplanung, Nachunternehmer, Material) und
-- Gemeinkosten je Kostenart (Objektleitung, Büro, Geschäftsführer, Fahrzeuge, Investitionen …). Die Berechnung wird als
-- Stand gespeichert (Entwurf), nach der Freigabe ist das Budget gesperrt und dient als Soll für den Soll/Ist-Vergleich.
create table if not exists app.budgets (
  id uuid primary key,
  year integer not null unique check (year between 2020 and 2100),
  status text not null default 'entwurf' check (status in ('entwurf', 'freigegeben')),
  wage_increase_bp integer not null default 0 check (wage_increase_bp between 0 and 5000),
  wage_increase_month smallint not null default 1 check (wage_increase_month between 1 and 12),
  pass_on boolean not null default true,
  extra_like_prev boolean not null default true,
  allocate boolean not null default true,
  note text,
  computing boolean not null default false,
  compute_error text,
  computed_at timestamptz,
  computed_by text,
  approved_at timestamptz,
  approved_by text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app.budget_site_months (
  budget_id uuid not null references app.budgets(id) on delete cascade,
  site_id uuid not null references app.sites(id) on delete cascade,
  month smallint not null check (month between 1 and 12),
  revenue_flat bigint not null default 0,
  revenue_cycle bigint not null default 0,
  revenue_extra bigint not null default 0,
  revenue_increase bigint not null default 0,
  prev_revenue bigint not null default 0,
  minutes integer not null default 0,
  labor bigint not null default 0,
  subcontractor bigint not null default 0,
  material bigint not null default 0,
  primary key (budget_id, site_id, month)
);

create table if not exists app.budget_costs (
  id uuid primary key,
  budget_id uuid not null references app.budgets(id) on delete cascade,
  category text not null,
  label text not null check (length(trim(label)) between 1 and 200),
  amounts bigint[] not null check (cardinality(amounts) = 12),
  suggested bigint[] check (suggested is null or cardinality(suggested) = 12),
  source text,
  manual boolean not null default false,
  invest boolean not null default false,
  sort integer not null default 0,
  note text,
  updated_by text,
  updated_at timestamptz not null default now()
);
create index if not exists budget_costs_budget_idx on app.budget_costs (budget_id);

create table if not exists app.budget_adjustments (
  id uuid primary key,
  budget_id uuid not null references app.budgets(id) on delete cascade,
  site_id uuid references app.sites(id) on delete cascade,
  customer_id uuid references app.customers(id) on delete set null,
  label text not null check (length(trim(label)) between 1 and 200),
  from_month smallint not null default 1 check (from_month between 1 and 12),
  to_month smallint not null default 12 check (to_month between 1 and 12),
  revenue_month bigint not null default 0,
  cost_month bigint not null default 0,
  note text,
  created_by text not null,
  created_at timestamptz not null default now(),
  check (to_month >= from_month)
);
create index if not exists budget_adjustments_budget_idx on app.budget_adjustments (budget_id);

alter table app.budgets enable row level security;
alter table app.budget_site_months enable row level security;
alter table app.budget_costs enable row level security;
alter table app.budget_adjustments enable row level security;
create policy budgets_office on app.budgets for all to authenticated
  using ((select app.is_office())) with check ((select app.is_office()));
create policy budget_site_months_office on app.budget_site_months for all to authenticated
  using ((select app.is_office())) with check ((select app.is_office()));
create policy budget_costs_office on app.budget_costs for all to authenticated
  using ((select app.is_office())) with check ((select app.is_office()));
create policy budget_adjustments_office on app.budget_adjustments for all to authenticated
  using ((select app.is_office())) with check ((select app.is_office()));
