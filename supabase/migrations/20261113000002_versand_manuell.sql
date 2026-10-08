-- Rechnungen ohne E-Mail-Adresse: Versand von Hand vermerken (Post, persönlich übergeben …), Kanal „manuell“
alter table app.invoice_deliveries drop constraint if exists invoice_deliveries_channel_check;
alter table app.invoice_deliveries
  add constraint invoice_deliveries_channel_check check (channel in ('email', 'portal', 'manuell'));
