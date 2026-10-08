-- Preisanpassung bei Tariflohnerhöhung: je Leistung neuer Preis = alt × (1 + Lohnkostenanteil × Lohnerhöhung).
-- Die alte Leistung endet am Vortag des Stichtags, eine Kopie mit neuem Preis gilt ab Stichtag (Rechnungen bleiben
-- nachvollziehbar). Lauf und Positionen nur anhängen (Grundlage für das Anschreiben an die Kunden).
create table app.price_adjustments (
  id uuid primary key,
  effective_from date not null check (extract(day from effective_from) = 1),
  raise_bp integer not null check (raise_bp between 1 and 5000),
  note text,
  created_by text not null,
  created_at timestamptz not null default now()
);
create table app.price_adjustment_items (
  adjustment_id uuid not null references app.price_adjustments (id),
  old_service_id uuid not null references app.site_services (id),
  new_service_id uuid not null unique references app.site_services (id),
  customer_id uuid not null references app.customers (id),
  labor_share_bp integer not null,
  old_price_cents bigint not null,
  new_price_cents bigint not null,
  primary key (adjustment_id, old_service_id)
);
create or replace function app.price_adjustment_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'Preisanpassungen sind unveränderbar' using errcode = 'check_violation';
end $$;
create trigger price_adjustments_ro before update or delete on app.price_adjustments
  for each row execute function app.price_adjustment_append_only();
create trigger price_adjustment_items_ro before update or delete on app.price_adjustment_items
  for each row execute function app.price_adjustment_append_only();

alter table app.price_adjustments enable row level security;
alter table app.price_adjustment_items enable row level security;
create policy price_adjustments_office on app.price_adjustments for select to authenticated
  using ((select app.is_office()));
create policy price_adjustment_items_office on app.price_adjustment_items for select to authenticated
  using ((select app.is_office()));
