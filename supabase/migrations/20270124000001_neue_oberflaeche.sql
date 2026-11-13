-- Neue Oberfläche (Ahmed 13.11.2026, nach Vorbild Blink): je Benutzer umschaltbar, Standard „neu“.
-- „alt“ = bisherige Oberfläche (Rücksprung ohne Code-Änderung). Nur ergänzt, nichts gelöscht.
alter table app.user_prefs add column if not exists ui text check (ui in ('neu', 'alt'));
