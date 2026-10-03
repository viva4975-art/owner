-- Phase 2 (Teil 2): Dateien (große Uploads), Angebote, Mahnwesen, Lieferanten/Nachunternehmer,
-- Artikel/Nachbestellung, Geräte, Schlüssel. Interessenten als Kundenstatus.

-- ---------------------------------------------------------------------------
-- Dateien: in Stücken hochgeladen (fortsetzbar), danach unveränderbar
-- ---------------------------------------------------------------------------

create type app.file_status as enum ('uploading', 'complete');

create table app.files (
  id uuid primary key,
  original_name text not null check (length(original_name) between 1 and 255),
  content_type text not null default 'application/octet-stream',
  size_bytes bigint not null check (size_bytes >= 0),
  chunk_size integer not null check (chunk_size > 0),
  total_chunks integer not null check (total_chunks >= 0),
  status app.file_status not null default 'uploading',
  sha256 text,
  storage_path text unique,
  uploaded_by text not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (status = 'uploading' or (sha256 is not null and storage_path is not null))
);

create table app.file_links (
  file_id uuid not null references app.files (id),
  entity_type text not null check (entity_type in ('offer', 'invoice', 'customer', 'site', 'employee', 'supplier')),
  entity_id uuid not null,
  category text,
  linked_by text not null,
  linked_at timestamptz not null default now(),
  primary key (file_id, entity_type, entity_id)
);
create index on app.file_links (entity_type, entity_id);

create or replace function app.guard_file() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'complete' then
      raise exception 'Abgeschlossene Dateien können nicht gelöscht werden' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.status = 'complete' then
    raise exception 'Datei % ist abgeschlossen und unveränderbar', old.original_name using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger files_guard before update or delete on app.files for each row execute function app.guard_file();

-- ---------------------------------------------------------------------------
-- Interessenten (Angebote gehen oft an Noch-nicht-Kunden)
-- ---------------------------------------------------------------------------

alter table app.customers add column status text not null default 'kunde' check (status in ('kunde', 'interessent'));
alter table app.customers add column dunning_block boolean not null default false;

-- ---------------------------------------------------------------------------
-- Angebote
-- ---------------------------------------------------------------------------

create type app.offer_status as enum ('entwurf', 'versendet', 'angenommen', 'abgelehnt', 'zurueckgezogen');

insert into app.number_ranges (key, prefix, next_value) values ('offer', '', 3843) on conflict (key) do nothing;

create table app.offers (
  id uuid primary key,
  number text not null unique,
  customer_id uuid not null references app.customers (id),
  site_id uuid references app.sites (id),
  title text not null,
  tender_reference text,          -- Vergabenummer
  tender_platform text,           -- z. B. Bayerischer Vergabemarktplatz, DTVP
  submission_deadline timestamptz,-- Abgabefrist
  offer_date date not null,
  valid_until date,
  status app.offer_status not null default 'entwurf',
  intro_text text,
  closing_text text,
  net_cents bigint not null default 0,
  vat_cents bigint not null default 0,
  gross_cents bigint not null default 0,
  monthly_net_cents bigint not null default 0,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_at timestamptz,
  version integer not null default 1
);
create index on app.offers (customer_id);
create index on app.offers (status, submission_deadline);
create trigger offers_version before update on app.offers for each row execute function app.bump_version();

create table app.offer_lines (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references app.offers (id) on delete cascade,
  position integer not null,
  description text not null,
  detail text,
  quantity_milli bigint not null,
  unit_code text not null default 'C62',
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  net_cents bigint not null,
  vat_rate_bp integer not null,
  recurring boolean not null default false, -- monatlich wiederkehrend (wird bei Annahme Monatspauschale)
  unique (offer_id, position)
);

-- ---------------------------------------------------------------------------
-- Mahnwesen
-- ---------------------------------------------------------------------------

insert into app.number_ranges (key, prefix, next_value) values ('dunning', 'M-', 1) on conflict (key) do nothing;

create table app.dunning_settings (
  level integer primary key check (level between 1 and 3),
  title text not null,
  fee_cents bigint not null default 0 check (fee_cents >= 0),
  min_days_overdue integer not null,
  payment_days integer not null default 10,
  text text not null
);
insert into app.dunning_settings (level, title, fee_cents, min_days_overdue, payment_days, text) values
  (1, 'Zahlungserinnerung', 0, 7, 10,
   'sicher haben Sie es im Tagesgeschäft übersehen: Für die folgenden Rechnungen konnten wir noch keinen Zahlungseingang feststellen. Wir bitten um Ausgleich bis zum angegebenen Datum. Sollten Sie bereits gezahlt haben, betrachten Sie dieses Schreiben bitte als gegenstandslos.'),
  (2, '1. Mahnung', 500, 21, 10,
   'leider konnten wir trotz unserer Zahlungserinnerung noch keinen Zahlungseingang feststellen. Wir bitten Sie, den offenen Betrag zuzüglich Mahngebühr bis zum angegebenen Datum zu überweisen.'),
  (3, '2. und letzte Mahnung', 1000, 35, 7,
   'trotz Erinnerung und Mahnung ist der folgende Betrag weiterhin offen. Bitte gleichen Sie ihn bis zum angegebenen Datum aus. Danach werden wir ohne weitere Ankündigung gerichtliche Schritte einleiten.');

create table app.dunnings (
  id uuid primary key,
  number text not null unique,
  customer_id uuid not null references app.customers (id),
  level integer not null check (level between 1 and 3),
  issue_date date not null,
  pay_until date not null,
  fee_cents bigint not null default 0,
  total_cents bigint not null,
  status text not null default 'erstellt' check (status in ('erstellt', 'versendet')),
  pdf_sha256 text,
  pdf_path text,
  created_by text not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  sent_to text[]
);

create table app.dunning_items (
  dunning_id uuid not null references app.dunnings (id),
  invoice_id uuid not null references app.invoices (id),
  open_cents bigint not null,
  days_overdue integer not null,
  primary key (dunning_id, invoice_id)
);

create trigger dunning_items_append_only before update or delete on app.dunning_items
for each row execute function app.deny_change();

-- ---------------------------------------------------------------------------
-- Lieferanten & Nachunternehmer
-- ---------------------------------------------------------------------------

create table app.suppliers (
  id uuid primary key,
  supplier_no text not null unique,
  name text not null,
  kind text not null default 'lieferant' check (kind in ('lieferant', 'nachunternehmer')),
  street text,
  postal_code text,
  city text,
  email text,
  phone text,
  contact_name text,
  vat_id text,
  iban text,
  bic text,
  payment_terms_days integer not null default 30,
  -- Nachunternehmer: Freistellungsbescheinigung § 48b EStG (sonst 15 % Bauabzugsteuer einbehalten)
  exemption_valid_until date,
  -- Nachunternehmer: Unbedenklichkeit Sozialkasse/Berufsgenossenschaft, Mindestlohnerklärung
  clearance_valid_until date,
  notes text,
  active boolean not null default true,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger suppliers_version before update on app.suppliers for each row execute function app.bump_version();

-- ---------------------------------------------------------------------------
-- Inventar: Artikel, Geräte, Schlüssel
-- ---------------------------------------------------------------------------

create table app.articles (
  id uuid primary key,
  article_no text not null unique,
  name text not null,
  unit text not null default 'Stk.',
  stock_milli bigint not null default 0,
  min_stock_milli bigint not null default 0,
  supplier_id uuid references app.suppliers (id),
  purchase_price_cents bigint,
  active boolean not null default true,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);
create trigger articles_version before update on app.articles for each row execute function app.bump_version();

create table app.stock_movements (
  id uuid primary key,
  article_id uuid not null references app.articles (id),
  delta_milli bigint not null check (delta_milli <> 0),
  reason text not null,
  site_id uuid references app.sites (id),
  created_by text not null,
  created_at timestamptz not null default now()
);
create trigger stock_movements_append_only before update or delete on app.stock_movements
for each row execute function app.deny_change();

create table app.devices (
  id uuid primary key,
  inventory_no text not null unique,
  name text not null,
  manufacturer text,
  serial_no text,
  site_id uuid references app.sites (id),
  purchase_date date,
  next_inspection date,      -- z. B. DGUV V3 Prüfung ortsveränderlicher Geräte
  notes text,
  active boolean not null default true,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);
create trigger devices_version before update on app.devices for each row execute function app.bump_version();

create table app.keys (
  id uuid primary key,
  key_no text not null unique,
  site_id uuid not null references app.sites (id),
  description text not null,
  quantity integer not null default 1 check (quantity > 0),
  holder_employee_id uuid references app.employees (id),
  issued_at date,
  notes text,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);
create trigger keys_version before update on app.keys for each row execute function app.bump_version();

-- Schlüsselbuch: jede Ausgabe/Rückgabe wird protokolliert
create table app.key_log (
  id bigint generated always as identity primary key,
  key_id uuid not null references app.keys (id),
  action text not null check (action in ('ausgabe', 'rueckgabe', 'verlust')),
  employee_id uuid references app.employees (id),
  at date not null,
  note text,
  created_by text not null,
  created_at timestamptz not null default now()
);
create trigger key_log_append_only before update or delete on app.key_log
for each row execute function app.deny_change();

-- ---------------------------------------------------------------------------
-- RLS (Lesen für Büro; Schreiben nur über den Server)
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['files','file_links','offers','offer_lines','dunning_settings','dunnings','dunning_items',
                           'suppliers','articles','stock_movements','devices','keys','key_log'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('create policy %I on app.%I for select to authenticated using ((select app.is_office()))', t || '_office', t);
    execute format('grant select on app.%I to authenticated', t);
    execute format('grant all on app.%I to service_role', t);
  end loop;
end $$;
