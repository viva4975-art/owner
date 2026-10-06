-- Bewerber + Stellenanzeigen wie die alte App (einheitliches Vokabular für Art/Arbeitszeit → Matching funktioniert)
create table app.applicants (
  id uuid primary key,
  name text not null check (length(trim(name)) > 0),
  phone text, email text, postal_code text, city text,
  language text,
  job_type text,                -- Reinigungskraft, Glasreiniger, Hausmeister, Bürokraft, Vorarbeiter / Objektleitung, Fahrer
  hours integer check (hours is null or hours between 1 and 80),
  time_of_day text,             -- morgens, tagsüber, nachmittags, abends, nachts, flexibel
  experience text check (experience is null or experience in ('keine', 'wenig', 'mittel', 'viel')),
  available text,
  driving_licence boolean,
  note text,
  status text not null default 'Neu'
    check (status in ('Neu', 'In Prüfung', 'Gespräch', 'Eingestellt', 'Abgelehnt')),
  status_changed_at timestamptz not null default now(),
  legacy_id text unique,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  version integer not null default 1
);
create trigger applicants_version before update on app.applicants for each row execute function app.bump_version();

-- Unterlagen in der Datenbank (nicht im write-once-Archiv), damit sie nach DSGVO wirklich gelöscht werden können
create table app.applicant_documents (
  id uuid primary key,
  applicant_id uuid not null references app.applicants (id) on delete cascade,
  name text not null,
  content_type text not null,
  size_bytes integer not null,
  sha256 text not null,
  content bytea not null,
  uploaded_by text not null,
  uploaded_at timestamptz not null default now()
);
create index on app.applicant_documents (applicant_id);

create table app.job_postings (
  id uuid primary key,
  title text not null check (length(trim(title)) > 0),
  job_type text,
  object_type text,
  hours integer check (hours is null or hours between 1 and 60),
  wage_cents bigint check (wage_cents is null or wage_cents >= 0),
  time_of_day text,
  city text, postal_code text, street text,
  start_on date,                 -- leer = sofort
  language text,
  tasks text, requirements text,
  workdays jsonb not null default '{}',
  website boolean not null default false,
  status text not null default 'aktiv' check (status in ('aktiv', 'geschlossen')),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  version integer not null default 1
);
create trigger job_postings_version before update on app.job_postings for each row execute function app.bump_version();

alter table app.company add column if not exists job_whatsapp text;

alter table app.applicants enable row level security;
alter table app.applicant_documents enable row level security;
alter table app.job_postings enable row level security;
create policy applicants_hr on app.applicants for all to authenticated
  using ((select app.is_hr())) with check ((select app.is_hr()));
create policy applicant_documents_hr on app.applicant_documents for all to authenticated
  using ((select app.is_hr())) with check ((select app.is_hr()));
create policy job_postings_hr on app.job_postings for all to authenticated
  using ((select app.is_hr())) with check ((select app.is_hr()));
