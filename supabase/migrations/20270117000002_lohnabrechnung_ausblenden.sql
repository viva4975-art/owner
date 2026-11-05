-- Lohnabrechnungen vom E-Mail-Versand ausnehmen (Ahmed 05.11.: „manche bekommen keine, weil sie sie schon haben oder
-- sonst was“): je Abrechnung ausgeblendet mit optionalem Grund, wieder einblendbar. Ändert nichts an Datei/Akte.
alter table app.payslips
  add column mail_skip_reason text check (mail_skip_reason is null or length(mail_skip_reason) <= 200),
  add column mail_skip_at timestamptz,
  add column mail_skip_by text;
