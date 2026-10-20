-- Schlüssel löschen (Ahmed 20.10.): ohne Bewegungen wird der Schlüssel ganz gelöscht; mit Ausgabe-/Rückgabe-Protokoll
-- bleibt er als Nachweis erhalten und wird nur ausgeblendet (Nummer wird nicht wieder vergeben).
alter table app.keys add column deleted_at timestamptz;
alter table app.keys add column deleted_by text;
