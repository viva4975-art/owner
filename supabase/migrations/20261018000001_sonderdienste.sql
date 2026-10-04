-- Sonderdienste wie in der alten App (Glasreinigung, Tiefgarage u. a.): wiederkehrende Sonderreinigungen je Objekt mit
-- Intervall, Fälligkeit, Terminen (geplant → angekündigt → erledigt/abgesagt), Aushang und Abrechnung je Durchführung.

create table app.special_services (
  id uuid primary key,
  site_id uuid not null references app.sites (id),
  kind text not null check (kind in ('glas', 'tiefgarage', 'grundreinigung', 'teppich', 'sonstiges')),
  title text not null check (length(trim(title)) > 0),
  scope text,                                  -- Umfang, z. B. „Fenster innen/außen inkl. Rahmen, 420 m²“
  interval_months integer not null check (interval_months between 1 and 60),
  next_due date not null,
  price_cents bigint check (price_cents is null or price_cents >= 0),   -- Festpreis je Durchführung (netto)
  vat_rate_bp integer not null default 1900 check (vat_rate_bp in (700, 1900)),
  notice_days integer not null default 0 check (notice_days between 0 and 60), -- Aushang so viele Tage vorher
  active boolean not null default true,
  note text,
  created_by text not null,
  created_at timestamptz not null default now(),
  version integer not null default 1
);
create index on app.special_services (site_id);
create index on app.special_services (active, next_due);
create trigger special_services_version before update on app.special_services
for each row execute function app.bump_version();

create table app.special_service_runs (
  id uuid primary key,
  special_service_id uuid not null references app.special_services (id),
  planned_date date not null,
  start_time time,
  end_time time,
  employee_ids uuid[] not null default '{}',
  status text not null default 'geplant' check (status in ('geplant', 'angekuendigt', 'erledigt', 'abgesagt')),
  announced_at timestamptz,
  done_at timestamptz,
  work_report_id uuid references app.work_reports (id),
  invoice_id uuid references app.invoices (id),
  note text,
  created_by text not null,
  created_at timestamptz not null default now(),
  version integer not null default 1,
  check (start_time is null or end_time is null or end_time > start_time)
);
create index on app.special_service_runs (special_service_id, planned_date);
create index on app.special_service_runs (status, planned_date);
-- höchstens ein offener Termin je Sonderdienst
create unique index special_service_runs_one_open on app.special_service_runs (special_service_id)
  where status in ('geplant', 'angekuendigt');
create trigger special_service_runs_version before update on app.special_service_runs
for each row execute function app.bump_version();

alter table app.special_services enable row level security;
alter table app.special_service_runs enable row level security;
create policy special_services_read on app.special_services for select to authenticated
  using ((select app.is_office())
         or site_id in (select s.id from app.sites s where s.manager_user_id = (select auth.uid())));
create policy special_service_runs_read on app.special_service_runs for select to authenticated
  using ((select app.is_office())
         or special_service_id in (select x.id from app.special_services x join app.sites s on s.id = x.site_id
                                    where s.manager_user_id = (select auth.uid())));
grant select on app.special_services, app.special_service_runs to authenticated;
grant all on app.special_services, app.special_service_runs to service_role;
