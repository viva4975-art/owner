-- Geschwindigkeit (Ahmed 08.10.: „Seite lädt sehr langsam“): app.legacy_open_items sucht je Fortytools-Rechnung die
-- Rechnungen derselben Gruppe (ft_root_id) – ohne Index 0,6 s je Abfrage bei 3.200 Rechnungen, mit Index ~3 ms.
create index if not exists legacy_invoices_ft_root_idx on app.legacy_invoices (ft_root_id);
-- Ausgaben-Statistik und Kontoauszug
create index if not exists incoming_invoices_bank_tx_idx on app.incoming_invoices (bank_transaction_id) where bank_transaction_id is not null;
create index if not exists bank_transactions_account_date_idx on app.bank_transactions (account_iban, booking_date);
