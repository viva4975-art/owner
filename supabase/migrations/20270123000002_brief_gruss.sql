-- Briefe: Grußformel frei mit Zeilenumbrüchen (Ahmed 13.11.); leer = „Mit freundlichen Grüßen“ + Ansprechpartner + Firma.
alter table app.letters add column if not exists closing text check (closing is null or length(closing) <= 600);
