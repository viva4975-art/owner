-- Urlaub automatisch (Ahmed 12.10.): Anspruch laut Rahmentarifvertrag 30 Tage bei 5-Tage-Woche für alle,
-- Arbeitstage pro Woche aus den Stammdaten (von Hand gesetzt) oder automatisch aus der Einsatzplanung.
alter table app.employees add column if not exists days_auto boolean not null default true;

-- Wer bisher bewusst andere Arbeitstage als 5 eingetragen hat, behält sie (von Hand gesetzt).
update app.employees e set days_auto = false
 where exists (select 1 from app.employee_hours h
                where h.employee_id = e.id and h.days_per_week is not null and h.days_per_week <> 5)
    or e.days_per_week <> 5;

-- Einheitlich 30 Tage (bei 5-Tage-Woche); Abweichungen aus Fortytools waren Fehlerquelle.
update app.employees set annual_leave_days = 30 where annual_leave_days is distinct from 30;
