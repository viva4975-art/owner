-- Materialausgabe: freie Positionen ohne angelegten Artikel (Ahmed 02.11.) – kein Lagerbestand, Kosten = eingegebener
-- EK × Menge, zählen in der Nachkalkulation wie Lagerartikel auf die Kostenstelle des Objekts.
alter table app.material_issue_lines alter column article_id drop not null;
