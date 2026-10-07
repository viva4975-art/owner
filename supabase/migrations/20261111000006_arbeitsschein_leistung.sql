-- Arbeitsschein wie die alte App (Runde 23): Leistung aus dem Leistungskatalog des Objekts wählen (Preis wird
-- eingefroren), Regiestunden je Person (Name), PDF ohne Unterschrift, daraus eine Rechnung.
alter table app.work_report_lines
  add column service_id uuid references app.site_services (id),
  add column person text,
  add column unit_price_cents bigint check (unit_price_cents is null or unit_price_cents >= 0);
