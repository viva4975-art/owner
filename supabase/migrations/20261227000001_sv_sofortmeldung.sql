-- SV-Sofortmeldung (Ahmed 26.10.): Gebäudereinigung muss jede Beschäftigung spätestens bei Arbeitsaufnahme sofort
-- an die Datenstelle der Rentenversicherung melden (§ 28a Abs. 4 SGB IV, Bußgeld bis 25.000 € § 111 SGB IV).
-- Gemeldet wird weiter über Lexware/sv.net; die App hält fest, dass und wann gemeldet wurde, und warnt.
alter table app.company add column if not exists betriebsnummer text
  check (betriebsnummer is null or betriebsnummer ~ '^[0-9]{8}$');

create table app.sv_immediate_reports (
  id uuid primary key,
  employee_id uuid not null references app.employees (id),
  -- Beschäftigungsbeginn, für den gemeldet wurde (Wiedereintritt = neue Meldung)
  entry_date date not null,
  reported_at timestamptz not null,
  transfer_no text check (transfer_no is null or length(transfer_no) <= 60),
  via text not null default 'lexware' check (via in ('lexware', 'svnet', 'steuerberater', 'sonstiges')),
  note text check (note is null or length(note) <= 500),
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (employee_id, entry_date)
);
alter table app.sv_immediate_reports enable row level security;
create policy sv_immediate_reports_read on app.sv_immediate_reports for select to authenticated
  using ((select app.is_hr()) or (select app.is_office()));
grant select on app.sv_immediate_reports to authenticated;
grant all on app.sv_immediate_reports to service_role;
