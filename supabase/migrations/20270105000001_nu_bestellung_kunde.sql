-- NU-Bestellung für einen Kunden ohne festes Objekt (Ahmed 29.10.: „Bestellung für einen Kunden, wenn die einzelne
-- Aufträge haben“): Objekt = „Allgemein“ des Kunden bzw. Objekt des Einzelauftrags, optional Verweis auf den Einzelauftrag.
alter table app.subcontracts add column if not exists order_id uuid references app.orders (id) on delete set null;
create index if not exists subcontracts_order_idx on app.subcontracts (order_id);
