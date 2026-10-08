-- Eingehende E-Rechnungen (XRechnung/ZUGFeRD): Verweis auf die Originaldatei (write-once im Archiv) und die
-- gelesenen Daten (Verkäufer, Positionen, Steueraufschlüsselung) zur Anzeige. Je Datei höchstens eine Eingangsrechnung.
alter table app.incoming_invoices
  add column if not exists einvoice_file_id uuid references app.files (id),
  add column if not exists einvoice jsonb;
create unique index if not exists incoming_invoices_einvoice_file on app.incoming_invoices (einvoice_file_id)
  where einvoice_file_id is not null;
