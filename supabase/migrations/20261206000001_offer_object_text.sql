-- Angebot: Objekt als Freitext (Info auf dem Angebot), wenn kein Objekt angelegt/gewählt ist
alter table app.offers add column if not exists object_text text check (char_length(object_text) <= 500);
