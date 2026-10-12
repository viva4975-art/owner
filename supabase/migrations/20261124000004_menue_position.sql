-- Menü oben oder links je Benutzerkonto (Ahmed 12.10.: „für das Benutzerkonto, nicht Browser“); leer = oben (Standard)
alter table app.user_prefs add column if not exists menu_pos text check (menu_pos in ('oben', 'links'));
