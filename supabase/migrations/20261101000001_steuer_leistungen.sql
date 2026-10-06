-- Runde 4a: § 13b (Steuerschuldnerschaft des Leistungsempfängers) als Häkchen, Abrechnungszyklen „einmalig“ und
-- „je Ausführung“, Kostenstelle der Leistung = Objektnummer.

-- Kunde ist selbst Gebäudereiniger → Vorgabe § 13b für seine Rechnungen
alter table app.customers add column reverse_charge boolean not null default false;
-- Rechnung mit § 13b: alle Positionen 0 % (E-Rechnung Kategorie AE, Pflichthinweis § 14a Abs. 5 UStG)
alter table app.invoices add column reverse_charge boolean not null default false;

alter type app.billing_cycle add value if not exists 'einmalig';
alter type app.billing_cycle add value if not exists 'je_ausfuehrung';

update app.site_services v set cost_center = s.site_no
  from app.sites s where s.id = v.site_id and (v.cost_center is null or v.cost_center = '');
