-- Ahmed 08.10.: „aus Fortytools“ soll bei Kunden, Objekten, Rechnungen und Stundenliste nicht mehr zu sehen sein.
-- Nur Hinweistexte aus dem Import werden bereinigt; Beträge, Zeiten und Nummern bleiben unverändert.

update app.sites set name = 'Allgemein', updated_at = now() where name = 'Allgemein (aus Fortytools)';

update app.customers
   set warning = nullif(trim(regexp_replace(warning, 'Fortytools: (Zahlungsbedingung)', '\1', 'g')), '')
 where warning like '%Fortytools: Zahlungsbedingung%';
update app.customers set notes = null where notes = 'Import aus Fortytools';

update app.site_services
   set note = nullif(trim(regexp_replace(regexp_replace(regexp_replace(note,
               '(^|\n)Fortytools-Auftrag [0-9]+', '', 'g'),
               '( · )?abgelöst durch Leistungen aus dem Fortytools-CSV-Export', '', 'g'),
               '( · )?ersetzt durch Abgleich mit Fortytools-Rechnung [0-9-]+', '', 'g')), '')
 where note ~ 'Fortytools';

update app.shift_plans set note = 'aus erfassten Zeiten abgeleitet' where note = 'aus Fortytools-Zeiten abgeleitet';

-- Notiz der übernommenen Zeiten: „aus Fortytools · …“ → nur Beschreibung/Link (ändert keine Zeit, Protokoll bleibt)
do $$
begin
  perform set_config('app.actor', 'Bereinigung Importtexte', true);
  update app.time_entries
     set note = nullif(regexp_replace(note, '^aus Fortytools( · )?', ''), '')
   where note like 'aus Fortytools%';
end $$;

