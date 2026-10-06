-- Import aus der alten App: Herkunft der Nachunternehmer (idempotent)
alter table app.suppliers add column if not exists legacy_id text unique;
