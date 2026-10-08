-- Ahmed 08.10.: Aus Word-Vorlagen erzeugte Dokumente beim Mitarbeiter sind Entwürfe – sie dürfen die Pflichtunterlage
-- (z. B. Arbeitsvertrag) nicht als „vorhanden“ abhaken. Bestehende Entwürfe in die Kategorie „Entwurf (aus Vorlage)“.
update app.file_links l
   set category = 'Entwurf (aus Vorlage)'
 where l.entity_type = 'employee'
   and l.file_id in (select (details ->> 'file')::uuid from app.audit_log
                      where action = 'word_template' and entity = 'employee' and details ? 'file');
