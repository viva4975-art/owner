-- NUR für lokale Entwicklung/Tests auf reinem Postgres.
-- Bildet die Teile von Supabase nach, die unsere Migrationen voraussetzen
-- (Rollen, auth.uid(), auth.jwt()). In Supabase selbst existiert all das bereits
-- und diese Datei wird NICHT ausgeführt.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text
);

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

-- Wie in Supabase: angemeldete Rollen dürfen auth.uid()/auth.jwt() aufrufen.
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
