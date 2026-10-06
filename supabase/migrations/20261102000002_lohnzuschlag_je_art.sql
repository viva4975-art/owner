-- Lohnzuschlag für die Nachkalkulation je Beschäftigungsart (Ahmed 06.10.2026):
-- Minijob 32 %, Teilzeit (9,01–30 Std./Woche) 28 %, über 30 Std./Woche 26 %. Der bisherige Einheitswert bleibt ungenutzt.
alter table app.accounting_settings
  add column overhead_minijob_bp integer not null default 3200 check (overhead_minijob_bp between 0 and 20000),
  add column overhead_parttime_bp integer not null default 2800 check (overhead_parttime_bp between 0 and 20000),
  add column overhead_fulltime_bp integer not null default 2600 check (overhead_fulltime_bp between 0 and 20000);
