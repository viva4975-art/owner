-- Gesamtimport der Fortytools-Exporte (Kunden, Objekte, Leistungen, Mitarbeiter in einem Lauf).
alter table app.data_imports drop constraint if exists data_imports_kind_check;
alter table app.data_imports add constraint data_imports_kind_check
  check (kind in ('kunden', 'objekte', 'leistungen', 'fortytools'));
