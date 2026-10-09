-- Einsatz: „auch an Sonn- und Feiertagen“ (Ahmed 09.10.): Standard aus → an Feiertagen wird nicht gearbeitet
-- (bezahlter Feiertag), Sonn-/Feiertagszuschläge nur für Zeiten zu Einsätzen mit Häkchen.
alter table app.shift_plans add column if not exists holiday_work boolean not null default false;
-- Sonntags-Einsätze sind per Definition Sonntagsarbeit
update app.shift_plans set holiday_work = true where weekday = 7 and not holiday_work;
