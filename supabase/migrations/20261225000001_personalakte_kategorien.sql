-- Personalakte: weniger Kategorien (Ahmed 26.10.: „zu viele, zusammenfassen“).
-- Arbeitsvertrag = Vertrag & alle Änderungen (Zusatzvereinbarung, Nutzungsüberlassung, Abmahnung, Beendigung, Briefe);
-- Personalunterlagen = alles Persönliche (Aufenthalt, Bescheinigung, Führerschein, Einwilligung, Sonstiges …).
-- Lohnabrechnung, Unterweisung, Arbeitskleidung, Schlüssel und „Entwurf (aus Vorlage)“ bleiben.
-- Nur die Zuordnung (file_links.category) ändert sich, die Dateien bleiben unverändert. Alter Stand im Protokoll.

insert into app.audit_log (actor, action, entity, entity_id, details)
select 'migration', 'kategorien_zusammengefasst', 'employee', l.entity_id,
       jsonb_build_object('file_id', l.file_id, 'kategorie_alt', l.category)
  from app.file_links l
 where l.entity_type = 'employee'
   and coalesce(l.category, '') <> all (array['Arbeitsvertrag', 'Personalunterlagen', 'Lohnabrechnung', 'Unterweisung',
                                              'Arbeitskleidung', 'Schlüssel', 'Entwurf (aus Vorlage)']);

update app.file_links l
   set category = case
         when l.category in ('Vertragsänderung', 'Nutzungsüberlassung', 'Abmahnung', 'Beendigung', 'Schriftverkehr')
           then 'Arbeitsvertrag'
         when l.category like 'Arbeitskleidung%' then 'Arbeitskleidung'
         else 'Personalunterlagen'
       end
 where l.entity_type = 'employee'
   and coalesce(l.category, '') <> all (array['Arbeitsvertrag', 'Personalunterlagen', 'Lohnabrechnung', 'Unterweisung',
                                              'Arbeitskleidung', 'Schlüssel', 'Entwurf (aus Vorlage)']);

update app.word_templates
   set category = case
         when category in ('Vertragsänderung', 'Nutzungsüberlassung', 'Abmahnung', 'Beendigung') then 'Arbeitsvertrag'
         else 'Personalunterlagen'
       end
 where audience = 'mitarbeiter'
   and category not in ('Arbeitsvertrag', 'Personalunterlagen', 'Lohnabrechnung', 'Unterweisung', 'Arbeitskleidung',
                        'Schlüssel');

update app.document_templates
   set category = case
         when category in ('Vertragsänderung', 'Nutzungsüberlassung', 'Abmahnung', 'Beendigung') then 'Arbeitsvertrag'
         else 'Personalunterlagen'
       end
 where audience = 'mitarbeiter'
   and category not in ('Arbeitsvertrag', 'Personalunterlagen', 'Lohnabrechnung', 'Unterweisung', 'Arbeitskleidung',
                        'Schlüssel');
