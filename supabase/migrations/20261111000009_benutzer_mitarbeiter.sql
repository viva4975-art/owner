-- Büro/Objektleitung stempeln selbst (Ahmed 07.10.): Benutzerkonto ↔ Mitarbeiter-Datensatz. Mit der Büro-Anmeldung
-- ist die eigene Zeiterfassung (/m) ohne zweite Anmeldung erreichbar – in der App und am PC.
alter table app.profiles add column employee_id uuid unique references app.employees (id) on delete set null;
