-- Raumbuch aus Ausschreibungs-Kalkulationen (Ahmed 11.10.): Räume ohne Reinigung (Turnus „0“) gehören ins Raumbuch,
-- Turnus-Kürzel der Kalkulation (W5, M1, J2 …) wird festgehalten.
alter table app.rooms drop constraint rooms_visits_per_year_check;
alter table app.rooms add constraint rooms_visits_per_year_check check (visits_per_year between 0 and 1000);
alter table app.rooms add column turnus text check (turnus is null or length(turnus) <= 40);
