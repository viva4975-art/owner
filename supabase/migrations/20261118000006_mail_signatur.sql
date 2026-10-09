-- E-Mail-Signatur (Ahmed 09.10.: Test-Mail wie beim Kunden, mit Signatur). Leer = automatisch aus den Firmendaten
-- (inkl. Pflichtangaben nach § 35a GmbHG: Rechtsform, Sitz, Registergericht, HRB, Geschäftsführer).
alter table app.company add column if not exists mail_signature text;
