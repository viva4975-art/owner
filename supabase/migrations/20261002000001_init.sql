-- Viva-Deluxe Betriebs-App – Grundschema (Prototyp)
-- Läuft unverändert auf Supabase (Frankfurt) und lokal (mit supabase/local/00_supabase_shim.sql).
--
-- Grundsätze:
--   * Beträge: bigint in Cent. Mengen: bigint in Tausendsteln. Steuersätze: Basispunkte (19 % = 1900).
--   * RLS auf allen Tabellen. Policies rufen Funktionen immer als (select fn()) auf.
--   * Ausgestellte Rechnungen sind unveränderbar (Trigger). Nummern lückenlos (Zähler mit Zeilensperre).
--   * Geschäftslogik (Ausstellen, Nummernvergabe, Archiv, Versand) läuft serverseitig mit service_role.

create extension if not exists pgcrypto;

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Benutzer & Rechte
-- ---------------------------------------------------------------------------

create type app.user_role as enum ('admin', 'buchhaltung', 'objektleitung');

create table app.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  role app.user_role not null default 'objektleitung',
  created_at timestamptz not null default now()
);

create or replace function app.current_role() returns app.user_role
language sql stable security definer set search_path = '' as $$
  select role from app.profiles where user_id = auth.uid()
$$;

create or replace function app.is_office() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select role in ('admin', 'buchhaltung') from app.profiles where user_id = auth.uid()), false)
$$;

-- ---------------------------------------------------------------------------
-- Stammdaten: eigene Firma (Rechnungssteller)
-- ---------------------------------------------------------------------------

create table app.company (
  id smallint primary key default 1 check (id = 1),
  legal_name text not null,
  street text not null,
  postal_code text not null,
  city text not null,
  country_code char(2) not null default 'DE',
  vat_id text,
  tax_number text,
  register_court text,
  register_number text,
  managing_director text,
  phone text,
  email text not null,
  website text,
  bank_accounts jsonb not null default '[]'::jsonb, -- [{name, iban, bic, primary}]
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Kunden
-- ---------------------------------------------------------------------------

create type app.invoice_format as enum ('pdf', 'zugferd', 'xrechnung');

create table app.customers (
  id uuid primary key default gen_random_uuid(),
  customer_no text not null unique,
  name text not null,
  name2 text,
  street text not null,
  postal_code text not null,
  city text not null,
  country_code char(2) not null default 'DE',
  vat_id text,
  is_public_authority boolean not null default false,
  leitweg_id text,
  supplier_no text, -- unsere Lieferantennummer beim Kunden
  invoice_emails text[] not null default '{}',
  invoice_format app.invoice_format not null default 'pdf',
  payment_terms_days integer not null default 30 check (payment_terms_days between 0 and 365),
  contact_name text,
  contact_phone text,
  contact_email text,
  notes text,
  active boolean not null default true,
  external_ref text unique, -- z. B. Fortytools-ID beim Import
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leitweg_required_for_xrechnung check (invoice_format <> 'xrechnung' or leitweg_id is not null),
  constraint leitweg_format check (leitweg_id is null or leitweg_id ~ '^[0-9]{2,12}(-[0-9A-Za-z]{1,30})?-[0-9]{2}$')
);

-- ---------------------------------------------------------------------------
-- Objekte & Leistungen
-- ---------------------------------------------------------------------------

create table app.sites (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references app.customers (id),
  site_no text not null unique,
  name text not null,
  street text,
  postal_code text,
  city text,
  order_reference text, -- Bestell-/Auftragsnummer des Kunden
  contract_reference text,
  manager_user_id uuid references auth.users (id), -- Objektleitung (spätere Rechte je Objekt)
  active boolean not null default true,
  external_ref text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on app.sites (customer_id);

create type app.service_kind as enum ('monthly_flat', 'special', 'hourly');

create table app.site_services (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references app.sites (id),
  kind app.service_kind not null,
  description text not null,
  unit_code text not null default 'C62', -- UN/ECE Rec 20: C62 Stück, HUR Stunde, MON Monat, MTK m²
  quantity_milli bigint not null default 1000 check (quantity_milli > 0),
  unit_price_cents bigint not null,
  vat_rate_bp integer not null default 1900 check (vat_rate_bp between 0 and 10000),
  valid_from date not null default current_date,
  valid_to date,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from)
);
create index on app.site_services (site_id);

-- ---------------------------------------------------------------------------
-- Ausgangsrechnungen
-- ---------------------------------------------------------------------------

create type app.invoice_kind as enum (
  'invoice',       -- Rechnung
  'partial',       -- Abschlagsrechnung
  'final',         -- Schlussrechnung (verrechnet Abschläge)
  'cancellation',  -- Stornorechnung (hebt Original vollständig auf)
  'correction'     -- Rechnungskorrektur (Teilbeträge)
);
create type app.invoice_status as enum ('draft', 'issued');

create table app.invoice_number_counters (
  year integer primary key,
  last_value integer not null default 0 check (last_value >= 0)
);

create table app.invoices (
  id uuid primary key default gen_random_uuid(),
  kind app.invoice_kind not null default 'invoice',
  status app.invoice_status not null default 'draft',
  number text unique,
  number_year integer,
  number_seq integer,
  customer_id uuid not null references app.customers (id),
  site_id uuid references app.sites (id),
  original_invoice_id uuid references app.invoices (id), -- Storno/Korrektur → Original
  issue_date date,
  due_date date,
  period_start date,
  period_end date,
  invoice_format app.invoice_format not null,
  buyer_reference text, -- Leitweg-ID bzw. Käuferreferenz (BT-10)
  order_reference text,
  intro_text text,
  closing_text text,
  -- Summen (werden beim Speichern serverseitig berechnet, beim Ausstellen eingefroren)
  net_cents bigint not null default 0,
  vat_cents bigint not null default 0,
  gross_cents bigint not null default 0,
  prepaid_cents bigint not null default 0, -- verrechnete Abschläge (Schlussrechnung)
  payable_cents bigint not null default 0,
  -- Eingefrorene Stammdaten zum Ausstellungszeitpunkt
  seller_snapshot jsonb,
  buyer_snapshot jsonb,
  -- Monatslauf: genau ein Entwurf je Objekt und Monat
  monthly_run_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  issued_at timestamptz,
  issued_by uuid,
  check (status = 'draft' or (number is not null and issue_date is not null and due_date is not null)),
  check (kind not in ('cancellation', 'correction') or original_invoice_id is not null),
  check (period_start is null or period_end is null or period_end >= period_start)
);
create index on app.invoices (customer_id);
create index on app.invoices (original_invoice_id);
-- Eine Rechnung kann höchstens einmal storniert werden.
create unique index invoices_one_cancellation on app.invoices (original_invoice_id) where kind = 'cancellation';

create table app.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references app.invoices (id) on delete cascade,
  position integer not null,
  description text not null,
  detail text,
  quantity_milli bigint not null,
  unit_code text not null default 'C62',
  unit_price_cents bigint not null,
  net_cents bigint not null,
  vat_rate_bp integer not null check (vat_rate_bp between 0 and 10000),
  source_service_id uuid references app.site_services (id),
  unique (invoice_id, position)
);

-- Abschlagsrechnungen, die in einer Schlussrechnung verrechnet werden
create table app.invoice_prepayments (
  final_invoice_id uuid not null references app.invoices (id) on delete cascade,
  partial_invoice_id uuid not null references app.invoices (id),
  primary key (final_invoice_id, partial_invoice_id)
);
-- Jede Abschlagsrechnung wird höchstens in einer Schlussrechnung verrechnet.
create unique index invoice_prepayments_once on app.invoice_prepayments (partial_invoice_id);

-- ---------------------------------------------------------------------------
-- Archiv (unveränderbar) & Anhänge
-- ---------------------------------------------------------------------------

create type app.document_kind as enum ('pdf', 'zugferd_pdf', 'xrechnung_xml', 'validation_report', 'attachment');

create table app.invoice_documents (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references app.invoices (id),
  kind app.document_kind not null,
  filename text not null,
  content_type text not null,
  storage_path text not null unique,
  sha256 text not null,
  size_bytes bigint not null,
  valid boolean, -- nur bei E-Rechnungen: KoSIT-Ergebnis
  retain_until date not null,
  created_at timestamptz not null default now()
);
create index on app.invoice_documents (invoice_id);

-- ---------------------------------------------------------------------------
-- Versand
-- ---------------------------------------------------------------------------

create type app.delivery_status as enum ('pending', 'sent', 'failed');

create table app.invoice_deliveries (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references app.invoices (id),
  idempotency_key text not null unique,
  status app.delivery_status not null default 'pending',
  intended_recipients text[] not null, -- Empfänger laut Kundenstamm
  actual_recipients text[] not null,   -- tatsächlich adressiert (Test: nur Testadresse)
  subject text not null,
  files jsonb not null default '[]'::jsonb, -- [{filename, sha256, size}]
  message_id text,
  error text,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index on app.invoice_deliveries (invoice_id);

-- ---------------------------------------------------------------------------
-- Änderungsprotokoll
-- ---------------------------------------------------------------------------

create table app.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text,
  action text not null,
  entity text not null,
  entity_id uuid,
  details jsonb
);
create index on app.audit_log (entity, entity_id);

-- ---------------------------------------------------------------------------
-- Unveränderbarkeit
-- ---------------------------------------------------------------------------

create or replace function app.guard_issued_invoice() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'issued' then
      raise exception 'Rechnung % ist ausgestellt und kann nicht gelöscht werden', old.number
        using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.status = 'issued' then
    raise exception 'Rechnung % ist ausgestellt und unveränderbar. Korrektur nur über Storno oder Rechnungskorrektur', old.number
      using errcode = 'check_violation';
  end if;
  if new.status = 'issued' and new.number is null then
    raise exception 'Ausstellen nur über app.issue_invoice()' using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger invoices_guard before update or delete on app.invoices
for each row execute function app.guard_issued_invoice();

create or replace function app.guard_issued_lines() returns trigger
language plpgsql as $$
declare
  v_status app.invoice_status;
begin
  select status into v_status from app.invoices
   where id = coalesce(new.invoice_id, old.invoice_id);
  if v_status = 'issued' then
    raise exception 'Positionen einer ausgestellten Rechnung sind unveränderbar' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;

create trigger invoice_lines_guard before insert or update or delete on app.invoice_lines
for each row execute function app.guard_issued_lines();

create or replace function app.guard_issued_prepayments() returns trigger
language plpgsql as $$
declare
  v_status app.invoice_status;
begin
  select status into v_status from app.invoices
   where id = coalesce(new.final_invoice_id, old.final_invoice_id);
  if v_status = 'issued' then
    raise exception 'Verrechnete Abschläge einer ausgestellten Rechnung sind unveränderbar' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;

create trigger invoice_prepayments_guard before insert or update or delete on app.invoice_prepayments
for each row execute function app.guard_issued_prepayments();

create or replace function app.deny_change() returns trigger
language plpgsql as $$
begin
  raise exception 'Tabelle % ist nur anhängbar (Archiv/Protokoll)', tg_table_name using errcode = 'check_violation';
end $$;

create trigger invoice_documents_append_only before update or delete on app.invoice_documents
for each row execute function app.deny_change();
create trigger audit_log_append_only before update or delete on app.audit_log
for each row execute function app.deny_change();

-- Versandprotokoll: einmal 'sent' bleibt 'sent'.
create or replace function app.guard_delivery() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Versandprotokoll kann nicht gelöscht werden' using errcode = 'check_violation';
  end if;
  if old.status = 'sent' then
    raise exception 'Versand % ist abgeschlossen und unveränderbar', old.id using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger invoice_deliveries_guard before update or delete on app.invoice_deliveries
for each row execute function app.guard_delivery();

-- ---------------------------------------------------------------------------
-- Ausstellen: lückenlose Nummer + Einfrieren
-- ---------------------------------------------------------------------------
-- Der Zähler wird mit Zeilensperre hochgezählt. Bricht die Transaktion ab, wird auch der
-- Zähler zurückgerollt → keine Lücken (im Gegensatz zu einer SEQUENCE).
-- Format (vorläufig, mit Ahmed abzustimmen): RE-JJJJ-NNNNN

create or replace function app.issue_invoice(
  p_invoice_id uuid,
  p_issue_date date,
  p_seller jsonb,
  p_buyer jsonb,
  p_actor uuid default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_inv app.invoices;
  v_year integer := extract(year from p_issue_date)::integer;
  v_seq integer;
  v_number text;
  v_lines integer;
  v_terms integer;
begin
  select * into v_inv from app.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'Rechnung % nicht gefunden', p_invoice_id;
  end if;
  if v_inv.status = 'issued' then
    return v_inv.number; -- idempotent: erneuter Aufruf liefert dieselbe Nummer
  end if;

  select count(*) into v_lines from app.invoice_lines where invoice_id = p_invoice_id;
  if v_lines = 0 then
    raise exception 'Rechnung ohne Positionen kann nicht ausgestellt werden' using errcode = 'check_violation';
  end if;

  -- Gegenprobe: gespeicherte Summen müssen zu den Positionen passen (Cent-genau).
  if exists (
    select 1 from app.invoice_lines
     where invoice_id = p_invoice_id
       and net_cents <> round(quantity_milli::numeric * unit_price_cents / 1000)
  ) or v_inv.net_cents <> (select sum(net_cents) from app.invoice_lines where invoice_id = p_invoice_id)
    or v_inv.gross_cents <> v_inv.net_cents + v_inv.vat_cents
    or v_inv.payable_cents <> v_inv.gross_cents - v_inv.prepaid_cents
  then
    raise exception 'Rechnungssummen sind inkonsistent – bitte Entwurf neu berechnen' using errcode = 'check_violation';
  end if;

  if p_issue_date > (now() at time zone 'Europe/Berlin')::date then
    raise exception 'Rechnungsdatum darf nicht in der Zukunft liegen' using errcode = 'check_violation';
  end if;

  insert into app.invoice_number_counters (year, last_value) values (v_year, 0)
  on conflict (year) do nothing;

  update app.invoice_number_counters
     set last_value = last_value + 1
   where year = v_year
  returning last_value into v_seq;

  v_number := 'RE-' || v_year || '-' || lpad(v_seq::text, 5, '0');

  select payment_terms_days into v_terms from app.customers where id = v_inv.customer_id;

  update app.invoices set
    status = 'issued',
    number = v_number,
    number_year = v_year,
    number_seq = v_seq,
    issue_date = p_issue_date,
    due_date = p_issue_date + case when v_inv.kind = 'cancellation' then 0 else coalesce(v_terms, 30) end,
    seller_snapshot = p_seller,
    buyer_snapshot = p_buyer,
    issued_at = now(),
    issued_by = p_actor
  where id = p_invoice_id;

  insert into app.audit_log (actor, action, entity, entity_id, details)
  values (coalesce(p_actor::text, 'system'), 'issue', 'invoice', p_invoice_id,
          jsonb_build_object('number', v_number, 'gross_cents', v_inv.gross_cents));

  return v_number;
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- Prototyp: Büro (admin/buchhaltung) sieht alles. Objektleitung sieht nur eigene Objekte.
-- Schreibende Geschäftsvorgänge laufen über den Server (service_role, umgeht RLS).

alter table app.profiles enable row level security;
alter table app.company enable row level security;
alter table app.customers enable row level security;
alter table app.sites enable row level security;
alter table app.site_services enable row level security;
alter table app.invoice_number_counters enable row level security;
alter table app.invoices enable row level security;
alter table app.invoice_lines enable row level security;
alter table app.invoice_prepayments enable row level security;
alter table app.invoice_documents enable row level security;
alter table app.invoice_deliveries enable row level security;
alter table app.audit_log enable row level security;

create policy profiles_self on app.profiles for select to authenticated
  using (user_id = (select auth.uid()) or (select app.is_office()));

create policy company_read on app.company for select to authenticated using (true);

create policy customers_office on app.customers for select to authenticated
  using ((select app.is_office()));

create policy sites_read on app.sites for select to authenticated
  using ((select app.is_office()) or manager_user_id = (select auth.uid()));

create policy site_services_read on app.site_services for select to authenticated
  using ((select app.is_office())
         or site_id in (select id from app.sites where manager_user_id = (select auth.uid())));

create policy invoices_office on app.invoices for select to authenticated
  using ((select app.is_office()));
create policy invoice_lines_office on app.invoice_lines for select to authenticated
  using ((select app.is_office()));
create policy invoice_prepayments_office on app.invoice_prepayments for select to authenticated
  using ((select app.is_office()));
create policy invoice_documents_office on app.invoice_documents for select to authenticated
  using ((select app.is_office()));
create policy invoice_deliveries_office on app.invoice_deliveries for select to authenticated
  using ((select app.is_office()));
create policy audit_log_office on app.audit_log for select to authenticated
  using ((select app.is_office()));
-- invoice_number_counters: keine Policy → für anon/authenticated unsichtbar.

grant usage on schema app to authenticated, service_role;
grant select on all tables in schema app to authenticated;
grant all on all tables in schema app to service_role;
revoke execute on function app.issue_invoice(uuid, date, jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function app.issue_invoice(uuid, date, jsonb, jsonb, uuid) to service_role;
