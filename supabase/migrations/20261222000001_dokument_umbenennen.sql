-- Dokumente umbenennen (Ahmed 25.10.): angezeigter Name je Verknüpfung. Die Datei selbst bleibt write-once
-- (app.files.original_name unverändert, Prüfsumme gleich) – geändert wird nur, wie sie in der Akte heißt.
alter table app.file_links
  add column if not exists display_name text check (display_name is null or length(display_name) between 1 and 255),
  add column if not exists renamed_at timestamptz,
  add column if not exists renamed_by text;
