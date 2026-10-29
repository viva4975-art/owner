-- Einsätze enden automatisch zum Austritt (Ahmed 29.10.): Beim Erfassen/Ändern eines Austritts werden laufende
-- Einsätze zum Austrittstag beendet, Einsätze, die erst danach beginnen, werden wieder offen („zu planen“).
-- Hier steht der vorige Stand, damit eine spätere Änderung oder Rücknahme des Austritts ihn wiederherstellen kann.
create table app.shift_exit_changes (
  shift_plan_id uuid primary key references app.shift_plans (id) on delete cascade,
  employee_id uuid not null references app.employees (id) on delete cascade,
  kind text not null check (kind in ('beendet', 'offen')),
  exit_date date not null,
  old_valid_until date,
  created_at timestamptz not null default now()
);
create index shift_exit_changes_emp on app.shift_exit_changes (employee_id);
alter table app.shift_exit_changes enable row level security;
create policy shift_exit_changes_read on app.shift_exit_changes for select to authenticated using (true);
grant select on app.shift_exit_changes to authenticated;
grant all on app.shift_exit_changes to service_role;
