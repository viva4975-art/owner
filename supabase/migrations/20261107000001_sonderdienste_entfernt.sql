-- Ahmed 07.10.2026: Modul „Sonderdienste“ entfällt (ersetzt durch Glasreinigung, Tiefgarage, Grundreinigung).
-- Daten und Tabellen werden gelöscht. Rechnungen und Arbeitsscheine bleiben unberührt (die Termine verwiesen nur auf sie,
-- nicht umgekehrt); archivierte Aushang-PDFs bleiben write-once im Archiv.
drop table if exists app.special_service_runs;
drop table if exists app.special_services;
