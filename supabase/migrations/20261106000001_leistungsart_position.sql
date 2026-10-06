-- Runde 10: Leistungsart je Rechnungsposition (wie Fortytools), für Auswertung/Nachkalkulation.
alter table app.invoice_lines add column service_type_id uuid references app.service_types (id);

-- Entwürfe: aus der Leistung des Objekts übernehmen (ausgestellte Positionen bleiben unverändert)
update app.invoice_lines l set service_type_id = s.service_type_id
  from app.site_services s, app.invoices i
 where s.id = l.source_service_id and i.id = l.invoice_id and i.status = 'draft'
   and l.service_type_id is null and s.service_type_id is not null;
