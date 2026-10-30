-- Regie in der NU-Bestellung (Ahmed 30.10.): Regie-Stundensatz direkt in der Bestellung; Regiestunden im
-- Stundennachweis (auch bei Pauschale/je m²), bei Sammelbestellungen einem Objekt zugeordnet.
alter table app.subcontracts add column regie_rate_cents bigint check (regie_rate_cents is null or regie_rate_cents >= 0);
alter table app.subcontract_hours add column regie boolean not null default false;
alter table app.subcontract_hours add column site_id uuid references app.sites (id);
