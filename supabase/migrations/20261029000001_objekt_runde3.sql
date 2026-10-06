-- Runde 3 (Ahmed 06.10.2026): Telefon der Benutzer (Objektleitung im Objektkopf), Aufgaben an Benutzer zuweisen.
alter table app.profiles add column phone text;

-- Abweichende E-Mail-Adressen für Mahnungen je Rechnungsgruppe (leer/null = Rechnungs-E-Mails)
alter table app.invoice_groups add column dunning_emails text[];
