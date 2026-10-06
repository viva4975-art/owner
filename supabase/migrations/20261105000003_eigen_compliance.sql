-- Eigen-Compliance wie die alte App: eigene Nachweise (Versionen, nie gelöscht), Mehrfach-Nachweise
-- (Krankenkassen, Geschäftsführer), Checkliste der Selbstprüfung, Abschlüsse.
create table app.ec_slots (
  doc_key text not null,
  name text not null check (length(trim(name)) > 0),
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (doc_key, name)
);

create table app.ec_versions (
  id uuid primary key,
  doc_key text not null,
  slot text not null default '',                     -- '' = Einzel-Nachweis, sonst Name (z. B. „AOK“)
  file_path text not null, file_sha256 text not null, file_name text, file_type text,
  issued_on date,                                    -- ausgestellt am
  validity text not null default 'standard'          -- 'standard' | Monate ('3','6','12','24','36','60') | '0' | 'manuell'
    check (validity ~ '^(standard|manuell|\d{1,3})$'),
  expires_on date,                                   -- nur bei „manuell“
  checked_by text, checked_on date,
  uploaded_by text not null,
  uploaded_at timestamptz not null default now(),
  superseded_at timestamptz,                         -- gesetzt = Archiv (frühere Version)
  legacy_id text unique,
  version integer not null default 1
);
create unique index ec_versions_current on app.ec_versions (doc_key, slot) where superseded_at is null;
create trigger ec_versions_version before update on app.ec_versions for each row execute function app.bump_version();

-- Datei ist unveränderlich, Versionen werden nie gelöscht
create or replace function app.guard_ec_version() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Nachweise werden nicht gelöscht (Archiv)' using errcode = 'check_violation';
  end if;
  if new.file_path <> old.file_path or new.file_sha256 <> old.file_sha256 or new.doc_key <> old.doc_key
     or new.slot <> old.slot or (old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at) then
    raise exception 'Archivierter Nachweis ist unveränderlich' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger ec_versions_guard before update or delete on app.ec_versions
  for each row execute function app.guard_ec_version();

create table app.ec_checks (
  check_id text primary key,
  status text check (status in ('ja', 'nein', 'na')),
  note text,
  updated_by text not null,
  updated_at timestamptz not null default now()
);

create table app.ec_reviews (
  id bigserial primary key,
  reviewed_by text not null,
  reviewed_at timestamptz not null default now(),
  result jsonb not null
);
create trigger ec_reviews_append_only before update or delete on app.ec_reviews
  for each row execute function app.guard_append_only();

alter table app.ec_slots enable row level security;
alter table app.ec_versions enable row level security;
alter table app.ec_checks enable row level security;
alter table app.ec_reviews enable row level security;
create policy ec_slots_office on app.ec_slots for all to authenticated using ((select app.is_office())) with check ((select app.is_office()));
create policy ec_versions_office on app.ec_versions for all to authenticated using ((select app.is_office())) with check ((select app.is_office()));
create policy ec_checks_office on app.ec_checks for all to authenticated using ((select app.is_office())) with check ((select app.is_office()));
create policy ec_reviews_office on app.ec_reviews for all to authenticated using ((select app.is_office())) with check ((select app.is_office()));
