-- Glasreinigung-Planer wie die alte App: Kunden, Objekte mit Planungsdaten, Termine (auch mehrtägig), Teams
create table app.glass_settings (
  id integer primary key default 1 check (id = 1),
  team_a_name text not null default 'Team A',
  team_b_name text not null default 'Team B'
);
insert into app.glass_settings (id) values (1) on conflict do nothing;

create table app.glass_customers (
  id uuid primary key,
  name text not null check (length(trim(name)) > 0),
  address text,
  note text,
  contacts jsonb not null default '[]',              -- [{name, rolle, telefon, email}]
  legacy_id text unique,
  created_at timestamptz not null default now(),
  version integer not null default 1
);
create trigger glass_customers_version before update on app.glass_customers for each row execute function app.bump_version();

create table app.glass_objects (
  id uuid primary key,
  customer_id uuid references app.glass_customers (id),
  name text not null check (length(trim(name)) > 0),
  address text,
  district text,
  postal_code text,
  caretaker_name text, caretaker_phone text, caretaker_email text,
  contact_name text, contact_phone text, contact_email text,
  per_year integer not null default 1 check (per_year in (1, 2, 3, 4, 6, 12)),
  parts jsonb not null default '[]',                 -- Teilbereiche [{name, per_year, hours}]
  wish_months jsonb not null default '[]',           -- je Termin mögliche Monate [[4,5],[9,10]]
  plan_year integer,
  holiday_pref text not null default 'egal' check (holiday_pref in ('egal', 'waehrend', 'ausserhalb')),
  needs_police_cert boolean not null default false,  -- Führungszeugnis
  needs_lift boolean not null default false,         -- Hebebühne
  needs_other text,
  team text check (team in ('team_a', 'team_b')),
  hours numeric(6, 2),                                -- Gesamtarbeitsstunden je Reinigung
  default_staff text,
  wishes text,                                        -- Sonderwünsche
  note text,
  active boolean not null default true,
  legacy_id text unique,
  created_at timestamptz not null default now(),
  version integer not null default 1
);
create trigger glass_objects_version before update on app.glass_objects for each row execute function app.bump_version();

create table app.glass_appointments (
  id uuid primary key,
  object_id uuid not null references app.glass_objects (id) on delete cascade,
  part text,                                          -- Teilbereich (leer = Gesamt)
  days jsonb not null,                                -- [{date, from, to}]
  first_day date not null,
  last_day date not null,
  hours numeric(6, 2),
  interval text not null default 'einmalig',
  team text check (team in ('team_a', 'team_b')),
  staff text,
  note text,
  confirmed boolean not null default false,
  confirm_note text,
  done boolean not null default false,
  done_at timestamptz,
  follow_up_of uuid references app.glass_appointments (id),
  legacy_id text unique,
  created_by text not null,
  created_at timestamptz not null default now(),
  version integer not null default 1
);
create index on app.glass_appointments (first_day);
create index on app.glass_appointments (object_id);
create unique index glass_appointments_follow_up on app.glass_appointments (follow_up_of) where follow_up_of is not null;
create trigger glass_appointments_version before update on app.glass_appointments for each row execute function app.bump_version();

do $$
declare t text;
begin
  foreach t in array array['glass_settings', 'glass_customers', 'glass_objects', 'glass_appointments'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('create policy %I on app.%I for all to authenticated using ((select app.is_office())) with check ((select app.is_office()))', t || '_office', t);
  end loop;
end $$;
