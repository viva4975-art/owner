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
      (auch als PDF – für den Layout-Abgleich „sieht aus wie heute“)
- [ ] Bestätigen: Nummernkreis von Fortytools fortführen (umgesetzt, Startwert vor Live-Start setzen)
- [ ] Lieferantennummern bei Behörden, Leitweg-IDs der Behörden-Kunden (Steuernummer 143/190/63154 vom Briefpapier übernommen)
- [ ] Absender-Adresse für Rechnungen (z. B. rechnung@viva-deluxe-reinigung.de) + Mail-Zugang (SMTP)
- [ ] Testadresse für den Prototyp-Versand
- [ ] Lexware-Lohnprogramm (genaue Bezeichnung, Importformat)
- [ ] Fortytools: eine Rechnungsgruppe von innen zeigen (dort stecken vermutlich die Preise je Objekt)
- [ ] Briefpapier ab 01.11.2026 (neue Adresse) als Datei vom Grafiker, 300 dpi
- [ ] Mit Steuerberater klären: Belegart 384 für Storno/Korrektur; Bedarf § 13b (Reverse Charge)
- [ ] Je Behörde klären: nimmt sie XRechnung per E-Mail an oder nur über ein Portal (ZRE/OZG-RE, Peppol)?

## Risiken (rechtlich/steuerlich)

- **E-Rechnungspflicht B2B:** Ab 01.01.2027 dürfen Unternehmen mit mehr als 800.000 € Vorjahresumsatz an
  inländische Geschäftskunden keine reinen PDF-Rechnungen mehr senden (ab 2028 alle). Kundenformat „PDF“
  ist dann nur noch für Privatkunden zulässig → Firmenkunden bis Ende 2026 auf ZUGFeRD/XRechnung umstellen.
- **§ 13b UStG:** Reinigungsleistungen an andere Gebäudereiniger unterliegen ggf. dem Reverse-Charge-
  Verfahren (0 % + Pflichthinweis). Im Prototyp bewusst gesperrt (0 % wird abgelehnt).
- **Archiv:** Supabase Storage kennt kein Object Lock. Für 10 Jahre revisionssichere Aufbewahrung (GoBD)
  zusätzlich S3-kompatiblen Speicher mit Object Lock (Compliance-Modus) in Deutschland/EU nutzen.
- **PDF/A-3:** ZUGFeRD-Dateien sind KoSIT-geprüft (XML); die PDF/A-Konformität ist noch nicht mit
  veraPDF geprüft.

## Entscheidungen / Stand (laufend ergänzen)

- 2026-10: Entscheidung für eigene App statt Base44; Lohn bleibt Lexware; Supabase bleibt, neu in
  Frankfurt.
- 2026-10-02: Schritt 1 (Grundgerüst) erledigt. Node 22 + TypeScript (strict), Vitest, ESLint,
  Prettier, zod. Umgebungen über `APP_ENV=test|live`, Konfiguration wird beim Start validiert;
  das alte Projekt `essogronliskkfhocxst` und Nicht-Frankfurt-Regionen werden hart abgelehnt.
- 2026-10-02: Beträge immer als ganze Cent (`bigint`), Mengen mit 3 Nachkommastellen als ganze
  Zahl. Rundung kaufmännisch (half-up, weg von 0). USt wird je Steuersatz auf die Summe der
  Netto-Positionen gerechnet (EN 16931, BR-CO-17), nicht je Position.
- 2026-10-02: Prototyp Ausgangsrechnungen gebaut (Schritte 2–6 lokal, ohne Supabase-Zugang):
  - Server: Node/TypeScript mit Hono, Oberfläche serverseitig gerendert (keine Schlüssel im Browser).
    Login im Prototyp per Basic Auth; später Supabase Auth mit Rollen admin/buchhaltung/objektleitung.
  - Datenbank: SQL-Migrationen in `supabase/migrations` (laufen 1:1 auf Supabase), lokal Postgres 16 mit
    Shim für `auth.uid()`/Rollen. RLS auf allen Tabellen, Policies mit `(select fn())`. Zugriff des
    Servers per direkter Postgres-Verbindung (Zeitlimits 10 s Verbindung / 30 s Abfrage, Retry nur für
    idempotente Vorgänge).
  - Nummernkreis: Zählertabelle je Jahr mit Zeilensperre in `app.issue_invoice()` (keine SEQUENCE →
    keine Lücken bei Abbruch). Vorläufiges Format `RE-JJJJ-NNNNN`.
  - Unveränderbarkeit per Trigger: ausgestellte Rechnungen/Positionen, Archiv-Tabelle, Änderungsprotokoll,
    abgeschlossene Versände. Ausstellen nur über die DB-Funktion, mit Cent-Gegenprobe der Summen.
  - Belegarten: Rechnung 380, Abschlag 326, Schlussrechnung 380 mit verrechneten Abschlägen (brutto,
    PrepaidAmount), Storno und Korrektur 384 mit negativen Mengen und Verweis aufs Original (BT-25).
    „Gutschrift“ kommt nirgends vor.
  - E-Rechnung: Bibliothek `@e-invoice-eu/core` (TypeScript, aktiv gepflegt, erzeugt XRechnung UBL/CII und
    ZUGFeRD/Factur-X als PDF/A-3 aus einem Datenmodell). Alternative wäre Mustang (Java) – mehr
    Betriebsaufwand, kein Vorteil für uns. Geprüft wird mit dem KoSIT-Validator 1.6.3 und der
    XRechnung-Konfiguration 2025-07-10 (XRechnung 3.0.2) – Konfiguration 2026-08-31 nachziehen.
  - Ablauf: Vorabprüfung (E-Rechnung mit vorläufiger Nummer gegen KoSIT) → nur wenn gültig Nummer
    vergeben → PDF, XRechnung, ZUGFeRD, Prüfberichte erzeugen, mit SHA-256 write-once archivieren
    (inhaltsadressierte Pfade), Aufbewahrung bis 31.12. des 10. Folgejahres.
  - Versand: je Rechnung genau ein Versandeintrag; Übernahme per bedingtem Update vor dem SMTP-Versand,
    fester Message-ID. Bleibt ein Versand „unklar“, kein automatischer zweiter Versand. Außerhalb von
    live gehen alle Mails nur an `MAIL_TEST_RECIPIENT`, die echten Empfänger stehen in der Mail.
  - Datum immer Europe/Berlin (Bug gefunden: Server in UTC hätte nach 22/23 Uhr das falsche Datum
    genommen).
  - Steuersätze im Prototyp: 19 % und 7 %. 0 % / § 13b gesperrt.
  - Offen aus dem Prototyp-Umfang: Schritt 7 (Fortytools-Import) – wartet auf Exporte; Layout-Abgleich
    mit Fortytools-PDF; Umzug auf Supabase Frankfurt, sobald Zugang da ist.
- 2026-10-03: Abgleich mit Fortytools (Screenshots + Rechnung 1038193):
  - Rechnungs-PDF auf dem Original-Briefpapier (Hintergrundbild aus der Fortytools-PDF, keine
    Kundendaten), Layout und Schriftgrößen ausgemessen: grauer Titelbalken, Infoblock, Tabelle
    Pos/Text/Menge/Einheit/Einzelpreis/Gesamtpreis, Summen, Zahlungsbedingung, Folgeseite mit
    Schlusstext und GiroCode. Schrift DejaVu Sans statt Verdana (Verdana darf nicht weitergegeben werden).
  - Nummernkreis wie Fortytools: fortlaufend ohne Jahr, Startwert 1038301 (Fortytools „Nächste Nr.“).
    **Vor dem Live-Start auf die dann nächste freie Fortytools-Nummer setzen und Fortytools danach
    keine Rechnungen mehr schreiben lassen** – sonst doppelte Nummern.
  - Skonto je Kunde (Prozent + Tage), wird beim Ausstellen eingefroren. Text wie Fortytools
    („Zahlbar bis … mit 3% Skonto (Skontobetrag …, Zahlbetrag …) oder ohne Abzug bis …“), in der
    E-Rechnung zusätzlich maschinenlesbar `#SKONTO#TAGE=7#PROZENT=3.00#` (KoSIT-geprüft).
  - Positionstext wie Fortytools: Leistung, Zusatztext (z. B. Tariflohnerhöhung), „Objekt: Name (Nr.)“,
    Adresse, „TT.MM.JJJJ bis TT.MM.JJJJ“. Pauschalen ohne Einheit, Menge „1,0“.
  - Kundennummern fünfstellig ab 20000, Objektnummer = Kundennummer + zweistellig (2000201) – als
    Vorschlag beim Anlegen. Neue Kunden standardmäßig ZUGFeRD (E-Rechnungspflicht ab 2027).
  - In Fortytools gesehen, noch nicht gebaut (spätere Phasen): Rechnungsgruppen, mehrere Kontakte je
    Kunde, Offene Posten mit Teilzahlungen, Mahnungen, Angebote, Aufträge, Lieferscheine, Arbeitsscheine,
    Artikel/Inventar/Nachbestellung, Schlüssel, Geräte, Zählerstände, Raumbuch, Auditanalyse,
    Stundenvorgaben, Einsatzplanung, Zeiterfassung per App, Aufenthaltserlaubnis-Fristen, Bankabruf.
