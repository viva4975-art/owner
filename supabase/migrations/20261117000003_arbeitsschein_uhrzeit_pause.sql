-- Arbeitsschein: Stundenzeilen wahlweise mit Uhrzeit von–bis und Pause (Ahmed 09.10.); Stunden bleiben maßgeblich.
alter table app.work_report_lines
  add column if not exists time_from time,
  add column if not exists time_to time,
  add column if not exists break_minutes integer check (break_minutes is null or break_minutes between 0 and 600);
