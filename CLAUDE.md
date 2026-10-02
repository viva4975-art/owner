# Viva-Deluxe – neue Betriebs-App (Ablösung Fortytools)

Diese Datei ist das Projekt-Briefing. Lies sie vollständig, bevor du etwas tust, und halte sie
aktuell (Entscheidungen, Stand, offene Punkte unten ergänzen). Original: `docs/briefing-original.pdf`.

## Wer, was, warum

- Auftraggeber: Ahmed Chomontek, Geschäftsführer der Viva-Deluxe Gebäudereinigung GmbH,
  Würmtalstr. 10, 81375 München (ab 01.11.2026 neues Büro), HRB 262 567, USt-ID DE341586171,
  Tel. +49 89 63855496, info@viva-deluxe-reinigung.de. Meisterbetrieb, ISO 9001 + 14001.
- Rund 120 Mitarbeitende, über 150 Objekte, überwiegend öffentliche Auftraggeber
  (Landeshauptstadt München, Freistaat Bayern, Kommunen, Bundeswehr) → XRechnung ist Alltag.
- Heute drei Systeme: Fortytools (Kunden, Objekte, Mitarbeiter, Ausgangsrechnungen inkl.
  E-Rechnung), eigene App (Supabase + Netlify, eine einzige index.html mit ~34.000 Zeilen),
  Lexware (nur Lohn).
- Ziel: Eine neue, sauber aufgebaute App wird das führende System. Fortytools wird danach
  gekündigt. Lohn bleibt bei Lexware, Buchhaltung beim Steuerberater (DATEV-Export).
- Kommunikation: Deutsch, direkt, handlungsorientiert. Rechtliche/steuerliche Risiken klar
  benennen. Keine langen Erklärungen, sondern bauen, testen, kurz berichten.

## Phase jetzt: Prototyp in 3–5 Tagen

Umfang des Prototyps (in dieser Reihenfolge):

1. Projekt-Grundgerüst: Git-Repo, TypeScript, Test- und Live-Konfiguration getrennt, Lint/Tests,
   README mit Start-Anleitung.
2. Datenbank in einem neuen Supabase-Projekt, Region Frankfurt (eu-central-1) – NICHT das laufende
   Projekt `essogronliskkfhocxst` (Irland) anfassen.
3. Kunden (inkl. Leitweg-ID, Rechnungs-E-Mails, gewünschtes Rechnungsformat, Zahlungsziel).
4. Objekte mit Leistungen und Preisen (monatliche Pauschalen, Sonderleistungen, Regiestunden).
5. Ausgangsrechnungen:
   - Monatslauf erzeugt Rechnungsentwürfe aus den Objektleistungen; Einzelrechnungen von Hand.
   - Lückenloser Nummernkreis in der Datenbank (Transaktion/Sequence), Format mit Ahmed abstimmen.
   - Nach Ausstellung unveränderbar. Korrektur nur über Stornorechnung (eigene Nummer, Verweis aufs
     Original) oder Rechnungskorrektur (Teilbeträge). Den Begriff „Gutschrift“ für Erstattungen an
     Kunden NICHT verwenden (umsatzsteuerlich = Abrechnung durch den Kunden).
   - Abschlags- und Schlussrechnung mit Verrechnung der Abschläge.
   - Ausgabe: PDF, ZUGFeRD (PDF/A-3 mit eingebettetem XML) und XRechnung (UBL oder CII).
   - Jede E-Rechnung wird vor dem Versand gegen den KoSIT-Validator geprüft; ungültig = kein Versand.
   - Storno/Korrektur auch als E-Rechnung mit korrekter Belegart.
   - Unveränderbares Archiv (PDF + XML), Aufbewahrung 10 Jahre (Object Lock o. ä.).
6. Versand per E-Mail: je Kunde Format (PDF / ZUGFeRD / XRechnung + PDF), mehrere Empfänger,
   Anhänge (Leistungsnachweise, Stundenzettel, Arbeitsscheine). Im Prototyp nur an eine
   Testadresse. Versandprotokoll (wann, an wen, welche Dateien). Jeder Versand genau einmal
   (idempotent).
7. Import einer Stichprobe echter Daten aus Fortytools (Ahmed liefert Exporte +
   Beispiel-XRechnungen).

**Abnahme Prototyp:** Eine echte Monatsrechnung eines Behörden-Objekts wird erzeugt, besteht
KoSIT, sieht aus wie heute aus Fortytools, lässt sich stornieren, geht mit Anhängen an die
Testadresse.

## Spätere Phasen (nicht jetzt bauen, aber Architektur darauf auslegen)

- Mitarbeiter-Stammdaten + Export an Lexware Lohn.
- Zeiterfassung: Stempeln per Handy (QR am Objekt), „Soll als Ist“ nur mit Bestätigung, Nachträge
  mit Freigabe durch Objektleitung, Änderungsprotokoll, Prüfbericht für den Zoll (§ 17 MiLoG:
  Beginn/Ende/Dauer binnen 7 Tagen, 2 Jahre aufbewahren). Mitarbeiter-Ansicht extrem einfach,
  mehrsprachig, Login per PIN.
- Automatische Nachkalkulation je Objekt/Monat (Erlös vs. eigene Stunden × Stundensatz,
  Nachunternehmer, Material).
- Dokumente digital unterschreiben (NICHT für Kündigungen § 623 BGB und Befristungen
  § 14 Abs. 4 TzBfG).
- Mahnwesen, DATEV-Export, Rechte je Objekt (Objektleiter sehen nur ihre Objekte).
- Übernahme der bestehenden Module der alten App (Nachunternehmer, Bestellungen BE-JJJJ-NNNN,
  Rechnungseingang, Zahlungslauf SEPA, Objektordner, Glasreinigung, Tiefgarage usw.).

## Technische Leitplanken

- Sauberer, modularer Aufbau; nichts Geschäftskritisches nur im Browser. Rechnungserzeugung,
  Nummernvergabe, Archiv, Versand und Monatsläufe laufen serverseitig.
- Datenbank: Supabase (Postgres, Auth, Storage), Region Frankfurt, Row Level Security überall.
- RLS-Funktionen immer als `(SELECT funktion())` schreiben (einmal pro Abfrage statt pro Zeile).
- Keine geheimen Schlüssel im Frontend. Service-Keys nur auf dem Server.
- Für E-Rechnung bewährte Bibliotheken nutzen (aktuelle Optionen prüfen und Ahmed kurz die Wahl
  begründen), KoSIT-Validator z. B. per Docker im Test und vor dem Versand.
- Netzwerk: In der alten App rissen Verbindungen zu Supabase immer wieder ab (Safari und Chrome).
  Deshalb: Zeitlimits + sichere Wiederholung, Schreibvorgänge idempotent (feste IDs / Upsert).
- Automatische Tests für Nummernkreis, Storno, Beträge (Cent-genau, keine Fließkomma-Fehler!),
  E-Rechnung-Validierung.
- Design: Viva-Deluxe-Bordeaux (#7D1435 / #8B2332), ruhig und klar; Oberfläche komplett Deutsch.
- Bankverbindungen der GmbH: Münchner Bank DE39 7019 0000 0003 2978 37 (GENODEF1M01),
  Targobank DE66 7019 0000 0003 1914 27 (CMCIDEDDXXX).

## Arbeitsweise

- Schritt für Schritt bauen, nach jedem Schritt kurz zeigen, was läuft und wie Ahmed es testet.
- Vor allem, was Daten löscht oder Live-Systeme berührt: erst fragen.
- Offene Fragen gesammelt stellen, nicht einzeln.
- Diese Datei bei jeder wichtigen Entscheidung ergänzen.

## Offene Punkte (von Ahmed zu liefern)

- [ ] Neues Supabase-Projekt (Frankfurt) + Zugangsdaten
- [ ] Fortytools-Export: Kunden, Objekte, Leistungen/Preise, 3–5 Beispielrechnungen inkl. XRechnung
- [ ] Gewünschtes Rechnungsnummern-Format
- [ ] Steuernummer, Lieferantennummern bei Behörden, Leitweg-IDs der Behörden-Kunden
- [ ] Absender-Adresse für Rechnungen (z. B. rechnung@viva-deluxe-reinigung.de) + Mail-Zugang
- [ ] Lexware-Lohnprogramm (genaue Bezeichnung, Importformat)

## Entscheidungen / Stand (laufend ergänzen)

- 2026-10: Entscheidung für eigene App statt Base44; Lohn bleibt Lexware; Supabase bleibt, neu in
  Frankfurt.
- 2026-10-02: Schritt 1 (Grundgerüst) erledigt. Node 22 + TypeScript (strict), Vitest, ESLint,
  Prettier, zod. Umgebungen über `APP_ENV=test|live`, Konfiguration wird beim Start validiert;
  das alte Projekt `essogronliskkfhocxst` und Nicht-Frankfurt-Regionen werden hart abgelehnt.
- 2026-10-02: Beträge immer als ganze Cent (`bigint`), Mengen mit 3 Nachkommastellen als ganze
  Zahl. Rundung kaufmännisch (half-up, weg von 0). USt wird je Steuersatz auf die Summe der
  Netto-Positionen gerechnet (EN 16931, BR-CO-17), nicht je Position.
