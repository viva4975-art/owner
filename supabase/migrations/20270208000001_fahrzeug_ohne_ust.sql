-- Fahrzeugverkauf: Steuerart „ohne“ (ohne Umsatzsteuer, Ahmed 24.11.)
alter table app.vehicle_sales drop constraint if exists vehicle_sales_tax_mode_check;
alter table app.vehicle_sales
  add constraint vehicle_sales_tax_mode_check
  check (tax_mode in ('ust19', 'ig', 'export', 'frei28', 'ohne'));
