-- Versandweg „kein Versand“ je Rechnungsgruppe (Ahmed 09.10.: z. B. Landeshauptstadt München will keine Zusendung):
-- mit dem Ausstellen wird die Rechnung automatisch als versendet vermerkt (Versandprotokoll Kanal „keiner“).
alter table app.invoice_groups drop constraint if exists invoice_groups_delivery_channel_check;
alter table app.invoice_groups
  add constraint invoice_groups_delivery_channel_check check (delivery_channel in ('email', 'portal', 'keiner'));
alter table app.invoice_deliveries drop constraint if exists invoice_deliveries_channel_check;
alter table app.invoice_deliveries
  add constraint invoice_deliveries_channel_check check (channel in ('email', 'portal', 'manuell', 'keiner'));
