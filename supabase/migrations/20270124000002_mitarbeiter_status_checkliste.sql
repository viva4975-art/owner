-- Neue Oberfläche (Ahmed 13.11.2026): Status je Mitarbeiter wie Blink und Checklisten für Ein- und Austritt.
-- Nur ergänzt: employees.status (aktiv/ausgetreten) bleibt maßgeblich für Planung, Lohn und App.
alter table app.employees add column if not exists hr_stage text
  check (hr_stage in ('bewerber', 'einstellung', 'vertrag', 'aktiv', 'ruhend', 'gekuendigt', 'freigestellt'));

create table if not exists app.employee_checklist (
  employee_id uuid not null references app.employees (id) on delete cascade,
  key text not null,                -- feste Schlüssel (z. B. 'sofortmeldung') oder 'eigen:<uuid>'
  phase text not null check (phase in ('ein', 'aus')),
  label text check (label is null or length(label) between 1 and 200),
  done_at timestamptz,
  done_by text,
  created_by text not null,
  created_at timestamptz not null default now(),
  primary key (employee_id, key)
);
alter table app.employee_checklist enable row level security;
create policy employee_checklist_hr on app.employee_checklist for select to authenticated
  using ((select app.is_hr()));
grant select on app.employee_checklist to authenticated;
grant all on app.employee_checklist to service_role;
