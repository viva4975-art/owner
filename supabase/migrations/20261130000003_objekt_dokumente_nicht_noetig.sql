-- Pflichtdokumente am Objekt (Raumbuch, LV, Revierplan) je Objekt als „nicht nötig“ markieren (Ahmed 17.10.)
alter table app.sites add column if not exists docs_not_needed text[] not null default '{}';
