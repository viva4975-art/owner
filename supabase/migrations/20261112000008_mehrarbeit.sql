-- Mehrarbeitszuschlag (RTV Gebäudereinigung § 10): Arbeit über die regelmäßige wöchentliche Arbeitszeit
-- (39 Std. bei Vollzeit) hinaus, 25 %. Schwelle 0 = aus.
alter table app.payroll_settings
  add column if not exists overtime_weekly_minutes integer not null default 2340 check (overtime_weekly_minutes between 0 and 4800),
  add column if not exists overtime_bp integer not null default 2500 check (overtime_bp between 0 and 50000);
