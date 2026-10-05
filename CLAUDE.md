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

- [x] Neues Supabase-Projekt (Frankfurt) angelegt (Ahmed, 04.10.) – [ ] Zugangsdaten als Umgebungsvariablen hinterlegen
      (Anleitung `docs/LIVE.md`, Variablennamen dort; nie in den Chat)
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
- [ ] Branchen-Mindestlohn Gebäudereinigung (aktueller Wert) unter Zeiterfassung → Einstellungen eintragen
- [ ] Übersetzungen der Handy-Ansicht (ro, tr, pl, hr, bg) von Muttersprachlern im Team gegenlesen lassen
- [ ] Steuerberater: DATEV Berater-/Mandantennummer, Kontenrahmen (SKR03/04), BU-Schlüssel für § 13b-Eingangsrechnungen,
      Behandlung Schlussrechnung/Abschläge und Skonto; ersten Testexport gemeinsam prüfen
- [ ] Lohnzuschlag für die Nachkalkulation (Vorschlag 45 %) mit Steuerberater/Lohnbüro festlegen
- [ ] Mahngebühren/Verzugspauschale (40 € § 288 Abs. 5 BGB) mit Steuerberater/Anwalt festlegen
- [ ] Je Behörde klären: nimmt sie XRechnung per E-Mail an oder nur über ein Portal (ZRE/OZG-RE, Peppol)?
- [ ] Lastschrift: Gläubiger-Identifikationsnummer (Bundesbank) beantragen/mitteilen; Lastschrift-Vereinbarung mit der Bank
      (Einreichung pain.008, Limit); erste Datei als Testeinreichung mit der Bank prüfen; Mandatsformular (Muster) freigeben
- [ ] Je ein echter Kontoauszug (CAMT.053, sonst CSV) von Münchner Bank und Targobank zum Testen des Imports

## Risiken (rechtlich/steuerlich)

- **E-Rechnungspflicht B2B:** Ab 01.01.2027 dürfen Unternehmen mit mehr als 800.000 € Vorjahresumsatz an
  inländische Geschäftskunden keine reinen PDF-Rechnungen mehr senden (ab 2028 alle). Kundenformat „PDF“
  ist dann nur noch für Privatkunden zulässig → Firmenkunden bis Ende 2026 auf ZUGFeRD/XRechnung umstellen.
- **§ 13b UStG:** Reinigungsleistungen an andere Gebäudereiniger unterliegen ggf. dem Reverse-Charge-
  Verfahren (0 % + Pflichthinweis). Im Prototyp bewusst gesperrt (0 % wird abgelehnt).
- **Archiv:** Supabase Storage kennt kein Object Lock. Für 10 Jahre revisionssichere Aufbewahrung (GoBD)
  zusätzlich S3-kompatiblen Speicher mit Object Lock (Compliance-Modus) in Deutschland/EU nutzen.
- **§ 13b bei Nachunternehmern:** Reinigungsleistungen von Subunternehmern an uns (selbst Gebäudereiniger) → wir
  schulden die Umsatzsteuer. Eingangsrechnungen dafür ohne USt erfassen (Kennzeichen „§ 13b“), Buchung über
  BU-Schlüssel – mit Steuerberater abstimmen.
- **PDF/A-3:** ZUGFeRD-Dateien (Rechnung, Storno, Schlussrechnung, Lastschrift) bestehen veraPDF PDF/A-3b
  (`npm run check:pdfa`, 04.10.2026) und KoSIT (XML).

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
    XRechnung-Konfiguration 2025-07-10 (XRechnung 3.0.2) – seit 04.10.2026 Konfiguration 2026-08-31 (CEN-Regeln 1.3.16).
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
- 2026-10-04: Phase 2, Teil 1 (Ahmed: „Design wie Fortytools in unseren Farben, fast alle Menüpunkte,
  Zurück/Vor muss gehen, zwei Tabs“):
  - Oberfläche im Fortytools-Aufbau in Bordeaux: Firmenleiste mit Suche (Taste „/“), Hauptmenü Übersicht,
    Kunden, Angebote, Rechnungen, Lieferanten, Personal, Inventar, Disposition, Transfer, Auswertungen;
    „Neu anlegen: … Los“; Kunden/Objekte/Mitarbeiter mit Reitern und „Mehr“. Noch nicht gebaute Punkte
    sind sichtbar und als „bald“ markiert (Seite erklärt, was kommt und in welcher Phase). Handy: Klappmenü.
  - Zurück/Vor und Tabs: jede Ansicht hat eine eigene URL (Reiter = eigene Adresse), Post/Redirect/Get nach
    jedem Speichern, KoSIT-Prüfung als GET (kein „Formular erneut senden“), Seiten bfcache-fähig. Eingaben
    werden je Tab im sessionStorage gesichert und wiederhergestellt (auch dynamische Rechnungspositionen).
    Versionszähler (`version`) auf Kunden, Objekten, Leistungen, Rechnungen, Kontakten, Mitarbeitern:
    Speichern mit veraltetem Stand wird abgelehnt statt still zu überschreiben. Doppelklick-Schutz.
    Bug behoben: `Referrer-Policy: no-referrer` hatte die Rückkehr ins Formular nach Eingabefehlern verhindert.
  - Neu gebaut: Kontakte je Kunde (mehrere), Notizen (Kunde/Objekt/Mitarbeiter), Aufgaben mit Fälligkeit,
    Zahlungseingänge (unveränderbar, Korrektur per Gegenbuchung, Überzahlung gesperrt), Offene Posten
    (Rechnung − Storno/Korrektur − Zahlungen), Startseite wie Fortytools (Aufgaben 7 Tage, Offene Posten je
    Kunde, nicht versendete Dokumente, Geburtstage/Jubiläen, Aufenthaltserlaubnis-Warnung 60 Tage),
    Personal-Stammdaten mit getrennten vertraulichen Daten (Steuer-ID, SV-Nr., IBAN mit Prüfziffer,
    Aufenthaltserlaubnis; RLS nur Admin/Personal, nicht im Protokoll), Zuordnung Mitarbeiter ↔ Objekt,
    CSV-Export für Lexware Lohn (Format vorläufig), Netto-Umsatz je Monat, globale Suche.
  - Tests: 101 Unit-/DB-Tests, dazu Browser-Test `npm run e2e` (21 Prüfungen Zurück/Vor/Tabs).
  - Offen/als Nächstes vorgeschlagen: Mahnwesen (auf Offenen Posten), Zeiterfassung + Einsatzplanung,
    Nachkalkulation, Benutzer/Rechte mit Supabase Auth, Fortytools-Import.
  - Hinweis Skonto: Zieht ein Kunde Skonto ab, mindert sich die Umsatzsteuer (§ 17 UStG) – Buchung
    „Skonto-Abzug“ ist vorhanden, die USt-Korrektur macht der Steuerberater (DATEV-Export folgt).
- 2026-10-03: Konzern-Design, große Uploads, Angebote, Mahnwesen, Lieferanten, Inventar, Klick-Demo:
  - Design: Schrift Inter (lokal eingebunden, keine Google-Abfrage), Lucide-Icons, weißer Kopf mit Logo + Suche,
    Bordeaux-Menüleiste, Kennzahlen-Kacheln, Formularfuß. Icons werden als SVG-Text ausgegeben (hono/jsx-Eigenheit).
  - Uploads: eigener fortsetzbarer Upload (8-MiB-Stücke, 4 parallel, Wiederholung, SHA-256, write-once in `FILES_DIR`).
    300 MB im Browser-Test inkl. Abbruch/Fortsetzen geprüft. Live: Supabase Storage (TUS, ebenfalls fortsetzbar)
    direkt vom Browser – Datenstrom dann nicht über unseren Server; Grenze im Supabase-Plan prüfen.
  - Angebote: Nummernkreis `offer` ab 3843 (Fortytools-Stand bestätigen), Abgabefrist als Berliner Ortszeit,
    nur Entwürfe änderbar, Übernahme ins Objekt idempotent (feste IDs aus Angebot + Position).
    Interessenten = Kunden mit Status „interessent“ (werden bei Übernahme zu Kunden).
  - Mahnwesen: Stufen in `dunning_settings` (Zahlungserinnerung 0 €, 1. Mahnung 5 €, letzte Mahnung 10 € –
    Vorschlag, rechtlich abzustimmen), Mindestabstand 10 Tage, Gebühren ohne USt, Nummern `M-JJJJ-NNNN`,
    PDF write-once im Archiv. Basiszinssatz bewusst nicht einprogrammiert.
  - Lieferanten/Nachunternehmer mit § 48b- und Unbedenklichkeits-Fristen; Artikel/Bestand (Buchungen
    append-only), Geräte mit Prüfterminen, Schlüsselbuch (Protokoll append-only).
  - Klick-Demo: `e2e/klick-demo.mjs` sammelt alle Seiten einer Demo-Instanz in eine HTML-Datei (offline,
    Speichern deaktiviert). Demo-Daten: `src/scripts/demo-data.ts` (läuft nur auf DB-Namen mit „demo“).
- 2026-10-03: Phase 3 Teil 1 – Einsatzplanung, Zeiterfassung, Urlaub:
  - Handy-Ansicht `/m` für Mitarbeitende: Anmeldung Personalnummer + PIN (scrypt, 5 Fehlversuche → 15 Min.
    Sperre, Sitzung 14 Tage per HMAC-Cookie, `SESSION_SECRET` außerhalb dev Pflicht), 7 Sprachen (de, en, ro, tr,
    pl, hr/bs/sr, bg), große Knöpfe. QR-Code je Objekt (`/m/o/<token>`, Aushang unter Objekt → QR-Aushang).
  - Stempeln mit Serverzeit (Europe/Berlin), feste ID je Vorgang (Funkloch → nichts doppelt), max. eine laufende
    Stempelung, nur zugeordnete Objekte, keine Überschneidungen. „Soll als Ist“ nur mit Häkchen, nach Schichtende,
    max. 7 Tage zurück. Nachtrag → Freigabe Büro. Büro-Korrektur nur mit Begründung.
  - § 17 MiLoG: Zeiteinträge nie löschbar (Trigger), jede Änderung mit altem/neuem Stand, Akteur und Grund im
    Protokoll (`time_entry_log`, unveränderbar), Aufzeichnungszeitpunkt + 7-Tage-Frist-Kennzeichen,
    Prüfbericht Zoll (HTML + CSV). Hinweise nach ArbZG (Pausen § 4, 10 Std. § 3). Mindestlohn-Prüfung (Wert
    einstellbar, Branchen-Mindestlohn eintragen).
  - Einsatzplanung: wiederkehrende Einsätze je Wochentag mit Gültigkeit, Wochenplan mit Feiertagen (Bayern,
    inkl. Mariä Himmelfahrt) und Abwesenheiten (Vertretung nötig). Soll zählt erst ab dem Tag, an dem der Einsatz
    angelegt wurde. Monat Soll/Ist je Mitarbeiter.
  - Urlaub/Krank: Antrag am Handy oder Erfassung im Büro (sofort genehmigt), Kalender, Urlaubskonto
    (anteilig bei Ein-/Austritt, Arbeitstage ohne Feiertage).
  - Bekannte Grenze: QR-Code kann abfotografiert werden (Anwesenheit nicht bewiesen) – später optional
    Standort oder NFC. Nachtschicht über Mitternacht im Einsatzplan: als zwei Einsätze anlegen.
  - Tests: 133 Unit-/DB-Tests, Browser-Test `npm run e2e:zeit` (24 Prüfungen, Handy + Büro).
- 2026-10-03: Phase 3 Teil 2 – Einkauf, Zahlungslauf, DATEV, Nachkalkulation:
  - Bestellungen `BE-JJJJ-NNNN` (Nummernkreis je Jahr), PDF auf Briefpapier, Wareneingang bucht Lager einmalig
    und aktualisiert den EK. „Nachbestellen“ direkt aus dem Artikel.
  - Rechnungseingang: Dublettenschutz (Lieferant + Rechnungsnummer eindeutig), USt-Plausibilität, § 13b-Kennzeichen,
    Kostenart + Objekt + Leistungsmonat, Beleg-Upload (write-once), Freigabe „sachlich und rechnerisch richtig“.
  - Zahlungslauf: nur freigegebene Rechnungen, Skonto bis Skontodatum (Cent-genau), SEPA pain.001.001.09
    (DK-Zeichensatz, IBAN-Prüfziffer), Datei unveränderbar archiviert, jede Rechnung höchstens einmal (DB-Index),
    Rechnungen danach „bezahlt“ und gesperrt.
  - DATEV: Buchungsstapel EXTF 700 (Windows-1252, nicht festgeschrieben) mit Ausgangsrechnungen je Steuersatz,
    Zahlungseingängen, Eingangsrechnungen (BU 9/8, § 13b-Schlüssel einstellbar), Zahlungsausgängen. Debitor =
    Kundennummer, Kreditor = Lieferantennummer. Fälle zum Klären (Schlussrechnung, Skonto, § 13b) als Hinweisliste.
  - Nachkalkulation je Objekt/Monat: Erlös − Ist-Stunden × Lohn × (1 + Zuschlag) − Material − Nachunternehmer −
    Sonstiges; Soll-/Ist-Stunden, Erlös je Stunde, Ampel gegen Ziel-Deckungsbeitrag.
  - Tests: 142 Unit-/DB-Tests; Browser-Test `npm run e2e:einkauf` (14 Prüfungen).
- 2026-10-03: Phase 3 Teil 3 – Benutzer und Rollen:
  - Anmeldeformular statt Basic Auth (Benutzername + Passwort, scrypt, 5 Fehlversuche → 15 Min. gesperrt,
    Einmal-Passwort bei Anlage/Reset, muss geändert werden). Sitzung 12 h per HMAC-Cookie. Erster Admin aus
    `APP_BASIC_AUTH`. Basic Auth mit Benutzerdaten bleibt für Tests/Skripte.
  - Rollen: admin, buchhaltung, personal, objektleitung. Rechte zentral in `src/web/permissions.ts` (Seiten und
    Menü). Objektleitung: nur eigene Objekte (`sites.manager_user_id`) in Zeiterfassung, Einsatzplanung, Objekten,
    Schlüsseln, Geräten; keine Preise, Rechnungen, Kunden, Personalakten. Letzter Admin kann nicht entfernt werden.
  - Prototyp-Konten in `app.user_accounts` (Passwort-Hash), Rollen in `app.profiles`. Live: Supabase Auth.
  - Tests: 149 Unit-/DB-Tests, Browser-Tests 95 Prüfungen (`e2e`, `e2e:module`, `e2e:zeit`, `e2e:einkauf`, `e2e:rechte`).
- 2026-10-03: Phase 4 Teil 1 – Aufträge und Arbeitsscheine (Leistungsnachweise):
  - Aufträge `AU-JJJJ-NNNN` (Kunde, Objekt, Bestellnummer des Kunden, Positionen mit Preisen), aus angenommenem
    Angebot übernehmbar (nur einmalige Positionen, idempotent), Auftragsbestätigung als PDF auf Briefpapier.
  - Arbeitsscheine `AS-JJJJ-NNNN` je Objekt (mit oder ohne Auftrag): Datum, Zeit, Mitarbeitende, Arbeiten, Stunden
    (aus Beginn/Ende vorbelegt), Material, Bemerkungen, Fotos. Kunde unterschreibt vor Ort auf Handy/Tablet
    (Canvas). Danach unveränderbar (Trigger), Unterschrift (PNG) und PDF write-once im Archiv. Alternativ
    „ohne Unterschrift abschließen“ nur mit Grund. Rechtlich: einfache elektronische Signatur = Beweismittel für die
    Leistung, keine Schriftform.
  - Abrechnung: Auftrag → Rechnungsentwurf mit Auftragspositionen, abgeschlossene Arbeitsscheine hängen als PDF an
    (gehen mit der Rechnung raus). Regiearbeiten ohne Auftrag: unter Objekt → Arbeitsscheine auswählen →
    Rechnungsentwurf mit Regiestundensatz des Objekts. Jeder Schein nur einmal abrechenbar.
  - Objektleitung: Arbeitsscheine ihrer Objekte anlegen/unterschreiben lassen; Aufträge (Preise) nur Büro.
  - Behoben: Doppelklick-Schutz sperrte Formulare auch nach abgebrochenem Absenden (z. B. „Abbrechen“ im
    Bestätigungsdialog) für 8 s. Lange PDF-Titel werden verkleinert statt in den Infoblock zu laufen.
  - Tests: 152 Unit-/DB-Tests, Browser-Tests 115 Prüfungen (neu `npm run e2e:auftrag`, 20 Prüfungen).
- 2026-10-03: Phase 4 Teil 2 – Raumbuch, Stundenvorgabe, Qualitätskontrolle, Zählerstände:
  - Raumbuch je Objekt: Etage, Nr., Raum, Raumart, Bodenbelag, Fläche (m² × 100 als ganze Zahl), Intervall als
    Reinigungen pro Jahr (5×/Woche = 260), Leistungswert je Raumart (m²/h, Richtwerte unter Disposition →
    Leistungswerte, je Raum abweichend möglich). CSV-Export.
  - Stundenvorgabe = Fläche ÷ Leistungswert × Reinigungen/Jahr (Woche = ÷ 52, Monat = ÷ 12), Vergleich mit dem heute
    gültigen Einsatzplan (Abweichung > 10 % rot), fürs Büro Erlös je Vorgabe-/Plan-Stunde aus der Monatspauschale.
    **Leistungswerte sind Richtwerte – Ahmed bitte mit eigenen Erfahrungswerten abgleichen.**
  - Qualitätskontrolle `QK-JJJJ-NNNN`: Bereiche aus dem Raumbuch (sonst Standardbereiche), je Bereich i. O. / Mangel /
    nicht geprüft mit Mangelkategorien und Bemerkung, Fotos. Ergebnis = Anteil i. O. der geprüften Bereiche
    (grün ≥ 90 %, gelb ≥ 75 %). Abschluss optional mit Unterschrift des Kunden; danach unveränderbar (Trigger),
    Prüfbericht-PDF write-once; je Mangel automatisch eine Nachbesserungs-Aufgabe (Frist 3 Tage, Objektleitung).
  - Zählerstände (Strom, Wasser, Gas, Wärme): Ablesungen nur anhängen, nie kleiner als die vorige bzw. größer als eine
    spätere (DB-Trigger), Zählertausch als Startwert, Verbrauch und Verbrauch/Tag je Zeitraum, Liste „Ablesung fällig“
    (älter als 35 Tage).
  - Objektleitung: alles davon für die eigenen Objekte, Stundenvorgabe ohne Erlöse, Leistungswerte nur Büro.
  - Tests: 156 Unit-/DB-Tests, Browser-Tests 145 Prüfungen (neu `npm run e2e:objekt`, 25 Prüfungen; Rechte-Test +5).
- 2026-10-03: Rechnungsgruppen (wie Fortytools):
  - Kunde → Rechnungsgruppen: mehrere Objekte desselben Kunden zusammenfassen, optional eigene Leitweg-ID und
    Bestellnummer. Der Monatslauf erzeugt je aktiver Gruppe EINE Sammelrechnung (Positionen je Objekt mit
    „Objekt: Name (Nr.)“ und Adresse, kein einzelnes Objekt im Kopf). Inaktive Gruppe = Objekte wieder einzeln.
  - Doppelabrechnung ausgeschlossen: neue Tabelle `monthly_run_sites` (Objekt + Monat eindeutig, Bestand
    übernommen) – auch wenn ein Objekt mitten im Monat die Gruppe wechselt. Gelöschter Entwurf gibt das Objekt frei.
  - Storno/Korrektur übernehmen die Gruppe. Sammelrechnung besteht KoSIT.
  - Offen: Rechnungsgruppen aus dem Fortytools-Export übernehmen (Ahmed zeigt eine Gruppe von innen).
  - Tests: 159 Unit-/DB-Tests, Browser-Tests 147 Prüfungen.
- 2026-10-03: Mitarbeiter-App und Dokumente digital unterschreiben:
  - `/m` ist installierbare Web-App (Manifest, Service Worker nur für Offline-Hinweis und Schrift/Logo – keine
    persönlichen Daten im Cache, Icons `assets/web/app-icon-*.png` via `scripts/app-icons.mjs`). Android:
    „App installieren“, iPhone: Safari → Teilen → „Zum Home-Bildschirm“.
  - Knopf „QR-Code am Objekt scannen“: nativ in der App, im Browser per BarcodeDetector (sonst Kamera-App).
  - `mobile-app/`: Capacitor-Hülle für App Store / Google Play (lädt `/m` vom Live-Server, QR-Scanner- und
    Push-Plugin vorbereitet). Native Projekte erst mit Mac/Xcode bzw. Android Studio anlegen (README dort).
    Empfehlung: nicht öffentlich listen (Apple Unlisted/Custom App, Google Private App) – Risiko Apple 4.2.
  - Personal → Dokumente digital unterschreiben: PDF hochladen (write-once, SHA-256), Empfänger wählen; am Handy
    „gelesen und verstanden“ + Unterschrift mit dem Finger; Nachweis-PDF = Original + Nachweisblatt (Zeitpunkt,
    Name/Personalnr., IP, Gerät, Prüfsumme), unveränderbar, nie löschbar. Zurückziehen nur offene Anforderungen.
  - **Gesperrt (Schriftform):** Kündigung/Aufhebungsvertrag (§ 623 BGB), Befristung (§ 14 Abs. 4 TzBfG), Zeugnis
    (§ 630 BGB) – keine Kategorie dafür, Titel/Dateiname mit solchen Begriffen wird abgelehnt.
  - Offen: Push-Benachrichtigungen serverseitig (Firebase/APNs), Apple-/Google-Konten + D-U-N-S (Ahmed),
    Live-Domain für `capacitor.config.json`, Übersetzungen der neuen Handy-Texte gegenlesen lassen.
  - Tests: 161 Unit-/DB-Tests, Browser-Tests 162 Prüfungen (neu `npm run e2e:app`, 15 Prüfungen).
- 2026-10-03: Demo-Daten Phase 4 (Raumbuch Grundschule, 2 Qualitätskontrollen, 4 Zähler mit Ablesungen, Auftrag mit
  unterschriebenem Arbeitsschein, Regie-Schein, Rechnungsgruppe, Unterweisung zur Unterschrift – 1001 offen,
  1002 unterschrieben). Klick-Demo neu veröffentlicht (369 Seiten): https://claude.ai/artifact/HpySmrqaJ9wpvpWiabFj4S
- 2026-10-03: Abgleich mit 37 Fortytools-Screenshots (Ahmed, iPad). Lücken gegenüber unserer App (Reihenfolge = Vorschlag):
  1. Leistungen wie Fortytools-„Aufträge“ am Objekt: Leistungsart (Stammliste), Abrechnungszyklus (monatlich/
     quartalsweise/jährlich), Stundenvorgabe je Leistung, Ausführungshinweise (→ Arbeitsschein), Kostenstelle,
     Lohnkostenanteil, „immer unfertig“, Rechnungsgruppe je Leistung abweichend; Rechnungsgruppe mit Kopf-/Fußtext;
     „Leistungen abrechnen“ je Objekt mit Abrechnungsmonat + Rechnungsdatum; Reiter „Dauerrechnungen“.
  2. Mahnwesen-Stapelverarbeitung (überfällige Rechnungen je Kunde, Tage überfällig, bisherige Mahnungen, Auswahl).
  3. Personal: Tags (Minijob/Teilzeit/Vollzeit/Objektleitung), Wochenstunden, Urlaubsanspruch, Lohnstufe/
     Lohnkonditionen, Krankenkasse, Staatsangehörigkeit, Familienstand, Geburtsort/-land, Warnhinweis, Dokumente je
     Mitarbeiter mit Kategorien + „Neu aus Vorlage“, Einsatzkalender je Mitarbeiter, Soll/Plan/Ist je Monat,
     Serienbrief/E-Mail-Verteiler, Rest-Urlaub vortragen/verfällt 31.03.
  4. Planung: Monatstafel je Mitarbeiter, „Einsätze für abwesende Mitarbeiter“, Einsatzgruppen, Umplanen.
  5. Auswertungen: Rechnungs-Statistik, Umsatz-Vorschau, Stundenkontrolle Soll/Ist, Ø Stundensätze, Urlaubskonten,
     Krankheitstage, Dienste-Liste/-Kalender.
  6. Angebote: Kopieren, Folgeangebot, Auftragsbestätigung, Rechnung aus Angebot, Alternativpositionen,
     Statistik offen/angenommen/abgelehnt (12 Monate), „zuletzt bearbeitete Kunden“.
  7. Transfer: Kontoumsätze (Bankabruf), Lastschriften, Dokumenteneingang/-versand.
     Hinweis: Fortytools nennt negative Rechnungen „Gutschrift“ (Gu 1038085) – bei uns Storno/Rechnungskorrektur.
     Screenshots enthalten echte Personaldaten (Steuer-ID, SV-Nr.) – nicht ins Repo übernommen.
- 2026-10-03: Angebot wie Fortytools (Ahmed: „sieht komisch aus“): Detailseite als Briefansicht (Adresse, grauer
  Balken „Angebot Nr.“ mit Datum/Kundennummer/Ansprechpartner, Anrede, Einleitung, Positionen mit Einheit, Summen
  mit hervorgehobenem Gesamtbetrag, Schlusstext), Aktionen darunter untereinander, Übernahme ins Objekt als eigener
  Kasten. Standardtexte (Einleitung/Schluss) wie Fortytools; Ansprechpartner = Anlegender. PDF: Ansprechpartner,
  „pauschal“ statt leerer Einheit, Zyklus „monatlich/einmalig“ unter der Position. Neue Positionen standardmäßig
  „pauschal“.
- 2026-10-03: Lücke 1 erledigt – Leistungen am Objekt wie Fortytools-„Aufträge“:
  - Je Leistung: Anfang/Ende, Titel, Leistungsart (Stammliste unter Rechnungen → Leistungsarten, mit Lohnkostenanteil-
    Vorgabe), Zusatztext, Kostenstelle, Art, Rechnungsgruppe („wie Objekt“ / eigene Rechnung / Gruppe), Abrechnungs-
    zyklus (monatlich, 2-monatlich, quartalsweise, halbjährlich, jährlich – fällig ab Beginn alle n Monate, Zeitraum über
    n Monate), Einheit/Menge/Betrag je Zeitraum, USt, Lohnkostenanteil, „immer unfertig“, Stundenvorgabe je Monat,
    Ausführungshinweise (erscheinen im Arbeitsschein-Editor und -PDF). Leistungen sind jetzt bearbeitbar (Versionszähler).
  - Abrechnungslauf je Leistung statt je Objekt: Ziel = eigene Rechnung → Gruppe der Leistung → Gruppe des Objekts →
    Rechnung je Objekt. Doppelabrechnung je Leistung + Monat ausgeschlossen (`monthly_run_services`, Bestand übernommen).
    Rechnungsgruppen mit Kopf-/Fußtext.
  - „Regelmäßige Leistung(en) abrechnen“ am Objekt (Abrechnungsmonat + Rechnungsdatum, Vorschau offen/abgerechnet);
    Monatslauf mit Rechnungsdatum. Rechnungsdatum in der Zukunft → Ausstellen erst ab dem Tag (DB-Regel bleibt).
  - „Immer unfertig“: Entwurf mit Hinweis, Ausstellen gesperrt bis „Geprüft“.
  - Tests: 166 Unit-/DB-Tests, Browser-Tests 179 Prüfungen (neu `npm run e2e:leistungen`, 12 Prüfungen).
- 2026-10-04: Lücke 2 erledigt – Mahnwesen-Stapelverarbeitung wie Fortytools (Rechnungen → Mahnwesen → Stapelverarbeitung):
  alle überfälligen Rechnungen je Kunde (Rechnungsdatum, fällig, Tage überfällig rot, Anzahl bisheriger Mahnungen,
  nächste Stufe, offen brutto), Auswahl je Kunde/Rechnung/alle; nicht mahnbare grau mit Grund (Stufe noch nicht
  erreicht, Mindestabstand 10 Tage, Mahnsperre, letzte Stufe). Ein Lauf erstellt je Kunde eine Mahnung (feste IDs →
  nichts doppelt), optional gleich per E-Mail. Fehler bei einem Kunden brechen den Lauf nicht ab. Regeln werden
  serverseitig geprüft (Bug gefunden: zu frische Rechnungen ließen sich sonst mahnen).
  Tests: 167 Unit-/DB-Tests, neu `npm run e2e:mahnung` (6 Prüfungen).
- 2026-10-04: Lücke 3 erledigt – Personal wie Fortytools:
  - Stammdaten: Anrede, Tags (Filter-Chips in der Liste), Warnhinweis (rot in der Übersicht), Information, Mobil,
    weitere E-Mail, Urlaubsanspruch, Lohnstufe (Personal → Lohnstufen; individueller Stundenlohn geht vor, wirksamer
    Lohn in Nachkalkulation und Mindestlohn-Prüfung), vertraulich: Geburtsort/-land, Familienstand,
    Aufenthaltserlaubnis-Info.
  - Reiter „Dokumente“ je Mitarbeiter mit Kategorien (Arbeitsvertrag, Personalunterlagen, Unterweisung, Bescheinigung,
    Sonstiges) + „Neu aus Vorlage“ (PDF auf Briefpapier, write-once abgelegt); Personal → Dokumentvorlagen mit
    Platzhaltern; Serienbrief (ein PDF für die gefilterte Liste) und E-Mail-Verteiler (BCC) in der Liste.
  - Reiter „Einsatzkalender“ (Monat: Einsätze, erledigt, Ist ohne Einsatz, Feiertage, Abwesenheiten) und Box
    „Dispo & Zeiterfassung“ Soll/Plan/Ist für Vor-, aktuellen und Folgemonat (Soll = Wochenstunden ÷ 5 × Arbeitstage).
  - Resturlaub: Übertrag ins Folgejahr (je Mitarbeiter abschaltbar), wird im 1. Quartal zuerst verbraucht, Rest gilt
    ab 01.04. als verfallen. **Rechtlich: Verfall nur, wenn der Arbeitgeber rechtzeitig zum Urlaub aufgefordert und auf
    den Verfall hingewiesen hat (BAG 19.02.2019, 9 AZR 541/15)** – Hinweis steht im Urlaubskonto.
  - **Sicherheitslücke behoben:** Datei-Download `/dateien/…` und Upload-Verknüpfung prüften keine Rechte (mit
    Datei-ID hätte z. B. die Objektleitung Personaldokumente laden können). Jetzt: Zugriff nur, wenn der Benutzer
    mindestens eine Verknüpfung sehen darf (Rolle + eigene Objekte); Test im Rechte-Browser-Test.
  - Tests: 171 Unit-/DB-Tests; Browser-Tests neu `e2e:personal` (11), `e2e:rechte` 24.
- 2026-10-04: Lücke 4 erledigt – Planung wie Fortytools:
  - Monatstafel (`/einsatzplanung/monat`): Mitarbeitende × Tage, Filter Einsatzgruppe (`employees.planning_group`),
    Planungsnotizen sichtbar, Farben geplant/erledigt/abwesend/umgeplant/Ausfall.
  - Tagesausnahmen (`shift_exceptions`, je Einsatz + Tag eindeutig): Ausfall, Vertretung, umgeplant (andere Zeit und/oder
    anderer Mitarbeiter). Wiederkehrende Planung bleibt unverändert. Prüfungen: Wochentag/Gültigkeit, Vertretung aktiv
    und nicht abwesend, keine Überschneidung, nicht mehr änderbar, sobald eine Zeit erfasst ist; Versionszähler, Protokoll.
  - „Einsätze für abwesende Mitarbeiter“ (`/einsatzplanung/vertretungen`), auch Hinweis im Wochen- und Monatsplan;
    Vorschläge: Mitarbeitende des Objekts zuerst, belegte nicht wählbar. Kein Ausfall aus Versehen (Pflichtauswahl).
  - Vertretung sieht den Einsatz in der Handy-App, kann „Soll als Ist“ bestätigen und am fremden Objekt stempeln
    (nur Vertretungstag −7/+1 Tag); Soll/Plan/Ist und Kalender rechnen mit den Ausnahmen.
  - Tests: 178 Unit-/DB-Tests, Browser-Tests 196 Prüfungen (neu `npm run e2e:planung`, 9 Prüfungen).
- 2026-10-04: Lücke 5 erledigt – Auswertungen (`/auswertungen`, Reiter je Bericht, nach Rolle gefiltert):
  - Rechnungs-Statistik je Jahr (Rechnungen/Storno je Monat, Kunden nach Umsatz, Ø Zahlungsdauer, offen/überfällig),
    Umsatz-Vorschau 12 Monate aus den regelmäßigen Leistungen (gleiche Rechnung wie der Abrechnungslauf, mit Zyklus und
    Gültigkeit), Ø Stundensätze je Objekt (Erlös je Plan-/Ist-Stunde, Ø Stundenlohn), Stundenkontrolle Soll/Plan/Ist
    (CSV), Urlaubskonten, Krankheitstage je Monat (Hinweis BEM § 167 SGB IX bei > 6 Wochen), Dienste-Liste (CSV, Druck).
  - Rechte: Stunden/Urlaub/Krankheit nur Admin/Personal; Dienste-Liste alle (Objektleitung nur eigene Objekte); Umsätze
    nur Büro. CSV-Exporte entschärfen Formeln (Schutz gegen CSV-Injektion in Excel).
  - Behoben: Nachkalkulation zählte Erlöse aus Sammelrechnungen (Rechnungsgruppen, kein Objekt im Kopf) nicht – jetzt je
    Rechnungsposition über die Leistung dem Objekt zugeordnet.
  - Offen: Schlussrechnungen zählen im Umsatz voll und die Abschläge ebenfalls (doppelt) – mit Steuerberater klären,
    wie es ausgewiesen werden soll (wie DATEV-Hinweisliste).
  - Tests: 183 Unit-/DB-Tests, Browser-Tests 214 Prüfungen (neu `npm run e2e:auswertung`, 16 Prüfungen; Rechte +2).
- 2026-10-04: Lücke 6 erledigt – Angebote wie Fortytools:
  - Alternativpositionen (einmalig oder monatlich): im Editor, in der Briefansicht und im PDF als „Alternativ“ mit Betrag
    in Klammern, nicht in Netto/USt/Gesamt und nicht im Monatsanteil; werden bei Übernahme ins Objekt, Auftrag und
    Rechnung nicht übernommen. Mindestens eine normale Position Pflicht.
  - Folgeangebot (`offers.predecessor_id`, je Angebot höchstens eins – DB-Index, doppelter Klick liefert dasselbe): Kopie
    als Entwurf mit Verweis; sobald das Folgeangebot abgegeben wird, gilt das vorige als zurückgezogen (Protokoll).
  - Statistik der letzten 12 Monate (offen/angenommen/abgelehnt mit Summen, Zuschlagsquote ohne Zurückgezogene),
    Reiter „Abgelehnt“. „Zuletzt bearbeitet“ im neuen Angebot (Kunden aus dem eigenen Protokoll der letzten 90 Tage).
  - Rechnung aus Angebot und Auftragsbestätigung gab es schon (Auftrag aus Angebot → AB-PDF).
  - Tests: 187 Unit-/DB-Tests, Browser-Tests 226 Prüfungen (neu `npm run e2e:angebot`, 12 Prüfungen).
- 2026-10-04: Lücke 7 erledigt – Transfer:
  - Kontoumsätze: Auszug als CAMT.053 (XML) oder CSV (Spalten über die Kopfzeile, Windows-1252 erkannt) einlesen; nur
    eigene Konten, Datei write-once archiviert; Umsatz-ID aus Inhalt → überlappende Auszüge legen nichts doppelt an;
    Umsatzdaten per Trigger unveränderbar, „zugeordnet“ endgültig (Korrektur über Gegenbuchung der Zahlung).
  - Abgleich mit Vorschlag, gebucht wird erst nach Bestätigung: Rechnungsnummer im Verwendungszweck + Betrag (voll,
    mehrere Rechnungen, Teilzahlung), Skonto (nur wenn vereinbart, Frist + 5 Tage Bankweg, Betrag cent-genau → eigene
    Buchung „Skonto-Abzug“), eindeutiger Betrag ohne Nummer („wahrscheinlich“), Sammelgutschrift Lastschrift,
    Zahlungslauf (Ausgang), Rücklastschrift (Gegenbuchung, Rechnung wieder offen, Aufgabe „klären“, Bankgebühr vermerkt).
    Manuell: Betrag/Skonto je Rechnung, Summe muss stimmen. Feste Zahlungs-IDs → doppelt absenden bucht nichts doppelt.
  - SEPA-Lastschrift: Mandate je Kunde (ein aktives, Referenz/IBAN nach erstem Einzug gesperrt, IBAN-Prüfziffer),
    Gläubiger-ID mit Prüfziffer, Einzug `LS-JJJJ-NNN` als pain.008.001.08 (CORE/B2B, FRST/RCUR), frühester Einzugstag
    = nächster TARGET2-Bankarbeitstag, Datei archiviert, jede Rechnung nur einmal im Einzug (außer nach Rücklastschrift).
    Vorabankündigung (Pre-Notification): siehe Eintrag „Lastschrift auf der Rechnung“ unten.
  - Dokumentenversand: Protokoll aller versendeten Rechnungen und Mahnungen (Empfänger laut Kunde und tatsächlich –
    im Test nur Testadresse), Filter. Dokumenteneingang: Ablage (Upload, write-once) und Zuordnung zu Kunde, Lieferant,
    Objekt, Eingangsrechnung oder Personalakte (nur Personal/Admin); nur die Verknüpfung wechselt.
  - Neue Abhängigkeit `xmlbuilder2` (war schon indirekt über die E-Rechnungs-Bibliothek vorhanden); CAMT mit DTD wird
    abgelehnt (Schutz gegen XXE).
  - Tests: 198 Unit-/DB-Tests, Browser-Tests 239 Prüfungen (neu `npm run e2e:transfer`, 12 Prüfungen).
- 2026-10-04: Lastschrift auf der Rechnung (Vorabankündigung): Hat der Kunde beim Ausstellen ein aktives Mandat und ist
  die Gläubiger-ID hinterlegt, wird das Mandat im Kunden-Schnappschuss eingefroren. Zahlungsbedingung dann: „Der
  Rechnungsbetrag von … wird am <Fälligkeit> per SEPA-Lastschrift von Ihrem Konto DE02 **** … 20 51 eingezogen
  (Mandatsreferenz …, Gläubiger-ID …)“ – ohne Skonto und ohne GiroCode. E-Rechnung: Zahlungsart 59 mit Mandatsreferenz
  (BT-89), Gläubiger-ID (BT-90, schemeID SEPA) und belastetem Konto (BT-91), KoSIT-gültig (UBL + CII). Einzug vor dem
  angekündigten Fälligkeitstag wird abgelehnt. Frist der Vorabankündigung = Zahlungsziel (≥ 14 Tage bzw. laut Mandat).
- 2026-10-04: Sonderdienste (bisher „bald“: Glasreinigung/Tiefgarage) unter Disposition → Sonderdienste: je Objekt
  Art (Glas, Tiefgarage, Grundreinigung, Teppich, Sonstiges), Umfang, Intervall in Monaten, nächste Fälligkeit, Festpreis
  je Durchführung (nur Büro sichtbar), Aushang-Vorlauf (Tiefgarage 14 Tage). Fälligkeitsliste (60 Tage, überfällig rot),
  je Sonderdienst höchstens ein offener Termin (DB-Index) mit Team; Aushang-PDF („Fahrzeuge entfernen“); verschoben
  nach Aushang → wieder „geplant“. Erledigt → Arbeitsschein-Entwurf (feste ID) und nächste Fälligkeit = Termin +
  Intervall (nur vorwärts); Rechnungsentwurf einmal je Termin, unterschriebener Arbeitsschein hängt an. Objektleitung:
  eigene Objekte, ohne Preise/Rechnung. **Ahmed: Wie waren Glasreinigung/Tiefgarage in der alten App genau aufgebaut
  (Felder, Intervalle, Preise)? Dann gleiche ich an und übernehme die Daten.**
  Tests: neu `special-services.db.test.ts`, Browser-Test `npm run e2e:sonderdienst` (8 Prüfungen).
- 2026-10-04: Schritt 7 vorbereitet – Import aus Fortytools (Transfer → Import aus Fortytools): CSV (Semikolon/Komma/Tab,
  UTF-8 oder Windows-1252) für Kunden → Objekte → Leistungen. Spalten werden über die Kopfzeile erkannt (deutsche Namen,
  z. B. „Kd-Nr.“, „Firma“, „Objekt-Nr“, „Betrag“, „MwSt“, „Zyklus“), unbekannte Spalten angezeigt. Vorschau als GET-Seite
  (Datei write-once im Archiv), je Zeile neu / vorhanden / Fehler mit Grund; übernommen werden nur fehlerfreie Zeilen,
  vorhandene nur mit „überschreiben“. Prüfung über dieselben Regeln wie die Formulare (PLZ 5-stellig – Excel-PLZ ohne
  führende Null wird ergänzt, Leitweg-ID, E-Mail, USt nur 7/19 %). Ohne Rechnungsformat: Leitweg-ID → XRechnung, sonst
  ZUGFeRD. Feste IDs aus Kunden-/Objektnummer, Protokoll `data_imports`. **Sobald die echten Exporte da sind:
  Spaltennamen abgleichen, Probeimport in der Testumgebung, dann Abgleich der Summen (Monatsumsatz je Kunde).**
  Tests: `fortytools-import.db.test.ts`, Browser-Test `npm run e2e:import` (8 Prüfungen).
- 2026-10-04: Supabase-Umzug vorbereitet (`docs/LIVE.md`): Migrationen und alle DB-Tests laufen gegen das offizielle
  Supabase-Postgres-Image (`npm run test:supabase`, 213 Tests; `postgres` ohne Superuser, Supabase-`auth.uid()`). Dabei
  gefunden: RLS-Tests setzten nur `request.jwt.claims` – ältere Supabase-Versionen lesen `request.jwt.claim.sub`; Tests
  setzen jetzt beides. Konten werden in Supabase über die Auth-Admin-API angelegt (feste ID, idempotent; Service-Key nur
  im Server), lokal weiter direkt in `auth.users`. `npm run db:migrate:supabase -- --projekt=<ref>` verlangt den
  Projekt-Ref als Bestätigung. Konfiguration prüft zusätzlich: DATABASE_URL/SUPABASE_URL gehören zum Projekt,
  Pooler-Adresse in eu-central-1. **Zugangsdaten fehlen noch in der Umgebung** – danach Migration einspielen.
- 2026-10-04: KoSIT-Prüfkonfiguration auf 2026-08-31 (XRechnung 3.0.2, CEN-Schematron 1.3.16) umgestellt – alle
  Beispielrechnungen inkl. Skonto, Lastschrift, Storno, Abschlag, Schlussrechnung gültig (UBL + CII). PDF/A-3b mit
  veraPDF geprüft und bestanden (`npm run check:pdfa`, Docker-Image verapdf/cli).
- 2026-10-04: Demo-Daten Phase 6 (Vertretung bei Krankheit, Einsatzgruppen, 3 Sonderdienste mit Termin/erledigt, Angebot mit
  Alternative + Folgeangebot, abgelehntes Angebot, Mandat + Gläubiger-ID, Kontoauszug mit Zahlung/Miete/unbekannt,
  Fortytools-Beispielimport). Klick-Demo Version 5 (488 Seiten, 26 PDFs): https://claude.ai/artifact/HpySmrqaJ9wpvpWiabFj4S
- 2026-10-05: Demo-Daten Phase 7 (Kleidungsbestand, unterschriebene Kleider-Übergabe, offene Schlüssel-Übergabe, Nachunternehmer
  mit Nachweisen, Portal-Uploads, erteiltem Auftrag + Preisnachtrag). Klick-Demo Version 6 (522 Seiten, neues Design).
  Stand gesamt: 213 Unit-/DB-Tests (auch gegen das Supabase-Image), 17 Browser-Suiten mit 255 Prüfungen, KoSIT 2026-08-31,
  PDF/A-3b bestanden.
- 2026-10-05: Übergaben mit Unterschrift (ersetzt Arbeitskleidung/Schlüssel/Übergaben der alten App, „anders, besser“):
  - Inventar → Übergaben: Arbeitskleidung, Schlüssel, Geräte, Dokument/Unterweisung (PDF-Upload oder Text), Sonstiges
    (Diensthandy, Tankkarte …) an Mitarbeitende oder Nachunternehmer. Nummern `UE-JJJJ-NNNN`. Objektleitung legt für ihre
    Objekte und deren Mitarbeitende an und lässt am eigenen Handy/Tablet unterschreiben (Canvas).
  - Gebucht wird erst beim Abschluss (Unterschrift oder „ohne Unterschrift“ mit Grund) in einer Transaktion: Kleider-
    bestand (`clothing_moves`, append-only) bzw. Schlüsselbuch (Ausgabe/Rückgabe). Doppelt senden bucht nichts doppelt;
    Schlüssel bereits ausgegeben → Abschluss abgelehnt, nichts gebucht. Danach unveränderbar (Trigger), Protokoll-PDF
    write-once (bei Dokumenten: Original + Protokoll in einer Datei).
  - Rückgabe = eigene Übergabe mit Verweis auf die Ausgabe („Rückgabe erfassen“). Mitarbeiter → Reiter „Übergaben“ zeigt,
    was die Person derzeit hat (Schlüssel, Kleidung, Geräte) – Checkliste beim Austritt.
  - Arbeitskleidung → Bestand je Artikel/Größe, Zugang/Korrektur/Inventur (Büro/Personal), Mindestbestand. Startartikel
    und Preise aus der alten App.
  - **Rechtlich:** PSA (Sicherheitsschuhe, Warnweste) zahlt der Arbeitgeber (§ 3 Abs. 3 ArbSchG) → nie Lohnabzug (gesperrt).
    Lohnabzug bei Nichtrückgabe nur mit ausdrücklicher Vereinbarung im Protokoll, höchstens Zeitwert, nur oberhalb der
    Pfändungsfreigrenze, Mindestlohn bleibt unberührt – Text mit Anwalt/Steuerberater prüfen lassen.
  - Tests: 217 Unit-/DB-Tests, neu `npm run e2e:uebergabe` (17 Prüfungen).
- 2026-10-05: Nachunternehmer (aus der alten App „Subunternehmer“, verbessert):
  - Lieferanten → Nachunternehmer: Ampel je Firma (Nachweise fehlen / läuft in 60 Tagen ab / vollständig / inaktiv) mit
    den 17 Nachweisarten der alten App (Gültigkeit 6/12/36 Monate, HR-Auszug nur bei Registerrechtsformen). Jede Datei
    eine Version (Archiv write-once, nie löschbar), „gültig bis“ muss vom Nachweis eingetragen werden (kein Vorschlag).
    Nachforderungstext (E-Mail/Kopieren), Nachweisübersicht als PDF (z. B. für Zoll/Auftraggeber).
  - Upload-Portal `/np/<link>` mit 6-stelliger PIN (scrypt, 5 Fehlversuche → 15 Min. gesperrt, Sitzung 2 h nur für diesen
    Link). Uploads zählen erst nach Prüfung im Büro (Reiter „Zu prüfen“: gültig mit Datum / ablehnen mit Grund).
  - Aufträge an Nachunternehmer (Nummer `BE-JJJJ-NNNN` wie alte App), Auftrags-PDF, Scan des unterschriebenen Auftrags,
    Preisnachträge ab Monat (append-only), „Erteilen“ gesperrt, solange Pflicht-Nachweise fehlen. Soll/Ist je Monat gegen
    Eingangsrechnungen (über Auftrag bzw. Nachunternehmer + Objekt + Leistungsmonat).
  - Kündigung mit Gründen (Aufträge enden zum Datum, Entwürfe storniert), Kündigungsschreiben als PDF, aufhebbar.
  - Zahlungslauf: Rechnungen von Nachunternehmern mit fehlenden Nachweisen sind nicht vorausgewählt und markiert.
  - **Rechtlich:** Haftung als Auftraggeber für Mindestlohn (§ 13 MiLoG, § 14 AEntG) und SV-Beiträge (§ 28e Abs. 3a
    SGB IV) – Zurückhalten der Zahlung schützt nicht vor der Haftung, die Nachweise sind die eigentliche Absicherung.
  - Tests: 221 Unit-/DB-Tests, neu `npm run e2e:nachunternehmer` (19 Prüfungen).
- 2026-10-05: Design moderner (Ahmed: „altmodisch, eher wie die alte App, moderner und logischer“): warmes Off-White,
  dezente Linien, weichere Schatten, größere Radien, schwarze Überschriften; Bordeaux nur noch als Akzent (Menüleiste hell
  mit Bordeaux-Markierung statt vollflächig Bordeaux). Status als Punkt-Pillen, Tabellenköpfe dezent. Neue Bausteine:
  Kopfkarte mit großem Status + Fortschrittsbalken, Listen statt Tabellen, Filter-Chips, Upload im kleinen Aufklapp-Fenster,
  „Zusammenarbeit beenden“ eingeklappt. Nachunternehmer-Seiten als erstes umgebaut; weitere Seiten folgen schrittweise.
- 2026-10-05: Kundenliste wie Fortytools, im neuen Design (Ahmed: Objekte sehen, Serienbrief, Seiten, Anzahl):
  Status-Chips mit Anzahl (Kunde / Interessent / Ehemaliger Kunde = inaktiv), Suche, A–Z (+ „#“), „1–25 von N“ oben,
  Seitenzahlen unten (25 je Seite), je Kunde Objekte-Aufklappliste (+ Objekt anlegen), Karte (Google Maps), offener Betrag,
  CSV-Download der gefilterten Liste. Serienbrief an alle gefilterten Kunden: ein PDF zum Drucken, jeder Brief zusätzlich in
  der Kundenakte (Dateien, Kategorie Schriftverkehr; feste IDs → nichts doppelt). Briefvorlagen jetzt mit Zielgruppe
  (Mitarbeiter/Kunde), Kunden → Briefvorlagen; Startvorlagen: neue Adresse ab 01.11.2026, Preisanpassung Tariflohn,
  Umstellung E-Rechnung.
- 2026-10-05: Objektliste wie Fortytools (Ahmed: Kunde mit Nummer statt Pauschale, Filter, Objektleitung zeigen):
  Nummer · Objekt + Adresse · Kunde + Kundennummer · Objektleitung + Anzahl Mitarbeitende. Filter Aktiv/Inaktiv (mit Anzahl),
  Objektleitung (auch „ohne“), A–Z und 0–9, Suche, Sortierung (Nummer/Objektname/Kunde/Ort), 25 je Seite, CSV-Export,
  „QR-Codes drucken“ (alle aktiven Objekte der Auswahl, je Seite ein Aushang). Objektleitung jetzt auch im Objekt-Formular
  wählbar. Kundenliste ohne Behörde/Format-Schilder; „Pauschale/Monat“ auch in der Objekttabelle beim Kunden entfernt.
- 2026-10-05: Rechnungsangaben je Objekt (Ahmed: Rechnungsdetails nicht nur beim Kunden, übernehmen oder eigene):
  Objekt → Reiter „Rechnungsangaben“: „wie Kunde“ oder „abweichend für dieses Objekt“ (Felder werden mit den Kundendaten
  vorbelegt, „Angaben vom Kunden übernehmen“). Abweichend möglich: Rechnungsadresse (Name, Zusatz, Straße, PLZ, Ort),
  Ansprechpartner, Rechnungs-E-Mails, Format, Leitweg-ID, Lieferantennummer, Zahlungsziel, eigenes Skonto (auch „kein
  Skonto“). Leere Einzelfelder gelten wie beim Kunden. Zentral `resolveBilling()`/`effectiveBilling()`: Entwurf (Format,
  Leitweg-ID), Monatslauf, Käufer-Schnappschuss (Adresse in PDF/E-Rechnung), Ausstellen (`app.issue_invoice`: Zahlungsziel,
  Skonto), Versand (Empfänger). Sammelrechnungen (Rechnungsgruppen) nutzen weiter die Kundenangaben. Prüfung: XRechnung nur
  mit Leitweg-ID, Adresse vollständig, Skontofrist < Zahlungsziel. Mahnungen gehen weiter an die Kundenadresse.
  Behoben: `hidden` wurde bei Rastern/Flex-Elementen von CSS überschrieben (jetzt `[hidden]{display:none!important}`).
  Tests: 226 Unit-/DB-Tests, neu `npm run e2e:rechnungsangaben` (10 Prüfungen).
- 2026-10-06: SEPA-Zahlungslauf entfernt (Ahmed) → Lieferanten → Zahlungsliste: freigegebene Eingangsrechnungen nach Fälligkeit/
  Skontofrist, Zahlbetrag mit Skonto zum gewählten Zahlungstag, IBAN + Verwendungszweck zum Kopieren, Summe der Auswahl,
  CSV/Druck. „Als bezahlt festhalten“ (Datum, Zahlart, Skonto gezogen) → DATEV-Zahlungsausgang; von Hand erfasste Zahlung
  zurücknehmbar (Lauf-Zahlungen nicht). Alte Zahlungsläufe bleiben unter /zahlungslauf/<id> abrufbar, /zahlungslauf leitet um.
  Nachunternehmer mit fehlenden Nachweisen sind nicht vorausgewählt.
- 2026-10-06: Einstellungen zentral (Ahmed: Leistungsarten, Mahnwesen usw. separat in den Einstellungen): Zahnrad oben rechts →
  /einstellungen mit Firma (neu: Firmendaten & Bankverbindungen bearbeiten, nur Admin), Benutzer, Leistungsarten, Mahnstufen,
  Briefvorlagen Kunden, Gläubiger-ID, DATEV/Nachkalkulation, Lohnstufen, Dokumentvorlagen, Zeiterfassung/Mindestlohn,
  Leistungswerte, Arbeitskleidung. Aus den Fachmenüs entfernt: Leistungsarten, Lohnstufen, Dokumentvorlagen, Leistungswerte.
  Einträge nach Rolle gefiltert; Objektleitung hat keine Einstellungen.
- 2026-10-06: Kunde → Übersicht zeigt „Rechnungsangaben der Objekte“: „x von y Objekten wie Kunde“ und nur die abweichenden
  Objekte mit ihren Unterschieden (Adresse, E-Mail, Format, Leitweg-ID, Zahlungsziel, Skonto). Rechnung (Entwurf/ausgestellt)
  zeigt „Rechnung an“ mit Kennzeichen „vom Objekt“ und Empfänger-E-Mails; Skonto-Vorschau im Entwurf aus den Objektangaben.
- 2026-10-06: Offene Posten wie Fortytools: je Kunde ein Block (Kd.-Nr., Name, offene Summe gelb, alle auswählen), je Rechnung
  Soll (Rechnungsbetrag) und Haben (Zahlungen, Skonto-Abzug, Storno/Korrektur mit Datum), Summenzeile, Saldo, Fälligkeit,
  „x T. überfällig“, „Skonto bis“, Auswahl-Häkchen. Filter Alle/Überfällig, Suche. Kennzahlen offen gesamt/überfällig.
  „Mahnung erstellen“ für die Auswahl (gleiche Regeln wie Stapelverarbeitung, optional gleich per E-Mail).
- 2026-10-06: Rechnungsarchiv nach Leistungszeitraum (Rechnungen → Reiter „Archiv“): Jahr wählen, je Monat des Leistungsbeginns
  (ohne Zeitraum: Rechnungsdatum) Anzahl, netto/brutto, Belege (PDF, ZUGFeRD, XRechnung, Anlagen) und „ZIP herunterladen“
  (je Rechnung ein Ordner; jede Datei wird gegen ihre SHA-256 geprüft). Neue direkte Abhängigkeit `fflate` (war schon indirekt da).
- 2026-10-06: Ausschreibungen statt Abgabefristen am Angebot (Ahmed: Angebot mit Frist gibt es noch nicht, weil Preise fehlen):
  Angebote → Ausschreibungen: Titel, Vergabestelle, Kunde/Interessent, Vergabenummer, Verfahren, Plattform + Link, Abgabefrist,
  Bieterfragen bis, Ortsbesichtigung (Pflicht?), Bindefrist, Vertragsbeginn/Laufzeit, geschätztes Volumen, Notizen,
  Vergabeunterlagen (Dateien). Zeiten als Berliner Ortszeit. Status neu → prüfen → teilnehmen → abgegeben → gewonnen/verloren
  (Grund Pflicht) / nicht teilnehmen (Grund Pflicht) / aufgehoben; Zuschlagsquote 12 Monate. „Nächste Termine“ (3 Wochen) in
  der Liste und auf der Startseite (14 Tage) statt Angebotsfristen. „Angebot erstellen“ übernimmt Titel, Vergabenummer,
  Plattform, Frist in einen Angebotsentwurf; nach dem Speichern verknüpft (Status → in Bearbeitung).
  Tests: neu `tenders.db.test.ts`, `npm run e2e:ausschreibung` (10 Prüfungen).
