-- Arbeitstage pro Woche mit Verlauf (Ahmed 11.10.: „ab 01.11. nicht mehr 5 Tage, sondern weniger – dadurch weniger Urlaub“).
-- Urlaubsanspruch der Stammdaten gilt für eine 5-Tage-Woche; je Monat zählt er anteilig nach den dann gültigen
-- Arbeitstagen (BUrlG: Umrechnung Jahresurlaub × Arbeitstage ÷ 5; vor der Änderung erworbener Urlaub bleibt erhalten).
alter table app.employees add column days_per_week numeric(2, 1) not null default 5
  check (days_per_week between 0.5 and 7);
alter table app.employee_hours add column days_per_week numeric(2, 1)
  check (days_per_week is null or days_per_week between 0.5 and 7);
