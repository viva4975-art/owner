-- Kontoumsätze (Ahmed 08.10.): alles erkennen – Eingangsrechnungen auch mit Skonto-Abzug und Verrechnung mit
-- Rechnungskorrekturen (Minusbeträge) des Lieferanten; Ausgaben ohne Rechnung bekommen eine Kostenart für die Ausgaben-Statistik.

-- Rechnungskorrektur des Lieferanten (Minusbetrag), die mit einer Zahlung verrechnet wird: Zahlbetrag negativ
alter table app.incoming_invoices drop constraint incoming_invoices_paid_amount_cents_check;
alter table app.incoming_invoices add constraint incoming_invoices_paid_amount_cents_check
  check (paid_amount_cents is null or paid_amount_cents >= 0 or gross_cents < 0);

-- Kostenart einer Ausgabe ohne Eingangsrechnung (Kartenzahlung, Gebühren, Steuern …)
alter table app.bank_transactions add column expense_category text
  check (expense_category in ('material', 'nachunternehmer', 'geraete', 'fahrzeuge', 'miete', 'sonstiges',
                              'personal', 'steuern', 'versicherung', 'bank', 'privat'));
