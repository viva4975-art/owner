-- Leistungen: Monate ohne Rechnung (z. B. Schulen im August) – Monatslauf, Vorschau, Budget lassen sie aus
alter table app.site_services add column if not exists no_bill_months smallint[];
