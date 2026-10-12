-- Pflichtunterlage „Unterweisung“ je Mitarbeiter abwählbar (Ahmed 12.10.).
alter table app.employees drop constraint if exists employees_docs_not_needed_chk;
alter table app.employees add constraint employees_docs_not_needed_chk
  check (docs_not_needed <@ array['Arbeitskleidung', 'Schlüssel', 'Unterweisung']::text[]);
