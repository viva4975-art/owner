-- Phase 3 Teil 2: Bestellungen (BE-JJJJ-NNNN), Rechnungseingang, SEPA-Zahlungslauf, DATEV-Export, Nachkalkulation.

alter table app.file_links drop constraint file_links_entity_type_check;
alter table app.file_links add constraint file_links_entity_type_check
  check (entity_type in ('offer', 'invoice', 'customer', 'site', 'employee', 'supplier', 'incoming_invoice', 'purchase_order'));

-- ---------------------------------------------------------------------------
-- Bestellungen
-- ---------------------------------------------------------------------------

create type app.po_status as enum ('entwurf', 'bestellt', 'geliefert', 'storniert');

create table app.purchase_orders (
  id uuid primary key,
  number text not null unique,               -- BE-JJJJ-NNNN wie in der alten App
  supplier_id uuid not null references app.suppliers (id),
  site_id uuid references app.sites (id),    -- Lieferung an Objekt (sonst Lager)
  order_date date not null,
  delivery_date date,
  status app.po_status not null default 'entwurf',
  note text,
  net_cents bigint not null default 0,
  created_by text not null,
  created_at timestamptz not null default now(),
  ordered_at timestamptz,
  received_at timestamptz,
  version integer not null default 1
);
create index on app.purchase_orders (supplier_id);
create trigger purchase_orders_version before update on app.purchase_orders for each row execute function app.bump_version();

create table app.purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references app.purchase_orders (id) on delete cascade,
  position integer not null,
  article_id uuid references app.articles (id),
  description text not null,
  quantity_milli bigint not null check (quantity_milli > 0),
  unit text not null default 'Stk.',
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  net_cents bigint not null,
  unique (order_id, position)
);

-- ---------------------------------------------------------------------------
-- Rechnungseingang
-- ---------------------------------------------------------------------------

create type app.incoming_status as enum ('erfasst', 'freigegeben', 'bezahlt', 'abgelehnt');
create type app.cost_category as enum ('material', 'nachunternehmer', 'geraete', 'fahrzeuge', 'miete', 'sonstiges');

create table app.incoming_invoices (
  id uuid primary key,
  supplier_id uuid not null references app.suppliers (id),
  invoice_no text not null,                  -- Rechnungsnummer des Lieferanten
  invoice_date date not null,
  due_date date not null,
  service_month date,                        -- Leistungsmonat (1. des Monats) für die Nachkalkulation
  net_cents bigint not null,
  vat_cents bigint not null,
  gross_cents bigint not null,
  reverse_charge boolean not null default false,  -- § 13b UStG: wir schulden die Umsatzsteuer
  category app.cost_category not null,
  site_id uuid references app.sites (id),
  purchase_order_id uuid references app.purchase_orders (id),
  skonto_until date,
  skonto_percent_bp integer check (skonto_percent_bp is null or skonto_percent_bp between 1 and 1000),
  status app.incoming_status not null default 'erfasst',
  note text,
  created_by text not null,
  created_at timestamptz not null default now(),
  approved_by text,
  approved_at timestamptz,
  paid_at date,
  version integer not null default 1,
  unique (supplier_id, invoice_no),          -- dieselbe Rechnung nicht zweimal erfassen/bezahlen
  check (gross_cents = net_cents + vat_cents),
  check (not reverse_charge or vat_cents = 0),
  check ((skonto_until is null) = (skonto_percent_bp is null))
);
create index on app.incoming_invoices (status, due_date);
create index on app.incoming_invoices (site_id, service_month);
create trigger incoming_invoices_version before update on app.incoming_invoices for each row execute function app.bump_version();

-- Bezahlte Rechnungen sind abgeschlossen
create or replace function app.guard_incoming() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'erfasst' then
      raise exception 'Freigegebene oder bezahlte Eingangsrechnungen werden nicht gelöscht' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.status = 'bezahlt' and (new.net_cents, new.vat_cents, new.supplier_id, new.invoice_no, new.status)
       is distinct from (old.net_cents, old.vat_cents, old.supplier_id, old.invoice_no, old.status) then
    raise exception 'Bezahlte Eingangsrechnung ist abgeschlossen' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger incoming_guard before update or delete on app.incoming_invoices for each row execute function app.guard_incoming();

-- ---------------------------------------------------------------------------
-- SEPA-Zahlungslauf
-- ---------------------------------------------------------------------------

create table app.payment_runs (
  id uuid primary key,
  number text not null unique,               -- ZL-JJJJ-NNN
  execution_date date not null,
  debtor_iban text not null,
  debtor_bic text not null,
  total_cents bigint not null,
  item_count integer not null,
  message_id text not null unique,
  xml_sha256 text,
  xml_path text,
  created_by text not null,
  created_at timestamptz not null default now()
);

create table app.payment_run_items (
  run_id uuid not null references app.payment_runs (id),
  incoming_invoice_id uuid not null references app.incoming_invoices (id),
  amount_cents bigint not null check (amount_cents > 0),
  skonto_cents bigint not null default 0,
  creditor_name text not null,
  creditor_iban text not null,
  creditor_bic text,
  remittance text not null,
  primary key (run_id, incoming_invoice_id)
);
-- jede Rechnung höchstens einmal in einem Zahlungslauf
create unique index payment_run_items_once on app.payment_run_items (incoming_invoice_id);
create trigger payment_run_items_append_only before update or delete on app.payment_run_items
for each row execute function app.deny_change();
create trigger payment_runs_append_only before delete on app.payment_runs
for each row execute function app.deny_change();

insert into app.number_ranges (key, prefix, next_value) values ('payment_run', 'ZL-', 1) on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- DATEV- und Kalkulations-Einstellungen (eine Zeile)
-- ---------------------------------------------------------------------------

create table app.accounting_settings (
  id boolean primary key default true check (id),
  datev_consultant_no text,                 -- Beraternummer
  datev_client_no text,                     -- Mandantennummer
  chart text not null default 'SKR03' check (chart in ('SKR03', 'SKR04')),
  fiscal_year_start text not null default '01-01',
  account_length integer not null default 4 check (account_length between 4 and 8),
  revenue_19 text not null default '8400',
  revenue_7 text not null default '8300',
  bank_account text not null default '1200',
  expense_material text not null default '3000',
  expense_subcontractor text not null default '3100',
  expense_other text not null default '4980',
  rc_tax_key text not null default '94',    -- BU-Schlüssel § 13b – mit Steuerberater abstimmen
  -- Nachkalkulation: Zuschlag auf den Bruttostundenlohn für AG-Sozialversicherung, Urlaub, Krankheit, Feiertage
  labor_overhead_bp integer not null default 4500 check (labor_overhead_bp between 0 and 20000),
  target_margin_bp integer not null default 1500
);
insert into app.accounting_settings default values;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['purchase_orders', 'purchase_order_lines', 'incoming_invoices', 'payment_runs',
                           'payment_run_items', 'accounting_settings'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('create policy %I on app.%I for select to authenticated using ((select app.is_office()))', t || '_office', t);
    execute format('grant select on app.%I to authenticated', t);
    execute format('grant all on app.%I to service_role', t);
  end loop;
end $$;
