-- Schlüsselübergabeprotokolle aus der App (Ahmed 20.10.): aktuelle Liste der Schlüssel eines Mitarbeiters als PDF zum
-- Unterschreiben. Jeder Stand wird festgehalten (nur anhängen, Datei write-once) – nicht unter Dokumente, dort liegt nur
-- die unterschriebene Fassung.
create table app.key_protocols (
  id uuid primary key,
  protocol_no text not null unique,
  employee_id uuid not null references app.employees (id),
  protocol_date date not null,
  items jsonb not null,
  file_id uuid not null references app.files (id),
  created_by text not null,
  created_at timestamptz not null default now()
);
create index on app.key_protocols (employee_id, created_at desc);

create trigger key_protocols_append_only before update or delete on app.key_protocols
for each row execute function app.deny_change();

alter table app.key_protocols enable row level security;
create policy key_protocols_office on app.key_protocols for select to authenticated
  using ((select app.is_office()));
grant select on app.key_protocols to authenticated;
grant all on app.key_protocols to service_role;
