-- Phase 4 Teil 1: Aufträge und Arbeitsscheine (Leistungsnachweise) mit Unterschrift des Kunden.
--
-- Arbeitsschein: wird vor Ort ausgefüllt und vom Kunden auf Handy/Tablet unterschrieben (einfache elektronische
-- Signatur – Beweismittel für die erbrachte Leistung, keine gesetzliche Schriftform). Nach der Unterschrift
-- unveränderbar; PDF mit Unterschrift write-once im Archiv. Unterschriebene Scheine hängen an der Rechnung.

alter table app.file_links drop constraint file_links_entity_type_check;
alter table app.file_links add constraint file_links_entity_type_check
  check (entity_type in ('offer', 'invoice', 'customer', 'site', 'employee', 'supplier', 'incoming_invoice',
                         'purchase_order', 'order', 'work_report'));

create type app.order_status as enum ('offen', 'in_arbeit', 'erledigt', 'abgerechnet', 'storniert');

create table app.orders (
  id uuid primary key,
  number text not null unique,                  -- AU-JJJJ-NNNN
  customer_id uuid not null references app.customers (id),
  site_id uuid references app.sites (id),
  offer_id uuid references app.offers (id),
  title text not null,
  description text,
  order_reference text,                         -- Bestellnummer des Kunden
  planned_date date,
  status app.order_status not null default 'offen',
  net_cents bigint not null default 0,
  invoice_id uuid references app.invoices (id),
  created_by text not null,
  created_at timestamptz not null default now(),
  version integer not null default 1
);
create index on app.orders (customer_id);
create index on app.orders (site_id);
create trigger orders_version before update on app.orders for each row execute function app.bump_version();

create table app.order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references app.orders (id) on delete cascade,
  position integer not null,
  description text not null,
  detail text,
  quantity_milli bigint not null,
  unit_code text not null default 'C62',
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  net_cents bigint not null,
  vat_rate_bp integer not null,
  unique (order_id, position)
);

create type app.work_report_status as enum ('entwurf', 'unterschrieben', 'ohne_unterschrift');

create table app.work_reports (
  id uuid primary key,
  number text not null unique,                  -- AS-JJJJ-NNNN
  order_id uuid references app.orders (id),
  customer_id uuid not null references app.customers (id),
  site_id uuid not null references app.sites (id),
  work_date date not null,
  start_time time,
  end_time time,
  employee_ids uuid[] not null default '{}',
  description text,                             -- ausgeführte Arbeiten (Freitext)
  materials text,
  remarks text,                                 -- Bemerkungen des Kunden / Mängel
  status app.work_report_status not null default 'entwurf',
  signed_by_name text,
  signed_at timestamptz,
  signature_path text,                          -- PNG im Archiv
  signature_sha256 text,
  no_signature_reason text,
  pdf_path text,
  pdf_sha256 text,
  invoice_id uuid references app.invoices (id),
  created_by text not null,
  created_at timestamptz not null default now(),
  version integer not null default 1,
  check (status <> 'unterschrieben' or (signed_by_name is not null and signed_at is not null and signature_sha256 is not null)),
  check (status <> 'ohne_unterschrift' or no_signature_reason is not null)
);
create index on app.work_reports (site_id, work_date);
create index on app.work_reports (order_id);
create trigger work_reports_version before update on app.work_reports for each row execute function app.bump_version();

create table app.work_report_lines (
  id uuid primary key default gen_random_uuid(),
  work_report_id uuid not null references app.work_reports (id) on delete cascade,
  position integer not null,
  description text not null,
  quantity_milli bigint not null check (quantity_milli > 0),
  unit_code text not null default 'HUR',
  unique (work_report_id, position)
);

-- Nach Abschluss (unterschrieben / ohne Unterschrift) sind Inhalt und Positionen eingefroren.
-- Erlaubt bleibt nur das spätere Eintragen von PDF und Rechnung.
create or replace function app.guard_work_report() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'entwurf' then
      raise exception 'Abgeschlossene Arbeitsscheine werden nicht gelöscht' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.status <> 'entwurf' and (
       (new.customer_id, new.site_id, new.work_date, new.start_time, new.end_time, new.employee_ids, new.description,
        new.materials, new.remarks, new.status, new.signed_by_name, new.signed_at, new.signature_sha256, new.order_id)
       is distinct from
       (old.customer_id, old.site_id, old.work_date, old.start_time, old.end_time, old.employee_ids, old.description,
        old.materials, old.remarks, old.status, old.signed_by_name, old.signed_at, old.signature_sha256, old.order_id)
       or (old.pdf_path is not null and new.pdf_path is distinct from old.pdf_path)
       or (old.invoice_id is not null and new.invoice_id is distinct from old.invoice_id)) then
    raise exception 'Arbeitsschein % ist abgeschlossen und unveränderbar', old.number using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger work_reports_guard before update or delete on app.work_reports for each row execute function app.guard_work_report();

create or replace function app.guard_work_report_lines() returns trigger
language plpgsql as $$
declare st app.work_report_status;
begin
  select status into st from app.work_reports where id = coalesce(new.work_report_id, old.work_report_id);
  if st is not null and st <> 'entwurf' then
    raise exception 'Positionen eines abgeschlossenen Arbeitsscheins sind unveränderbar' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;
create trigger work_report_lines_guard before insert or update or delete on app.work_report_lines
for each row execute function app.guard_work_report_lines();

-- RLS: Büro alles; Objektleitung Arbeitsscheine ihrer Objekte (Aufträge enthalten Preise → nur Büro)
do $$
declare t text;
begin
  foreach t in array array['orders', 'order_lines'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('create policy %I on app.%I for select to authenticated using ((select app.is_office()))', t || '_office', t);
    execute format('grant select on app.%I to authenticated', t);
    execute format('grant all on app.%I to service_role', t);
  end loop;
end $$;
alter table app.work_reports enable row level security;
create policy work_reports_read on app.work_reports for select to authenticated
  using ((select app.is_office()) or site_id in (select id from app.sites where manager_user_id = (select auth.uid())));
alter table app.work_report_lines enable row level security;
create policy work_report_lines_read on app.work_report_lines for select to authenticated
  using (work_report_id in (select id from app.work_reports));
grant select on app.work_reports, app.work_report_lines to authenticated;
grant all on app.work_reports, app.work_report_lines to service_role;
