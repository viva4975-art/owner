-- Import aus Fortytools (CSV-Exporte): Protokoll je Übernahme, Datei write-once im Archiv.
create table app.data_imports (
  id uuid primary key,
  kind text not null check (kind in ('kunden', 'objekte', 'leistungen')),
  filename text not null,
  file_path text not null,
  file_sha256 text not null,
  update_existing boolean not null default false,
  row_count integer not null,
  created_count integer not null,
  updated_count integer not null,
  skipped_count integer not null,
  error_count integer not null,
  errors jsonb not null default '[]'::jsonb,
  created_by text not null,
  created_at timestamptz not null default now()
);
alter table app.data_imports enable row level security;
create policy data_imports_office on app.data_imports for select to authenticated using ((select app.is_office()));
grant select on app.data_imports to authenticated;
grant all on app.data_imports to service_role;
