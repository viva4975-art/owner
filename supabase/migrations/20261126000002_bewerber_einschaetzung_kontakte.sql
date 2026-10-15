-- Bewerber: interne Einschätzung (Farbe) und Kontaktverlauf (Ahmed 15.10.2026)
alter table app.applicants add column if not exists rating text
  check (rating is null or rating in ('gut', 'mittel', 'schlecht'));

-- neuer Status „Hat etwas gefunden“ (beim Anruf erfahren, dass die Person anderweitig untergekommen ist)
alter table app.applicants drop constraint if exists applicants_status_check;
alter table app.applicants add constraint applicants_status_check
  check (status in ('Neu', 'In Prüfung', 'Gespräch', 'Eingestellt', 'Abgelehnt', 'Hat etwas gefunden'));

create table app.applicant_contacts (
  id uuid primary key,
  applicant_id uuid not null references app.applicants (id) on delete cascade,
  contact_on date not null,
  kind text not null check (kind in ('anruf', 'whatsapp', 'email', 'sms', 'gespraech', 'notiz')),
  result text check (result is null or result in
    ('erreicht', 'nicht_erreicht', 'rueckruf', 'termin', 'gefunden', 'kein_interesse', 'interessiert')),
  note text,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index on app.applicant_contacts (applicant_id, contact_on desc);
alter table app.applicant_contacts enable row level security;
create policy applicant_contacts_hr on app.applicant_contacts for all to authenticated
  using ((select app.is_hr())) with check ((select app.is_hr()));
