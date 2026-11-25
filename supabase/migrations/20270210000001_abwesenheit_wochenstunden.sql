-- Abwesenheit „Stunden ohne Einsatz“ (Ahmed 25.11.): statt nach Einsatzplan nach Wochenstunden ÷ Tage/Woche,
-- dazu Objekt/Kostenstelle für die Stunden (z. B. Urlaubsausgleich nach Beendigung der Einsätze).
alter table app.absences
  add column if not exists hours_weekly_minutes integer check (hours_weekly_minutes between 1 and 4800),
  add column if not exists hours_days numeric(3, 1) check (hours_days > 0 and hours_days <= 7),
  add column if not exists site_id uuid references app.sites (id);
