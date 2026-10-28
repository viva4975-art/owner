-- Antragsdatum je Abwesenheit (Ahmed 28.10.): steht auf dem gedruckten Urlaubsantrag als Unterschriftsdatum.
-- Leer = Antrag ohne erfasstes Datum (Ausdruck nimmt dann Beginn − 5 Tage).
alter table app.absences add column if not exists applied_on date;
