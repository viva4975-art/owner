-- Stundennachweis zu Nachunternehmer-Bestellungen mit Abrechnung „je Stunde“ (Ahmed 09.10.): je Tag wie viele Leute
-- wie viele Stunden gearbeitet haben. Grundlage für die Prüfung der NU-Rechnung und die Schätzung in der
-- Nachkalkulation, solange die Rechnung fehlt. Minuten je Person als ganze Zahl (kein Gleitkomma).
create table app.subcontract_hours (
  id uuid primary key,
  subcontract_id uuid not null references app.subcontracts (id) on delete cascade,
  work_date date not null,
  persons integer not null check (persons between 1 and 200),
  minutes_per_person integer not null check (minutes_per_person between 1 and 1440),
  note text,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index on app.subcontract_hours (subcontract_id, work_date);

alter table app.subcontract_hours enable row level security;
create policy subcontract_hours_office on app.subcontract_hours for select to authenticated
  using ((select app.is_office()));
