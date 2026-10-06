-- Akquise wie die alte App: Pipeline mit Wiedervorlage und Aktivitäten
create table app.prospects (
  id uuid primary key,
  company text not null check (length(trim(company)) > 0),
  contact text, phone text, email text, city text,
  source text,                                       -- Quelle (Kaltakquise, Empfehlung …)
  object text,                                       -- Was soll gereinigt werden?
  status text not null default 'erstkontakt'
    check (status in ('erstkontakt', 'interesse_stark', 'interesse_leicht', 'kein_interesse', 'gewonnen', 'verloren')),
  followup_on date,
  followup_reason text,
  legacy_id text unique,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  version integer not null default 1
);
create index on app.prospects (followup_on);
create trigger prospects_version before update on app.prospects for each row execute function app.bump_version();

create table app.prospect_activities (
  id uuid primary key,
  prospect_id uuid not null references app.prospects (id) on delete cascade,
  kind text not null check (kind in ('call_out', 'call_in', 'email', 'termin', 'angebot', 'notiz')),
  at timestamptz not null,
  note text,
  legacy_id text unique,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index on app.prospect_activities (prospect_id, at);

alter table app.prospects enable row level security;
alter table app.prospect_activities enable row level security;
create policy prospects_office on app.prospects for all to authenticated
  using ((select app.is_office())) with check ((select app.is_office()));
create policy prospect_activities_office on app.prospect_activities for all to authenticated
  using ((select app.is_office())) with check ((select app.is_office()));
