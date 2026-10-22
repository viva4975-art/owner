-- Ausschreibungssuche wieder entfernt (Ahmed 22.10.: „lösch das, läuft zu unsicher“). Übernommene Ausschreibungen bleiben
-- in app.tenders erhalten; gelöscht werden nur die Such-Treffer, Abruf-Protokoll, Einstellungen und der Orts-Zwischenspeicher.
drop table if exists app.tender_feed_hits;
drop table if exists app.tender_feed_runs;
drop table if exists app.tender_feed_settings;
drop table if exists app.geo_cache;
