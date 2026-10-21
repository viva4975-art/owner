-- Eingangsrechnung direkt als bezahlt (Lastschrift, PayPal, Karte …): weitere Zahlarten
alter table app.incoming_invoices drop constraint if exists incoming_invoices_paid_method_check;
alter table app.incoming_invoices add constraint incoming_invoices_paid_method_check
  check (paid_method is null or paid_method in ('ueberweisung', 'lastschrift', 'bar', 'kreditkarte', 'ec_karte', 'paypal', 'verrechnung'));
