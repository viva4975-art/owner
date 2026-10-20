-- Rückgabe auf eigenem Protokoll (Ahmed 20.10.: „Rückgabe separat und unterschrieben, nicht auf demselben Zettel“).
alter table app.key_protocols add column kind text not null default 'ausgabe'
  check (kind in ('ausgabe', 'rueckgabe'));
