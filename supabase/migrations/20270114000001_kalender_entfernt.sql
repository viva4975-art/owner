-- Outlook-Kalender und Kalender-Abo entfernt (Ahmed 02.11.): gespeicherte Postfach-Zugänge (verschlüsselte Passwörter)
-- und Abo-Links werden gelöscht. Termine in Outlook selbst sind davon nicht betroffen.
drop table if exists app.exchange_accounts;
drop table if exists app.calendar_feeds;
