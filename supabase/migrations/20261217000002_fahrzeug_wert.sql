-- Fahrzeuge: geschätzter heutiger Wert (für die Gesamtsumme in der Fahrzeugliste).
alter table app.vehicles
  add column estimated_value_cents bigint check (estimated_value_cents is null or estimated_value_cents >= 0),
  add column estimated_on date;
