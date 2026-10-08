-- Versandweg je Rechnungsgruppe: E-Mail (Standard) oder Portal des Auftraggebers (z. B. Patentamt). Bei „Portal“
-- wird nicht gemailt: XRechnung herunterladen, im Portal hochladen, dann in der App als hochgeladen vermerken
-- (Versandprotokoll mit Kanal „portal“, Zeitpunkt, Benutzer, Upload-Referenz).
alter table app.invoice_groups
  add column if not exists delivery_channel text not null default 'email' check (delivery_channel in ('email', 'portal')),
  add column if not exists portal_name text;
alter table app.invoice_deliveries
  add column if not exists channel text not null default 'email' check (channel in ('email', 'portal')),
  add column if not exists portal_reference text,
  add column if not exists recorded_by text;
