-- Nachkalkulation „Sonderreinigung“ (Ahmed 12.10.): Umsatz der so gekennzeichneten Leistungsarten zählt in der
-- Nachkalkulation beim internen Objekt „Sonderreinigung“ (INT-SONDER), dort laufen auch Zeiten und Kosten der
-- Sonderreiniger. Vorbelegt: Sonderreinigung, Grundreinigung, Bauendreinigung (unter Einstellungen → Leistungsarten änderbar).
alter table app.service_types add column if not exists special_cleaning boolean not null default false;
update app.service_types set special_cleaning = true
 where lower(name) in ('sonderreinigung', 'grundreinigung', 'bauendreinigung');
