-- Ahmed 06.10.2026: Sonntag und Feiertage 80 %, hohe Feiertage 200 % (Firmenvorgabe, unter Einstellungen änderbar).
alter table app.payroll_settings alter column sunday_bp set default 8000, alter column holiday_bp set default 8000;
update app.payroll_settings set sunday_bp = 8000, holiday_bp = 8000, high_holiday_bp = 20000
 where sunday_bp = 10000 and holiday_bp = 15000;
