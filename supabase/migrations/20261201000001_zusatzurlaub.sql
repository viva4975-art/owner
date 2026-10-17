-- Ahmed 17.10.: zusätzlichen Urlaub je Mitarbeiter und Jahr eintragen (z. B. Schwerbehinderung § 208 SGB IX,
-- Vereinbarung, Ausgleich). Kommt zum automatisch gerechneten Anspruch (30 Tage RTV × Arbeitstage ÷ 5) dazu.
create table app.leave_extra (
  id uuid primary key,
  employee_id uuid not null references app.employees (id),
  year integer not null check (year between 2000 and 2100),
  days numeric(5, 1) not null check (days <> 0 and days between -60 and 60 and days * 2 = round(days * 2)),
  reason text not null check (length(trim(reason)) > 0),
  created_by text not null,
  created_at timestamptz not null default now()
);
create index leave_extra_emp on app.leave_extra (employee_id, year);
alter table app.leave_extra enable row level security;
create policy leave_extra_read on app.leave_extra for select to authenticated
  using ((select app.is_hr()) or (select app.is_office()));
