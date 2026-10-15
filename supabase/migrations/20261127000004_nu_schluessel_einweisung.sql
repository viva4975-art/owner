-- Nachunternehmer bei festen Aufträgen (Ahmed 15.10.): Schlüssel, Arbeitskleidung und eine eigene Objekteinweisung
-- unterschreiben lassen. Schlüssel können jetzt auch bei einem Nachunternehmer liegen (Schlüsselbuch).
alter table app.keys add column holder_supplier_id uuid references app.suppliers (id);
alter table app.keys add constraint keys_one_holder check (holder_employee_id is null or holder_supplier_id is null);
alter table app.key_log add column supplier_id uuid references app.suppliers (id);

insert into app.instruction_templates (id, title, category, sort, body) values
(md5('unterweisung:einweisung-nu')::uuid, 'Objekteinweisung Nachunternehmer', 'arbeitsanweisung', 100, $t$
Diese Einweisung gilt für den Nachunternehmer und alle Personen, die er im Objekt einsetzt. Der Nachunternehmer gibt den Inhalt an seine Beschäftigten weiter und unterweist sie selbst (§ 12 ArbSchG); wir stimmen die Arbeiten nach § 8 ArbSchG mit ihm ab.

## Objekt und Ablauf
- Arbeiten nur im beauftragten Umfang, in den vereinbarten Zeiten und Bereichen.
- Ansprechpartner vor Ort ist unsere Objektleitung. Änderungen, Mängel und Schäden sofort melden.
- Leistungsnachweise bzw. Arbeitsscheine wie vereinbart führen.

## Zugang und Schlüssel
- Schlüssel, Karten und Codes nur gegen Unterschrift, nicht weitergeben, nicht nachmachen lassen.
- Verlust sofort melden. Türen, Fenster und Alarmanlage nach der Arbeit wie vorgegeben schließen.

## Arbeitsschutz
- Nur eingewiesene Personen mit geeigneter Schutzausrüstung einsetzen.
- Reinigungsmittel nur nach Sicherheitsdatenblatt und Betriebsanweisung verwenden, nichts mischen, Behälter beschriften und sicher aufbewahren.
- Fluchtwege, Notausgänge und Feuerlöscher freihalten. Lage von Erste-Hilfe-Material, Feuerlöscher und Sammelplatz ist bekannt.
- Unfälle und Beinahe-Unfälle sofort melden.

## Verschwiegenheit und Datenschutz
- Über Unterlagen, Daten und Vorgänge im Objekt ist Stillschweigen zu bewahren. Keine Fotos von Räumen, Unterlagen oder Personen.

## Nachweise
- Der Nachunternehmer hält seine Nachweise (u. a. Mindestlohn, Sozialversicherung, Gewerbe) aktuell und legt sie auf Anforderung vor.
$t$);
