-- Geschwärzter Stundennachweis mit der Rechnung (Ahmed 20.10.): je Leistung ankreuzbar (z. B. Unterhaltsreinigung).
-- Beim Ausstellen wird für das Objekt ein PDF der erfassten Zeiten im Leistungszeitraum (Namen geschwärzt) angehängt.
alter table app.site_services add column if not exists attach_timesheet boolean not null default false;
