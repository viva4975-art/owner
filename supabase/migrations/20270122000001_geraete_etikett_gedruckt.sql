-- Geräte-Etiketten: wann zuletzt gedruckt (Ahmed 09.11.: „sehen, welche noch nicht gedruckt sind“)
alter table app.devices add column if not exists label_printed_at timestamptz;
alter table app.devices add column if not exists label_printed_by text;
