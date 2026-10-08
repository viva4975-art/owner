-- Ahmed 08.10.: Bestellnummer des Kunden je Leistung (z. B. Abruf-/Bestellschein je Leistung bei Behörden).
alter table app.site_services add column order_reference text check (order_reference is null or length(order_reference) <= 100);
