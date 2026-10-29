-- Rechnungsgruppe: genau eine Datei je E-Mail (z. B. Deutsche Bahn) – Anlagen werden in die Rechnungsdatei eingebettet
alter table app.invoice_groups add column if not exists single_file boolean not null default false;
