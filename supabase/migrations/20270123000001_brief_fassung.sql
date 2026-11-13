-- Briefe bearbeiten (Ahmed 13.11.): eine bearbeitete Fassung ist ein neuer Brief mit Verweis auf den alten
-- (der alte bleibt unverändert, PDF write-once).
alter table app.letters add column if not exists based_on uuid references app.letters (id);
