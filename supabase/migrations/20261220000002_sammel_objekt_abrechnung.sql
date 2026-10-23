-- Sammelbestellung: Abrechnung je Objekt „je m²“ oder „Pauschale“ (Ahmed 23.10.: wie unser Auftrag am Objekt)
alter table app.subcontract_sites
  add column if not exists mode text check (mode in ('qm', 'pauschale')),
  add column if not exists rate_cents bigint check (rate_cents is null or rate_cents >= 0);
comment on column app.subcontract_sites.mode is 'Abrechnung dieses Objekts: qm = Preis je m² × Fläche, pauschale = fester Betrag (share_cents); leer = wie die Bestellung';
comment on column app.subcontract_sites.rate_cents is 'Preis je m² für dieses Objekt (Cent); leer = Preis der Bestellung';
