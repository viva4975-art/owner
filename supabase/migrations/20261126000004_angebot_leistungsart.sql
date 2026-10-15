-- Angebot: Leistungsart je Position (Ahmed 15.10.) – wird bei Übernahme ins Objekt, Auftrag und Rechnung mitgenommen
alter table app.offer_lines add column if not exists service_type_id uuid references app.service_types (id);
