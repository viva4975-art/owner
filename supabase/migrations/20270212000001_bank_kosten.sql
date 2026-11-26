-- Ahmed 26.11.: Kontoumsatz ohne Lieferant/Rechnung direkt als Kosten zuordnen – auf Objekte bzw. allgemeine
-- Kostenstellen, mit Kostenart, USt-Satz und Leistungsmonat. Zählt in Nachkalkulation, Kostenstellen und Ausgaben
-- (nicht im DATEV-Export: Buchung über den Kontoauszug beim Steuerberater).
create table app.bank_cost_allocations (
  id uuid primary key,
  bank_transaction_id uuid not null references app.bank_transactions (id) on delete cascade,
  site_id uuid references app.sites (id),
  cost_center_id uuid references app.cost_centers (id),
  month date not null check (extract(day from month) = 1),
  gross_cents bigint not null check (gross_cents <> 0),
  vat_bp integer not null check (vat_bp in (0, 700, 1900)),
  net_cents bigint not null check (net_cents <> 0),
  category text not null,
  note text,
  created_by text not null,
  created_at timestamptz not null default now(),
  check ((site_id is null) <> (cost_center_id is null))
);
create index on app.bank_cost_allocations (bank_transaction_id);
create index on app.bank_cost_allocations (site_id, month);
create index on app.bank_cost_allocations (cost_center_id, month);
alter table app.bank_cost_allocations enable row level security;
create policy bank_cost_allocations_read on app.bank_cost_allocations for select to authenticated
  using ((select app.is_office()));

alter table app.bank_transactions drop constraint if exists bank_transactions_assigned_kind_check;
alter table app.bank_transactions add constraint bank_transactions_assigned_kind_check
  check (assigned_kind in ('kunde', 'lieferant', 'mitarbeiter', 'sonstiges', 'kosten'));

alter table app.file_links drop constraint file_links_entity_type_check;
alter table app.file_links add constraint file_links_entity_type_check
  check (entity_type in ('offer', 'invoice', 'customer', 'site', 'employee', 'supplier', 'incoming_invoice',
                         'purchase_order', 'order', 'work_report', 'quality_check', 'inbox', 'tender', 'note',
                         'legacy_import', 'vehicle', 'word_template', 'personnel_form', 'bank_transaction'));

-- Alle gebuchten Kosten (Eingangsrechnungen erfasst/freigegeben/bezahlt + direkt zugeordnete Kontoumsätze).
create or replace view app.booked_cost_lines with (security_invoker = true) as
  select a.site_id, a.cost_center_id, a.month, a.net_cents, i.category::text as category,
         'eingang'::text as source, i.id as ref_id
    from app.incoming_cost_lines a join app.incoming_invoices i on i.id = a.incoming_invoice_id
   where i.status in ('erfasst', 'freigegeben', 'bezahlt')
  union all
  select b.site_id, b.cost_center_id, b.month, b.net_cents, b.category, 'bank'::text, b.bank_transaction_id
    from app.bank_cost_allocations b join app.bank_transactions t on t.id = b.bank_transaction_id
   where t.status = 'ignoriert' and t.assigned_kind = 'kosten';
