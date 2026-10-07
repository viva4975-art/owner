-- 1) Rechnungsarchiv aus Fortytools (XML-Export): nur lesen – die Rechnungen wurden in Fortytools ausgestellt und dort
--    bzw. als PDF archiviert. Dient für Kundenhistorie, Suche, Umsatz, offene Fortytools-Rechnungen und um die
--    Monatspauschalen je Objekt abzuleiten.
create table app.legacy_invoices (
  id uuid primary key,
  number text not null unique,
  issue_date date not null,
  due_date date,
  delivery_date date,
  customer_id uuid references app.customers (id),
  customer_no text,
  net_cents bigint not null,
  gross_cents bigint not null,
  paid boolean not null,
  paid_at date,
  paid_marked_by text,                  -- „bezahlt“ in der neuen App festgehalten
  parent_number text,                   -- Storno/Korrektur zu …
  customer_reference text,
  payment_terms text,
  source text not null default 'fortytools',
  imported_at timestamptz not null default now()
);
create index on app.legacy_invoices (customer_id, issue_date);
create table app.legacy_invoice_lines (
  id uuid primary key,
  invoice_id uuid not null references app.legacy_invoices (id),
  position integer not null,
  title text,
  details text,
  quantity_milli bigint not null,
  unit text,
  unit_price_cents bigint not null,
  net_cents bigint not null,
  service_type text,
  period_start date,
  period_end date,
  site_id uuid references app.sites (id)
);
create index on app.legacy_invoice_lines (invoice_id);
create index on app.legacy_invoice_lines (site_id);
-- Inhalt unveränderbar (nur „bezahlt“ darf nachgetragen werden)
create or replace function app.legacy_invoice_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'Fortytools-Rechnungen werden nicht gelöscht' using errcode = 'check_violation'; end if;
  if (new.number, new.issue_date, new.net_cents, new.gross_cents, new.customer_no, new.parent_number)
     is distinct from (old.number, old.issue_date, old.net_cents, old.gross_cents, old.customer_no, old.parent_number) then
    raise exception 'Fortytools-Rechnungen sind unveränderbar' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger legacy_invoices_guard before update or delete on app.legacy_invoices
for each row execute function app.legacy_invoice_guard();
create trigger legacy_invoice_lines_guard before update or delete on app.legacy_invoice_lines
for each row execute function app.deny_change();

alter table app.legacy_invoices enable row level security;
alter table app.legacy_invoice_lines enable row level security;
create policy legacy_invoices_office on app.legacy_invoices for select to authenticated using ((select app.is_office()));
create policy legacy_invoice_lines_office on app.legacy_invoice_lines for select to authenticated using ((select app.is_office()));
grant select on app.legacy_invoices, app.legacy_invoice_lines to authenticated;
grant all on app.legacy_invoices, app.legacy_invoice_lines to service_role;

-- 2) Wochenstunden mit Verlauf (Ahmed 07.10.: „alte und neue sehen“): je Änderung ein Eintrag „gültig ab“
create table app.employee_hours (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references app.employees (id),
  valid_from date not null,
  weekly_hours numeric(5, 2) check (weekly_hours is null or weekly_hours between 0 and 60),
  note text,
  recorded_by text not null,
  recorded_at timestamptz not null default now()
);
-- je Stichtag gilt der zuletzt erfasste Eintrag (Korrektur am selben Tag = neuer Eintrag, nichts wird überschrieben)
create index on app.employee_hours (employee_id, valid_from desc, recorded_at desc);
create trigger employee_hours_append_only before update or delete on app.employee_hours
for each row execute function app.deny_change();
alter table app.employee_hours enable row level security;
create policy employee_hours_hr on app.employee_hours for select to authenticated using ((select app.is_office()));
grant select on app.employee_hours to authenticated;
grant all on app.employee_hours to service_role;
insert into app.employee_hours (employee_id, valid_from, weekly_hours, note, recorded_by)
select id, entry_date, weekly_hours, 'Stand bei Einführung des Verlaufs', 'migration' from app.employees;
