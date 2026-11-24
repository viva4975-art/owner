-- Höchstens n Personen je Objekt gleichzeitig abwesend (Warnung beim Eintragen/Genehmigen, Ahmed 24.11.);
-- null = keine Warnung.
alter table app.time_settings add column if not exists leave_max_absent integer default 2
  check (leave_max_absent is null or leave_max_absent between 1 and 50);
