-- Personalbogen (Ahmed 15.10.): Fotos von Ausweis, Krankenkassenkarte, Bankkarte usw. werden am Handy aufgenommen
-- und als ein PDF abgelegt. Die Datei hängt zunächst am Bogen (nur Personal/Admin über eigene Route) und wird beim
-- Anlegen des Mitarbeiters an die Personalakte gehängt.
alter table app.personnel_forms add column docs_file_id uuid references app.files (id);

alter table app.file_links drop constraint file_links_entity_type_check;
alter table app.file_links add constraint file_links_entity_type_check
  check (entity_type in ('offer', 'invoice', 'customer', 'site', 'employee', 'supplier', 'incoming_invoice',
                         'purchase_order', 'order', 'work_report', 'quality_check', 'inbox', 'tender', 'note',
                         'legacy_import', 'vehicle', 'word_template', 'personnel_form'));
