-- Verbandbuch je Mitarbeiter (Ahmed 19.10.; DGUV Vorschrift 1 § 24 Abs. 6): jede Erste-Hilfe-Leistung dokumentieren,
-- 5 Jahre aufbewahren. Gesundheitsdaten (Art. 9 DSGVO) → lesen nur Admin/Personal und die Objektleitung des Objekts.
-- Änderungen mit altem Stand im audit_log; gelöscht wird nur über app.purge (Admin, Protokoll).
create table app.first_aid_entries (
  id uuid primary key,
  employee_id uuid not null references app.employees (id),
  site_id uuid references app.sites (id),
  occurred_at timestamptz not null,
  place text,
  what_happened text not null,
  injury text not null,
  measures text not null,
  first_aider text,
  witnesses text,
  doctor boolean not null default false,
  lost_days boolean not null default false,
  note text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz,
  version int not null default 1
);
create index on app.first_aid_entries (employee_id, occurred_at desc);
create index on app.first_aid_entries (site_id);
create trigger first_aid_entries_version before update on app.first_aid_entries for each row execute function app.bump_version();
alter table app.first_aid_entries enable row level security;
create policy first_aid_entries_read on app.first_aid_entries for select to authenticated
  using ((select app.is_hr()) or site_id in (select id from app.sites where manager_user_id = (select auth.uid())));
grant select on app.first_aid_entries to authenticated;
grant all on app.first_aid_entries to service_role;
