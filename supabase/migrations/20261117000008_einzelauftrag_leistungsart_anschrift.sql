-- Einzelauftrag (Ahmed 09.10.): Leistungsart und Leistungszeitraum je Position, Rechnungsanschrift nur für diesen Auftrag
-- (geht als „Rechnungsadresse nur für diese Rechnung“ in den Entwurf).
alter table app.order_lines
  add column if not exists service_type_id uuid references app.service_types (id),
  add column if not exists period_start date,
  add column if not exists period_end date;
alter table app.orders add column if not exists bill_address jsonb;
