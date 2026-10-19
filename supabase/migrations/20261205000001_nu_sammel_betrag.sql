-- Sammelbestellung: fester Betrag je Objekt (wie in der alten App, z. B. Stadt Garching) – Ahmed 19.10.
-- Ist bei mindestens einem Objekt ein Betrag eingetragen, werden Pauschalen danach statt nach Fläche verteilt.
alter table app.subcontract_sites add column if not exists share_cents bigint check (share_cents >= 0);
