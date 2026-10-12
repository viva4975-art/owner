-- Pflichtunterlagen je Mitarbeiter abwählbar (Ahmed 12.10.: „manche haben keine Schlüssel“).
-- Nur Arbeitskleidung und Schlüssel; Arbeitsvertrag, Unterweisung (§ 12 ArbSchG) und Personalunterlagen bleiben Pflicht.
alter table app.employees add column if not exists docs_not_needed text[] not null default '{}';
alter table app.employees drop constraint if exists employees_docs_not_needed_chk;
alter table app.employees add constraint employees_docs_not_needed_chk
  check (docs_not_needed <@ array['Arbeitskleidung', 'Schlüssel']::text[]);
