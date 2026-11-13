-- Qualifikationen je Mitarbeiter (Ahmed 13.11., Vorbild Blink): z. B. Führerschein, Hebebühne, Ersthelfer,
-- Hygieneschulung, Führungszeugnis (nur „liegt vor“, kein Inhalt). Ablaufdatum optional → Hinweis im Eingang.
create table if not exists app.employee_qualifications (
  id uuid primary key,
  employee_id uuid not null references app.employees (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  valid_until date,
  note text check (note is null or length(note) <= 300),
  created_by text not null,
  created_at timestamptz not null default now()
);
create index if not exists employee_qualifications_emp on app.employee_qualifications (employee_id);
alter table app.employee_qualifications enable row level security;
create policy employee_qualifications_hr on app.employee_qualifications for select to authenticated
  using ((select app.is_hr()));
grant select on app.employee_qualifications to authenticated;
grant all on app.employee_qualifications to service_role;
