-- Ahmed 24.11.: „Vertrag ruhend“ mit Zeitraum von–bis. Im Zeitraum unbezahlt frei (eigene Abwesenheit), damit Lohn,
-- Nach-/Plan-Kalkulation und Budget keine Kosten rechnen; Urlaub entsteht im Ruhenszeitraum nicht (BAG 9 AZR 315/17).
create table app.employee_rest_periods (
  id uuid primary key,
  employee_id uuid not null references app.employees (id),
  start_date date not null,
  end_date date not null check (end_date >= start_date),
  reason text,
  absence_id uuid references app.absences (id) on delete set null,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index employee_rest_periods_emp on app.employee_rest_periods (employee_id, start_date);
alter table app.employee_rest_periods enable row level security;
create policy employee_rest_periods_read on app.employee_rest_periods for select to authenticated
  using ((select app.is_hr()) or (select app.is_office()));
