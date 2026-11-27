-- Arbeitsschein ohne Objektzuordnung (Ahmed 27.11.): Schein beim Kunden (Objekt „Allgemein“ als Kostenstelle),
-- Einsatzort optional als Text (erscheint im PDF statt der Objektanschrift).
alter table app.work_reports add column if not exists place_text text;
comment on column app.work_reports.place_text is 'Einsatzort als Text (Arbeitsschein ohne eigenes Objekt)';
