-- Ahmed 18.10.: Arbeitsschein einer Person (Vorarbeiter/Reinigungskraft) zum Unterschreiben-Lassen zuweisen – erscheint
-- direkt in deren App. Leer = wie bisher alle eingesetzten Mitarbeitenden (employee_ids).
alter table app.work_reports
  add column if not exists sign_employee_ids uuid[] not null default '{}',
  add column if not exists sign_assigned_at timestamptz,
  add column if not exists sign_assigned_by text;
