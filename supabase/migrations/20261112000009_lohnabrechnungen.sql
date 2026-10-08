-- Lohnabrechnungen aus Lexware (ZIP mit Einzel-PDFs oder eine Sammel-PDF) je Mitarbeiter in die Personalakte;
-- optional in der Mitarbeiter-App sichtbar (§ 108 GewO: Textform – digitales Postfach genügt, BAG 28.01.2025 9 AZR 48/24).
create table app.payslips (
  file_id uuid primary key references app.files (id),
  employee_id uuid not null references app.employees (id),
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  released boolean not null default false,
  viewed_at timestamptz,
  imported_by text not null,
  imported_at timestamptz not null default now()
);
create index on app.payslips (employee_id, month);
alter table app.payslips enable row level security;
create policy payslips_hr on app.payslips for select to authenticated using ((select app.is_hr()));
