-- Ahmed 11.10.2026: „lösch die alten Vorlagen komplett“ – deaktivierte Word-Vorlagen (alte Fassungen, entfallene
-- Vorlagen) werden gelöscht. Die .docx-Dateien bleiben write-once im Archiv (app.files), nur Vorlage + Verknüpfung
-- verschwinden. Künftig löscht das Hochladen einer neuen Fassung die alte gleich mit.
with weg as (
  delete from app.word_templates where not active returning id, name, code
), links as (
  delete from app.file_links l using weg where l.entity_type = 'word_template' and l.entity_id = weg.id
)
insert into app.audit_log (actor, action, entity, entity_id, details)
select 'migration', 'delete', 'word_template', null,
       jsonb_build_object('anzahl', count(*), 'vorlagen', jsonb_agg(coalesce(code, name)))
  from weg
having count(*) > 0;
