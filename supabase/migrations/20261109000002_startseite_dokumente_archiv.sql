-- Startseite je Benutzer anpassbar (Karten ein-/ausblenden, Spalte, Reihenfolge)
create table app.user_prefs (
  user_id uuid primary key,
  dashboard jsonb,
  updated_at timestamptz not null default now()
);
alter table app.user_prefs enable row level security;
create policy user_prefs_own on app.user_prefs for select to authenticated using (user_id = (select auth.uid()));
grant select on app.user_prefs to authenticated;
grant all on app.user_prefs to service_role;

-- Personalakte: ältere Fassungen ins Archiv (bleiben abrufbar, vorne nur die aktuellen Unterlagen)
alter table app.file_links add column if not exists archived_at timestamptz;
alter table app.file_links add column if not exists archived_by text;
