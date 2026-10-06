-- Tiefgaragenplanung wie die alte App (Münchner Wohnen / Dawonia): Objekte, Termine, Aushänge, Arbeitsscheine
create table app.tg_objects (
  id uuid primary key,
  customer text not null default 'Münchner Wohnen GmbH',
  name text not null check (length(trim(name)) > 0),
  address text, postal_code text, city text,
  sqm integer,                          -- m² (Münchner Wohnen)
  we_no text,                           -- WE-Nr. (Dawonia)
  spaces_fixed integer, spaces_duplex integer,
  duration text,                        -- „4 Std.“, „1 Tag“, „1/2 Tag“
  tob_name text, tob_email text, deputy_email text, tob_mobile text,
  owner_company text,                   -- Besitzgesellschaft (Dawonia)
  object_no text,
  site_id uuid references app.sites (id),  -- Verknüpfung für Arbeitsschein/Abrechnung
  active boolean not null default true,
  paused boolean not null default false,   -- dieses Jahr nicht reinigen
  legacy_id text unique,
  created_at timestamptz not null default now(),
  version integer not null default 1
);
create trigger tg_objects_version before update on app.tg_objects for each row execute function app.bump_version();

create table app.tg_appointments (
  id uuid primary key,
  object_id uuid not null references app.tg_objects (id) on delete cascade,
  days jsonb not null,                  -- [{date, from, to}]
  first_day date not null,
  last_day date not null,
  kind text not null default 'Nassreinigung' check (kind in ('Nassreinigung', 'Kehren', 'Grundreinigung', 'Sonstige')),
  note text,
  confirmed boolean not null default false,
  done boolean not null default false,
  work_report_id uuid references app.work_reports (id),
  legacy_id text unique,
  created_by text not null,
  created_at timestamptz not null default now(),
  version integer not null default 1
);
create index on app.tg_appointments (first_day);
create trigger tg_appointments_version before update on app.tg_appointments for each row execute function app.bump_version();

do $$
declare t text;
begin
  foreach t in array array['tg_objects', 'tg_appointments'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('create policy %I on app.%I for all to authenticated using ((select app.is_office())) with check ((select app.is_office()))', t || '_office', t);
  end loop;
end $$;
