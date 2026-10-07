-- Runde 23 (Ahmed): App für Objektleitung umfangreicher.
-- 1) Personalbogen zum Selbstausfüllen in der eigenen Sprache (am Handy der Objektleitung). Enthält vertrauliche
--    Daten (Steuer-ID, SV-Nr., IBAN) → lesen nur Admin/Personal (RLS), die Objektleitung kann nur absenden.
create table app.personnel_forms (
  id uuid primary key,
  lang text not null,
  site_id uuid references app.sites (id),
  data jsonb not null,
  status text not null default 'neu' check (status in ('neu', 'uebernommen', 'verworfen')),
  employee_id uuid references app.employees (id),
  created_by text not null,
  created_at timestamptz not null default now(),
  decided_by text,
  decided_at timestamptz
);
alter table app.personnel_forms enable row level security;
create policy personnel_forms_hr on app.personnel_forms for select to authenticated using ((select app.is_hr()));
grant select on app.personnel_forms to authenticated;
grant all on app.personnel_forms to service_role;

-- 2) Nachunternehmer-Auftrag von der Objektleitung anfragen → Büro prüft und erteilt (Entwurf + angefragt von).
alter table app.subcontracts
  add column requested_by text,
  add column request_note text;
