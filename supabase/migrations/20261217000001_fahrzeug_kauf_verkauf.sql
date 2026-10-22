-- Fahrzeuge: Kaufpreis/-datum und Verkauf (Verkaufsdatum, -preis, Käufer). Verkauft = nicht mehr im Bestand.
alter table app.vehicles
  add column purchase_date date,
  add column purchase_price_cents bigint check (purchase_price_cents is null or purchase_price_cents >= 0),
  add column sold_on date,
  add column sale_price_cents bigint check (sale_price_cents is null or sale_price_cents >= 0),
  add column buyer text;
