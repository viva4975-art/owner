-- Phase 2 (Teil 1): Versionen gegen Überschreiben aus zweitem Tab, Kontakte, Notizen, Aufgaben,
-- Zahlungseingänge / Offene Posten, Personal-Stammdaten.

-- ---------------------------------------------------------------------------
-- Versionszähler (optimistisches Sperren): jede Änderung erhöht `version`.
-- Ein Formular schickt die Version mit, die es geladen hat; passt sie nicht mehr,
-- wurde der Datensatz zwischenzeitlich (anderer Tab/Benutzer) geändert.
-- ---------------------------------------------------------------------------

create or replace function app.bump_version() returns trigger
language plpgsql as $$
begin
  new.version := old.version + 1;
  return new;
end $$;

alter table app.customers add column version integer not null default 1;
alter table app.sites add column version integer not null default 1;
alter table app.invoices add column version integer not null default 1;
alter table app.site_services add column version integer not null default 1;

create trigger customers_version before update on app.customers for each row execute function app.bump_version();
create trigger sites_version before update on app.sites for each row execute function app.bump_version();
create trigger invoices_version before update on app.invoices for each row execute function app.bump_version();
create trigger site_services_version before update on app.site_services for each row execute function app.bump_version();

-- ---------------------------------------------------------------------------
-- Kontakte (mehrere je Kunde, wie Fortytools)
-- ---------------------------------------------------------------------------

create table app.contacts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references app.customers (id),
  salutation text,
  first_name text,
  last_name text not null,
  position text,
  email text,
  phone text,
  mobile text,
  invoice_recipient boolean not null default false,
  notes text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on app.contacts (customer_id);
create trigger contacts_version before update on app.contacts for each row execute function app.bump_version();

-- ---------------------------------------------------------------------------
-- Notizen und Aufgaben (an Kunde, Objekt, Mitarbeiter oder Rechnung)
-- ---------------------------------------------------------------------------

create type app.entity_type as enum ('customer', 'site', 'employee', 'invoice');

create table app.notes (
  id uuid primary key default gen_random_uuid(),
  entity_type app.entity_type not null,
  entity_id uuid not null,
  body text not null check (length(trim(body)) > 0),
  author text not null,
  created_at timestamptz not null default now()
);
create index on app.notes (entity_type, entity_id);

create type app.task_status as enum ('open', 'done');

create table app.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) > 0),
  description text,
  due_date date,
  assignee text,
  status app.task_status not null default 'open',
  entity_type app.entity_type,
  entity_id uuid,
  created_by text not null,
  created_at timestamptz not null default now(),
  done_at timestamptz,
  done_by text,
  version integer not null default 1,
  check ((entity_type is null) = (entity_id is null))
);
create index on app.tasks (status, due_date);
create index on app.tasks (entity_type, entity_id);
create trigger tasks_version before update on app.tasks for each row execute function app.bump_version();

-- ---------------------------------------------------------------------------
-- Zahlungseingänge (Grundlage Offene Posten / Mahnwesen)
-- Buchungen sind unveränderbar; Fehler werden durch Gegenbuchung korrigiert (GoBD).
-- ---------------------------------------------------------------------------

create type app.payment_method as enum ('ueberweisung', 'lastschrift', 'bar', 'skonto', 'verrechnung', 'korrektur');

create table app.payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references app.invoices (id),
  amount_cents bigint not null check (amount_cents <> 0),
  paid_on date not null,
  method app.payment_method not null default 'ueberweisung',
  reference text,
  note text,
  reverses_payment_id uuid references app.payments (id),
  created_by text not null,
  created_at timestamptz not null default now(),
  check (method <> 'korrektur' or reverses_payment_id is not null)
);
create index on app.payments (invoice_id);
create unique index payments_reversed_once on app.payments (reverses_payment_id) where reverses_payment_id is not null;
create trigger payments_append_only before update or delete on app.payments
for each row execute function app.deny_change();

create or replace function app.guard_payment() returns trigger
language plpgsql as $$
declare
  v_status app.invoice_status;
  v_kind app.invoice_kind;
begin
  select status, kind into v_status, v_kind from app.invoices where id = new.invoice_id;
  if v_status is distinct from 'issued' then
    raise exception 'Zahlungen nur auf ausgestellte Rechnungen' using errcode = 'check_violation';
  end if;
  if v_kind in ('cancellation', 'correction') then
    raise exception 'Zahlungen bitte auf die Originalrechnung buchen' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger payments_guard before insert on app.payments for each row execute function app.guard_payment();

-- Offene Posten je Rechnung: Zahlbetrag + verknüpfte Storno-/Korrekturbelege − Zahlungen.
create or replace view app.open_items with (security_invoker = true) as
select
  i.id as invoice_id,
  i.number,
  i.kind,
  i.customer_id,
  i.site_id,
  i.issue_date,
  i.due_date,
  i.skonto_date,
  i.payable_cents,
  coalesce((select sum(d.payable_cents) from app.invoices d
             where d.original_invoice_id = i.id and d.status = 'issued'), 0)::bigint as adjustments_cents,
  coalesce((select sum(p.amount_cents) from app.payments p where p.invoice_id = i.id), 0)::bigint as paid_cents,
  (i.payable_cents
    + coalesce((select sum(d.payable_cents) from app.invoices d
                 where d.original_invoice_id = i.id and d.status = 'issued'), 0)
    - coalesce((select sum(p.amount_cents) from app.payments p where p.invoice_id = i.id), 0))::bigint as open_cents
from app.invoices i
where i.status = 'issued' and i.kind in ('invoice', 'partial', 'final');

-- ---------------------------------------------------------------------------
-- Personal: Stammdaten (Büro) und vertrauliche Daten (nur Admin/Personal, DSGVO)
-- ---------------------------------------------------------------------------

alter type app.user_role add value if not exists 'personal';

create type app.employment_type as enum ('vollzeit', 'teilzeit', 'minijob', 'werkstudent', 'aushilfe');
create type app.employee_status as enum ('aktiv', 'ausgetreten');

create table app.employees (
  id uuid primary key default gen_random_uuid(),
  personnel_no text not null unique,
  first_name text not null,
  last_name text not null,
  status app.employee_status not null default 'aktiv',
  employment_type app.employment_type not null default 'teilzeit',
  entry_date date not null,
  exit_date date,
  weekly_hours numeric(5, 2) check (weekly_hours is null or weekly_hours between 0 and 60),
  hourly_wage_cents bigint check (hourly_wage_cents is null or hourly_wage_cents > 0),
  phone text,
  email text,
  languages text[] not null default '{}',
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (exit_date is null or exit_date >= entry_date),
  check (status = 'aktiv' or exit_date is not null)
);
create trigger employees_version before update on app.employees for each row execute function app.bump_version();

create table app.employee_private (
  employee_id uuid primary key references app.employees (id) on delete cascade,
  birth_date date,
  street text,
  postal_code text,
  city text,
  nationality text,
  tax_id text check (tax_id is null or tax_id ~ '^[0-9]{11}$'),
  social_security_no text,
  health_insurance text,
  iban text,
  residence_permit_until date,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);
create trigger employee_private_version before update on app.employee_private for each row execute function app.bump_version();

-- Zuordnung Mitarbeiter ↔ Objekt (Grundlage für Einsatzplanung/Zeiterfassung)
create table app.employee_sites (
  employee_id uuid not null references app.employees (id) on delete cascade,
  site_id uuid not null references app.sites (id),
  primary key (employee_id, site_id)
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

create or replace function app.is_hr() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select role::text in ('admin', 'personal') from app.profiles where user_id = auth.uid()), false)
$$;

alter table app.contacts enable row level security;
alter table app.notes enable row level security;
alter table app.tasks enable row level security;
alter table app.payments enable row level security;
alter table app.employees enable row level security;
alter table app.employee_private enable row level security;
alter table app.employee_sites enable row level security;

create policy contacts_office on app.contacts for select to authenticated using ((select app.is_office()));
create policy notes_office on app.notes for select to authenticated using ((select app.is_office()));
create policy tasks_office on app.tasks for select to authenticated using ((select app.is_office()));
create policy payments_office on app.payments for select to authenticated using ((select app.is_office()));
create policy employees_office on app.employees for select to authenticated
  using ((select app.is_office()) or (select app.is_hr()));
create policy employee_private_hr on app.employee_private for select to authenticated using ((select app.is_hr()));
create policy employee_sites_read on app.employee_sites for select to authenticated
  using ((select app.is_office()) or (select app.is_hr())
         or site_id in (select id from app.sites where manager_user_id = (select auth.uid())));

grant select on app.contacts, app.notes, app.tasks, app.payments, app.employees, app.employee_private,
  app.employee_sites, app.open_items to authenticated;
grant all on app.contacts, app.notes, app.tasks, app.payments, app.employees, app.employee_private,
  app.employee_sites, app.open_items to service_role;
