-- Lohnabrechnungen per E-Mail (Ahmed 05.11.): Personen auswählen, PDF mit Passwort = Geburtsdatum TTMMJJ, Absender
-- buchhaltung@. Je Abrechnung genau ein Versand (feste ID); erneut senden nur ausdrücklich (neue ID). Das Passwort
-- wird nie gespeichert.
create table app.payslip_mails (
  id uuid primary key,
  file_id uuid not null references app.payslips (file_id),
  employee_id uuid not null references app.employees (id),
  month text not null,
  sent_to text,
  status text not null default 'laeuft' check (status in ('laeuft', 'gesendet', 'fehler')),
  error text,
  sent_by text not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index on app.payslip_mails (file_id);
alter table app.payslip_mails enable row level security;
create policy payslip_mails_hr on app.payslip_mails for select to authenticated using ((select app.is_hr()));
