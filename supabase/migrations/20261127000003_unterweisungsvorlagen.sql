-- Unterweisungen als Textvorlagen (Ahmed 15.10.: „nicht aus der PDF, sondern Unterweisungen zum Auswählen wie eine
-- Word-Datei, die direkt unterschrieben wird“). Der Text wird beim Freigeben eingefroren (sign_documents.body) und als
-- PDF archiviert; in der App wird er direkt angezeigt und unterschrieben.
-- Format: Absätze durch Leerzeile, „## “ = Überschrift, „- “ = Aufzählungspunkt.
create table app.instruction_templates (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) > 0),
  category app.sign_category not null default 'unterweisung',
  body text not null check (length(trim(body)) > 0),
  active boolean not null default true,
  sort integer not null default 100,
  version integer not null default 1,
  created_by text not null default 'system',
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz
);
alter table app.instruction_templates enable row level security;
create policy instruction_templates_read on app.instruction_templates for select to authenticated
  using ((select app.is_hr()) or (select app.is_office()));
grant select on app.instruction_templates to authenticated;
grant all on app.instruction_templates to service_role;

alter table app.sign_documents add column body text;

insert into app.instruction_templates (id, title, category, sort, body) values
(md5('unterweisung:allgemein')::uuid, 'Allgemeine Unterweisung Arbeitsschutz', 'unterweisung', 10, $t$
Diese Unterweisung gilt für alle Beschäftigten der Viva-Deluxe Gebäudereinigung GmbH. Sie wird vor Arbeitsbeginn und danach mindestens einmal im Jahr wiederholt (§ 12 Arbeitsschutzgesetz).

## Allgemeines
- Arbeite nur in dem Objekt und zu den Zeiten, für die du eingeteilt bist. Halte dich an die Anweisungen der Objektleitung.
- Melde Unfälle, Beinahe-Unfälle, Schäden und Mängel sofort der Objektleitung.
- Alkohol, Drogen und berauschende Mittel sind während der Arbeit verboten. Wer Medikamente nimmt, die die Aufmerksamkeit beeinträchtigen, sagt dies der Objektleitung.
- Rauchen nur an den dafür erlaubten Stellen.

## Persönliche Schutzausrüstung
- Trage die gestellte Arbeitskleidung und rutschfeste, geschlossene Schuhe.
- Benutze Schutzhandschuhe bei Arbeiten mit Reinigungsmitteln und im Sanitärbereich, bei Spritzgefahr auch eine Schutzbrille.
- Beschädigte Schutzausrüstung sofort melden und austauschen lassen. Die Schutzausrüstung ist für dich kostenlos.

## Geräte und Maschinen
- Benutze nur Geräte, in die du eingewiesen wurdest. Prüfe Kabel, Stecker und Geräte vor jeder Benutzung auf Schäden.
- Defekte Geräte nicht benutzen, kennzeichnen und der Objektleitung melden. Keine eigenen Reparaturen.
- Ziehe den Stecker, bevor du ein Gerät reinigst oder Zubehör wechselst.

## Unfall und Erste Hilfe
- Bei einem Unfall: Unfallstelle sichern, Erste Hilfe leisten, Notruf 112, Objektleitung informieren.
- Jede Verletzung – auch eine kleine – wird im Verbandbuch eingetragen bzw. der Objektleitung gemeldet.
- Merke dir, wo im Objekt Verbandkasten, Feuerlöscher und Notausgänge sind.
$t$),
(md5('unterweisung:gefahrstoffe')::uuid, 'Gefahrstoffe und Reinigungsmittel', 'betriebsanweisung', 20, $t$
Reinigungsmittel können Haut, Augen und Atemwege schädigen. Für jedes Mittel gibt es ein Sicherheitsdatenblatt und eine Betriebsanweisung – sie liegen im Objektordner.

## So arbeitest du sicher
- Verwende nur die Reinigungsmittel, die dir die Firma gibt. Bringe keine eigenen Mittel mit.
- Dosiere genau nach Dosieranleitung bzw. Dosiersystem. Mehr Mittel reinigt nicht besser, schadet aber Haut und Oberflächen.
- Mische niemals verschiedene Reinigungsmittel – vor allem keine chlorhaltigen mit säurehaltigen Mitteln (giftiges Gas!).
- Fülle Mittel nur in richtig beschriftete Flaschen um, niemals in Getränkeflaschen.
- Trage Schutzhandschuhe, bei Spritzgefahr eine Schutzbrille.
- Sorge bei Arbeiten mit Mitteln für gute Lüftung.
- Behälter nach Gebrauch verschließen und im Putzraum aufbewahren, nicht für Unbefugte (z. B. Kinder in Schulen) zugänglich.

## Wenn etwas passiert
- Spritzer ins Auge: sofort mindestens 10 Minuten mit fließendem Wasser spülen, Arzt aufsuchen.
- Hautkontakt: mit viel Wasser abwaschen, verschmutzte Kleidung ausziehen.
- Verschluckt: Mund ausspülen, kein Erbrechen herbeiführen, Giftnotruf 089 19240 oder 112, Sicherheitsdatenblatt mitnehmen.
- Ausgelaufene Mittel mit Bindemittel bzw. Tüchern aufnehmen, Objektleitung informieren.
$t$),
(md5('unterweisung:hautschutz')::uuid, 'Hautschutz', 'unterweisung', 30, $t$
Feuchtarbeit und Reinigungsmittel belasten die Haut stark. Hauterkrankungen gehören in der Gebäudereinigung zu den häufigsten Berufskrankheiten.

## Hautschutzplan
- Vor der Arbeit und nach Pausen: Hautschutzcreme auftragen.
- Während der Arbeit: Schutzhandschuhe tragen. Hände vor dem Anziehen trocknen, bei längerem Tragen Baumwoll-Unterziehhandschuhe benutzen.
- Nach der Arbeit: Hände mild reinigen, gut abtrocknen, Pflegecreme auftragen.

## Wichtig
- Handschuhe innen sauber und trocken halten, beschädigte Handschuhe sofort wechseln.
- Ringe, Uhren und Armbänder bei der Arbeit ablegen.
- Melde Rötungen, Juckreiz oder rissige Haut früh der Objektleitung. Du kannst dich vom Betriebsarzt beraten lassen.
$t$),
(md5('unterweisung:leitern')::uuid, 'Leitern und Tritte', 'unterweisung', 40, $t$
Stürze von Leitern und Tritten führen oft zu schweren Verletzungen.

## Vor der Benutzung
- Benutze nur Leitern und Tritte der Firma oder des Objekts, die in Ordnung sind. Prüfe Holme, Sprossen, Füße und Spreizsicherung.
- Beschädigte Leitern nicht benutzen, sondern kennzeichnen und melden.
- Stelle die Leiter auf festen, ebenen, trockenen Boden. Stehleitern immer ganz aufspreizen.

## Bei der Arbeit
- Trage feste, rutschfeste Schuhe.
- Steige nicht auf die obersten zwei Sprossen einer Stehleiter.
- Lehne dich nicht seitlich hinaus – lieber die Leiter umstellen.
- Benutze niemals Stühle, Tische, Eimer oder Heizkörper als Ersatz für eine Leiter.
- Arbeiten in größerer Höhe (z. B. Glasreinigung außen) nur nach besonderer Einweisung und mit geeignetem Gerät.
$t$),
(md5('unterweisung:rutschgefahr')::uuid, 'Rutsch- und Sturzgefahr bei der Nassreinigung', 'unterweisung', 50, $t$
Nasse Böden sind für dich und für andere Personen gefährlich.

## So vermeidest du Unfälle
- Stelle bei Nassreinigung immer das Warnschild „Rutschgefahr“ gut sichtbar auf.
- Reinige Verkehrswege möglichst in Abschnitten, damit immer ein trockener Weg bleibt.
- Wische so, dass du dich nicht selbst einsperrst – von hinten zur Tür hin arbeiten.
- Kabel von Maschinen nicht quer über Wege legen, sonst sichern.
- Ausgelaufene Flüssigkeiten sofort aufnehmen.
- Trage rutschfeste Schuhe und gehe auf nassen Flächen langsam.
- Räume Eimer, Wagen und Geräte so ab, dass niemand darüber fällt.
$t$),
(md5('unterweisung:brandschutz')::uuid, 'Brandschutz und Verhalten im Notfall', 'unterweisung', 60, $t$
## Vorbeugen
- Fluchtwege, Notausgänge und Feuerlöscher niemals zustellen – auch nicht kurz mit dem Reinigungswagen.
- Brandschutztüren nicht festkeilen.
- Geräte nach Gebrauch ausschalten, Akkus nur unter Aufsicht und nach Herstellerangabe laden.

## Im Brandfall
- Ruhe bewahren. Feuerwehr 112 rufen: Wo? Was? Wie viele Verletzte? Warten auf Rückfragen.
- Andere Personen warnen, Brandmelder auslösen, wenn vorhanden.
- Nur löschen, wenn es ohne Gefahr möglich ist.
- Gebäude über den Fluchtweg verlassen, keinen Aufzug benutzen, Türen hinter dir schließen.
- Zum Sammelplatz gehen und dich bei der Objektleitung bzw. Feuerwehr melden.
$t$),
(md5('unterweisung:verschwiegenheit')::uuid, 'Verschwiegenheit und Datenschutz im Objekt', 'datenschutz', 70, $t$
In den Objekten unserer Kunden (Behörden, Schulen, Büros, Wohnungen) siehst du oft vertrauliche Unterlagen und persönliche Daten.

## Das gilt für dich
- Über alles, was du bei der Arbeit über Kunden, Objekte und deren Mitarbeitende erfährst, musst du schweigen – auch nach Ende des Arbeitsverhältnisses.
- Lies keine Akten, Briefe, Bildschirme oder Notizen. Öffne keine Schubladen und Schränke, die nicht zur Reinigung gehören.
- Mache keine Fotos von Räumen, Unterlagen oder Personen im Objekt (Ausnahme: Fotos für die Arbeit in der Firmen-App, z. B. Qualitätskontrolle, Schäden).
- Gib niemandem Zugang zum Objekt und lass keine fremden Personen mit hinein.
- Dokumente zur Vernichtung (Aktenvernichter, Datenschutztonnen) nur nach Anweisung behandeln.
- Verstöße können arbeitsrechtliche Folgen haben und strafbar sein. Melde Datenpannen (z. B. verlorene Schlüssel, offen liegende Unterlagen) sofort der Objektleitung.
$t$),
(md5('unterweisung:schluessel')::uuid, 'Umgang mit Schlüsseln und Zugangsmitteln', 'arbeitsanweisung', 80, $t$
Schlüssel, Karten und Codes für die Objekte sind sehr wertvoll. Ein Verlust kann den Austausch ganzer Schließanlagen bedeuten.

## Regeln
- Schlüssel und Karten nur gegen Unterschrift annehmen und zurückgeben.
- Schlüssel niemals weitergeben, verleihen oder nachmachen lassen.
- Schlüssel nicht mit Objektnamen oder Adresse kennzeichnen und nicht sichtbar im Auto liegen lassen.
- Alarmcodes nicht aufschreiben und niemandem sagen.
- Nach der Arbeit alle Türen und Fenster wie vorgegeben verschließen und die Alarmanlage scharf schalten.
- Verlust sofort – auch nachts – der Objektleitung melden.
$t$),
(md5('unterweisung:zeiterfassung')::uuid, 'Zeiterfassung mit der App', 'arbeitsanweisung', 90, $t$
Deine Arbeitszeit wird mit der Viva-Deluxe-App erfasst. Die Aufzeichnung ist gesetzlich vorgeschrieben (§ 17 Mindestlohngesetz) und Grundlage für deinen Lohn.

## So geht es
- Starte die Zeit, wenn du mit der Arbeit beginnst, und beende sie, wenn du fertig bist – nicht früher und nicht später.
- Bestätige geplante Einsätze nur, wenn du genau so gearbeitet hast. Abweichungen mit „Zeit anpassen“ melden.
- Pausen werden in der App angezeigt. Ab 6 Stunden Arbeit sind mindestens 30 Minuten Pause Pflicht, ab 9 Stunden 45 Minuten.
- Stempeln für andere Personen ist verboten.
- Unterschreibe am Monatsende deine Stundenliste in der App.
- Bei Problemen mit der App sofort die Objektleitung informieren.
$t$);
