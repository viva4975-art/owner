-- Stundennachweis (Ahmed 03.11.): Zeilen über Mitternacht in einer Zeile, z. B. 18:30–00:30 (Ende vor Beginn = am
-- Folgetag). Nur Beginn = Ende bleibt unzulässig.
alter table app.site_timesheet_rows drop constraint if exists site_timesheet_rows_check;
alter table app.site_timesheet_rows add constraint site_timesheet_rows_times check (end_time <> start_time);
