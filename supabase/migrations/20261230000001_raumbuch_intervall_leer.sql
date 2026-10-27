-- Raumbuch (Ahmed 27.10.): Steht in der importierten Datei kein Intervall bzw. keine Reinigungstage, bleibt das Feld leer
-- (statt 260 × im Jahr anzunehmen). Ausgedacht wird nichts – eintragen im Raum oder in der Datei.
alter table app.rooms alter column visits_per_year drop not null;
-- Reinigungstage aus Kalkulationen haben Nachkommastellen (184,5 / 38,33) → genau übernehmen statt ablehnen/runden.
alter table app.rooms alter column visits_per_year type numeric(7,2);
