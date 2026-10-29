-- Abzüge bei der Prüfung einer Eingangsrechnung (Ahmed 29.10., z. B. Reinigung nicht erfolgt): mindern den Zahlbetrag
-- und die Kosten der Kostenstelle; die Rechnung selbst bleibt unverändert (Beleg des Lieferanten).
create table app.incoming_deductions (
  id uuid primary key,
  incoming_invoice_id uuid not null references app.incoming_invoices (id) on delete cascade,
  reason_kind text not null check (reason_kind in ('nicht_gereinigt', 'mangel', 'menge', 'sonstiges')),
  reason text not null check (length(trim(reason)) > 0),
  service_from date,
  service_to date,
  site_id uuid references app.sites (id),
  cost_center_id uuid references app.cost_centers (id),
  month date not null check (extract(day from month) = 1),
  net_cents bigint not null check (net_cents > 0),
  vat_cents bigint not null check (vat_cents >= 0),
  gross_cents bigint not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  check (gross_cents = net_cents + vat_cents),
  check (service_to is null or service_from is null or service_to >= service_from),
  check (not (site_id is not null and cost_center_id is not null))
);
create index on app.incoming_deductions (incoming_invoice_id);

-- Bezahlte Rechnungen: Abzüge stehen fest
create or replace function app.guard_incoming_deduction() returns trigger
language plpgsql as $$
declare st text;
begin
  select status::text into st from app.incoming_invoices
   where id = coalesce(new.incoming_invoice_id, old.incoming_invoice_id);
  if st = 'bezahlt' then
    raise exception 'Rechnung ist bezahlt – Abzüge können nicht mehr geändert werden' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;
create trigger incoming_deductions_guard before insert or update or delete on app.incoming_deductions
for each row execute function app.guard_incoming_deduction();

alter table app.incoming_deductions enable row level security;
create policy incoming_deductions_office on app.incoming_deductions for select to authenticated
  using ((select app.is_office()));

-- Kosten je Kostenstelle/Monat: Aufteilung der Rechnung abzüglich Abzüge (für Nachkalkulation/Kostenstellen)
create or replace view app.incoming_cost_lines with (security_invoker = true) as
  select a.incoming_invoice_id, a.site_id, a.cost_center_id, a.month, a.net_cents
    from app.cost_allocations a
  union all
  select d.incoming_invoice_id, d.site_id, d.cost_center_id, d.month, -d.net_cents
    from app.incoming_deductions d
   where d.site_id is not null or d.cost_center_id is not null;
