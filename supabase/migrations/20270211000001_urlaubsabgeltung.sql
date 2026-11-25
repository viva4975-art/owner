-- Ahmed 25.11.: Urlaubsabgeltung (§ 7 Abs. 4 BUrlG) – nicht genommener Urlaub wird bei Austritt ausgezahlt.
-- Tage × Stunden je Tag im Abrechnungsmonat als Lohnart „Urlaubsabgeltung“, Kosten auf das gewählte Objekt.
create table app.leave_payouts (
  id uuid primary key,
  employee_id uuid not null references app.employees (id),
  leave_year integer not null check (leave_year between 2000 and 2100),
  payout_month text not null check (payout_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  days numeric(5, 2) not null check (days > 0 and days <= 60 and days * 2 = round(days * 2)),
  minutes_per_day integer not null check (minutes_per_day between 1 and 1440),
  site_id uuid references app.sites (id),
  note text,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index leave_payouts_emp on app.leave_payouts (employee_id, leave_year);
create index leave_payouts_month on app.leave_payouts (payout_month);
alter table app.leave_payouts enable row level security;
create policy leave_payouts_read on app.leave_payouts for select to authenticated
  using ((select app.is_hr()) or (select app.is_office()));
