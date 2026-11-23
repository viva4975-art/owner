-- Akquise: Region (Ahmed 23.11.: Akquise in Stuttgart, Ingolstadt …). Leer = aus dem Ort erkannt.
alter table app.prospects add column if not exists region text;
