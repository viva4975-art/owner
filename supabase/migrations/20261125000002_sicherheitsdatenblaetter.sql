-- Sicherheitsdatenblätter der eingesetzten Reinigungsmittel (Ahmed 14.10.): firmenweit hochgeladen, liegen in jedem
-- Objektordner (§ 14 GefStoffV: für die Beschäftigten zugänglich). PDF write-once im Archiv; neue Fassung ersetzt die
-- alte (alte bleibt mit replaced_at erhalten), „entfernen“ setzt nur active = false.
create table app.safety_data_sheets (
  id uuid primary key,
  product text not null check (length(trim(product)) between 1 and 200),
  manufacturer text,
  issued_on date,
  storage_path text not null,
  sha256 text not null,
  file_name text not null,
  uploaded_by text not null,
  uploaded_at timestamptz not null default now(),
  active boolean not null default true,
  replaced_at timestamptz
);
create index on app.safety_data_sheets (active, product);

alter table app.safety_data_sheets enable row level security;
create policy safety_data_sheets_read on app.safety_data_sheets for select to authenticated using (true);
grant select on app.safety_data_sheets to authenticated;
grant all on app.safety_data_sheets to service_role;
