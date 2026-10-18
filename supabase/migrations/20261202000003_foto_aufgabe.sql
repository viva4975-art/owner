-- Fotogruppen kommen als Aufgabe für Admin an (Ahmed 18.10.), nicht mehr ins Objekt oder in den Dokumenteneingang.
alter type app.entity_type add value if not exists 'photo_group';
