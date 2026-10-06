-- Upload des Backups der alten App (ZIP oder Teile) für den Altdaten-Import
alter table app.file_links drop constraint file_links_entity_type_check;
alter table app.file_links add constraint file_links_entity_type_check
  check (entity_type in ('offer', 'invoice', 'customer', 'site', 'employee', 'supplier', 'incoming_invoice',
                         'purchase_order', 'order', 'work_report', 'quality_check', 'inbox', 'tender', 'note',
                         'legacy_import'));
