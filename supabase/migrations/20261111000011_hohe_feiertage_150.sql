-- Ahmed 08.10.2026: RTV-Sätze übernehmen – Sonntag/Feiertag 80 %, hohe Feiertage 150 % (statt 200 %).
-- Nur ändern, wenn noch der alte Vorgabewert eingestellt ist (eigene Änderungen unter Einstellungen bleiben).
update app.payroll_settings set high_holiday_bp = 15000 where high_holiday_bp = 20000;
