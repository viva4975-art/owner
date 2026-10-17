-- Abweichende Rechnungsanschrift je Leistung (Ahmed 17.10.): Monatslauf und Entwürfe aus verrichteten Leistungen
-- übernehmen sie als Anschrift „nur für diese Rechnung“ (invoices.bill_address).
alter table app.site_services add column if not exists bill_address jsonb;
