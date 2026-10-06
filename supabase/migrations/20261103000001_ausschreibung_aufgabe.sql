-- Ausschreibungen mit Abgabefrist erscheinen als Aufgabe (Ahmed: kein eigener Menüpunkt mehr, Hinweis in der Übersicht).
alter type app.entity_type add value if not exists 'tender';
