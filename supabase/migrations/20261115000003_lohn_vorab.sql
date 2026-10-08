-- Ahmed 09.10.: Löhne müssen vor Monatsende abgerechnet werden. Vorab-Export = Ist bis Stichtag + Plan bis Monatsende;
-- der exportierte Stand wird festgehalten, damit im Folgemonat die Differenz zum tatsächlichen Monat als Korrektur
-- ausgegeben werden kann. Nur anhängen.
create table app.payroll_exports (
  id uuid primary key,
  month text not null check (month ~ '^\d{4}-\d{2}$'),
  cutoff date,
  rows jsonb not null,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index payroll_exports_month_idx on app.payroll_exports (month, created_at desc);
alter table app.payroll_exports enable row level security;
create policy payroll_exports_office on app.payroll_exports for select to authenticated using ((select app.is_office()));
grant select on app.payroll_exports to authenticated;
create trigger payroll_exports_append_only before update or delete on app.payroll_exports
for each row execute function app.deny_change();
