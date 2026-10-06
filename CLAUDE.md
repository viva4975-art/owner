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

- [x] ~~Supabase-Projekt Frankfurt~~ – seit 06.10. nicht mehr nötig (alles auf IONOS); Projekt kann später gelöscht werden (vorher fragen)
- [ ] Fortytools-Export: Kunden, Objekte, Leistungen/Preise, 3–5 Beispielrechnungen inkl. XRechnung
      (auch als PDF – für den Layout-Abgleich „sieht aus wie heute“)
- [ ] Bestätigen: Nummernkreis von Fortytools fortführen (umgesetzt, Startwert vor Live-Start setzen)
- [ ] Lieferantennummern bei Behörden, Leitweg-IDs der Behörden-Kunden (Steuernummer 143/190/63154 vom Briefpapier übernommen)
- [ ] Mail-Zugang (SMTP) für buchhaltung@viva-deluxe-reinigung.de (IONOS Exchange) in `.env.live` eintragen – Absender steht fest
- [ ] Testadresse für den Prototyp-Versand
- [x] IONOS VPS (4 vCores/8 GB, Ubuntu 24.04, 217.160.236.117) installiert, läuft unter https://app.viva-deluxe-reinigung.de
- [ ] AVV mit IONOS; IONOS Cloud Backup (Sicherung außerhalb des Servers); root-Passwort ändern und ersten GitHub-Token
      löschen (beide standen im Chat); SMTP-Zugang nachtragen (`.env.live`)
- [ ] Lexware-Lohnprogramm (genaue Bezeichnung, Importformat)
- [ ] Fortytools: eine Rechnungsgruppe von innen zeigen (dort stecken vermutlich die Preise je Objekt)
- [ ] Briefpapier ab 01.11.2026 (neue Adresse) als Datei vom Grafiker, 300 dpi
- [ ] Mit Steuerberater klären: Belegart 384 für Storno/Korrektur; Bedarf § 13b (Reverse Charge)
- [ ] Branchen-Mindestlohn Gebäudereinigung (aktueller Wert) unter Zeiterfassung → Einstellungen eintragen
- [ ] Übersetzungen der Handy-Ansicht (ro, tr, pl, hr, bg) von Muttersprachlern im Team gegenlesen lassen
- [ ] Steuerberater: DATEV Berater-/Mandantennummer, Kontenrahmen (SKR03/04), BU-Schlüssel für § 13b-Eingangsrechnungen,
      Behandlung Schlussrechnung/Abschläge und Skonto; ersten Testexport gemeinsam prüfen
- [x] ~~Lohnzuschlag~~ – Ahmed 06.10.: Minijob 32 %, Teilzeit bis 30 Std. 28 %, darüber 26 %
- [x] ~~Mahngebühren/Verzugspauschale~~ – Ahmed 06.10.: 0/5/10 € + 40 € Pauschale (umgesetzt, Anrechnung beachten)
- [ ] Rechnungsnummer-Startwert (Ahmed meldet sich), Screenshots Qualitätskontrolle (fehlten in der Anlage)
- [ ] Qwist (Bankabruf wie Fortytools): API-Zugang/Vertrag bei Qwist anfragen
- [ ] Je Behörde klären: nimmt sie XRechnung per E-Mail an oder nur über ein Portal (ZRE/OZG-RE, Peppol)?
- [ ] SEPA-Zahlungslauf: erste pain.001-Datei als Testeinreichung bei der Bank hochladen (Format/Limit prüfen)
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
- 2026-10-06: SEPA-Zahlungslauf entfernt (Ahmed) – **Missverständnis, korrigiert, siehe nächster Eintrag** → Lieferanten → Zahlungsliste: freigegebene Eingangsrechnungen nach Fälligkeit/
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
- 2026-10-06: Kostenstellen (Ahmed: alles auf Kostenstellen verrechnen, auch Sub-Rechnungen, in die Nachkalkulation):
  Jedes Objekt ist Kostenstelle; allgemeine Kostenstellen unter Einstellungen (9000 Verwaltung, 9100 Fahrzeuge, 9200 Lager,
  9300 Werbung, 9400 Personal allgemein). Eingangsrechnung → „Kostenstellen“: Aufteilung auf Objekte/Kostenstellen × Leistungs-
  monat, Summe muss Cent-genau dem Netto entsprechen; „gleichmäßig auf Monate verteilen“ (z. B. Jahresversicherung, Rest-Cent
  auf die ersten Monate). Ohne eigene Aufteilung automatisch: Objekt + Leistungsmonat der Rechnung (bleibt beim erneuten
  Speichern synchron; eigene Aufteilung wird nicht überschrieben). Nachunternehmer-Auftrag am Rechnungseingang setzt das Objekt.
  Nachkalkulation rechnet mit der Aufteilung; neu Auswertungen → „Kostenstellen“ (je Kostenart, Zeitraum) mit Liste „nicht
  zugeordnet“. Bestand übernommen (Rechnungen mit Objekt).
  Tests: 232 Unit-/DB-Tests; alle 22 Browser-Suiten grün.
- 2026-10-06: Korrektur (Ahmed: „die SEPA-Lastschriften sollen raus, nicht der Zahlungslauf“):
  - SEPA-Lastschriften (Einzug bei Kunden) entfernt: Menü, Reiter Transfer, Einstellung Gläubiger-ID, Mandate,
    Einzugsdateien; `/transfer/lastschriften` leitet auf Kontoumsätze. Rechnungen enthalten keinen Lastschrift-Hinweis mehr
    (immer Überweisung mit Skonto/GiroCode). Tabellen und Altdaten bleiben in der Datenbank (nichts gelöscht), Code in
    `services/direct-debit.ts` bleibt für einen späteren Wiedereinbau.
  - SEPA-Zahlungslauf wieder da, als Knopf in der Zahlungsliste: Rechnungen auswählen → Ausführungstag + eigenes Konto →
    „SEPA-Datei erstellen“ (pain.001.001.09, archiviert, Rechnungen gelten als bezahlt, nicht zurücknehmbar). Liste der
    SEPA-Dateien mit XML-Download. „Als bezahlt festhalten“ für Einzelüberweisungen bleibt.
- 2026-10-06: Testbetrieb auf eigenem Server (Ahmed: „live stellen und testen“, IONOS):
  - Nicht IONOS-Webhosting, sondern IONOS VPS (Ubuntu, ≥ 4 GB RAM, Deutschland). `Dockerfile` ohne apt (Temurin-JRE +
    Node aus dem offiziellen Image, KoSIT im Build geladen), `deploy/docker-compose.yml` mit Caddy (HTTPS automatisch),
    `deploy/install.sh` (Docker, Firewall, Zugangsdaten interaktiv nur auf dem Server, `.env.live` Rechte 600, Werte in
    einfachen Anführungszeichen, DB-Passwort URL-kodiert), `deploy/update.sh` (optional alle 10 Min. automatisch per cron).
    Anleitung `docs/IONOS.md`. Render-Vorlage verworfen.
  - Container hier geprüft (Build mit lokalem Cache, da GitHub/Debian in der Sandbox gesperrt): KoSIT, Migration, App,
    Browser-Tests e2e/einkauf/auftrag gegen den Container grün. Noch nicht gegen das echte Supabase-Projekt gelaufen.
  - Behoben: Ohne SMTP-Zugang startete die App nicht. Jetzt startet sie; Versand von Rechnungen/Mahnungen wird vorab mit
    Hinweis abgelehnt (kein Versandeintrag, kein „unklar“-Status).
- 2026-10-06: **Alles auf IONOS statt Supabase** (Ahmed: „alles in einem, günstiger“) – ersetzt die Entscheidung
  „Supabase bleibt“:
  - Postgres 16 im Docker-Verbund auf dem VPS (nur internes Netz), `DB_HOSTING=eigen`: Migrationen mit Supabase-Shim
    (`auth.uid()`, Rollen) wie lokal, RLS bleibt, Konten in `app.user_accounts`/`auth.users` lokal. Konfiguration lehnt mit
    `eigen` jede Datenbank außerhalb des Servers ab. Supabase-Variante bleibt im Code (`DB_HOSTING=supabase`).
  - Firmenstamm wird beim Start angelegt, falls leer (Fund: frische Datenbank hatte keine Firmendaten → keine Rechnungen).
  - Sicherung `deploy/backup.sh` täglich 02:30 (pg_dump + Dateien, 14 Tage) nach `/opt/viva-sicherung`; Wiederherstellung
    geprüft. **Risiko:** Sicherung liegt auf demselben Server → IONOS Cloud Backup dazubuchen; GoBD-Archiv mit Object Lock
    (z. B. IONOS S3) vor dem Echtbetrieb.
  - Geprüft: kompletter Verbund (Postgres + App + KoSIT) hier gestartet, leere DB → Migration + Firmenstamm, Anmeldung mit
    Sonderzeichen-Passwort, Browser-Tests e2e/einkauf/auftrag/module/import grün; Rechte-Test braucht HTTPS (sichere
    Cookies außerhalb dev) – auf dem Server über Caddy gegeben.
- 2026-10-06: **Testbetrieb läuft** auf https://app.viva-deluxe-reinigung.de (IONOS VPS, automatische Updates alle 10 Min.,
  Sicherung 02:30). Bei der Installation gefunden und behoben: Repo mit umask 077 geklont → App durfte Dateien nicht lesen
  (Dockerfile macht Quellcode lesbar); Benutzername mit Leerzeichen verletzte DB-Regel (wird jetzt zu `name.nachname`,
  Fehlstart wird erneut versucht). Neu: `src/scripts/reset-password.ts` (Einmal-Passwort auf dem Server). Admin-Login:
  `ahmed.chomontek`. Ahmed testet jetzt mit eigenen Daten und schickt Änderungen.
- 2026-10-06: Erste Rückmeldungen aus dem Testbetrieb (Ahmed):
  - **Formulare wie Fortytools:** ein Feld pro Zeile untereinander, Beschriftung links (CSS `form .grid`, global für alle
    Formulare; auf dem Handy Beschriftung über dem Feld).
  - **Rechnungseinstellungen nur noch in Rechnungsgruppen** (nicht am Kunden): Gruppe = Rechnungsadresse (leer = Kunde),
    Ansprechpartner, Rechnungs-E-Mails, Format, Leitweg-ID, Lieferantennr., Bestellnr., Zahlungsziel, Skonto, Kopf-/Fußtext,
    Schalter „Sammelrechnung“ (alle Objekte der Gruppe auf einer Rechnung, sonst je Objekt). Jedes Objekt wählt eine Gruppe
    (Reiter „Rechnungsangaben“), neue Kunden bekommen Gruppe „Standard“, neue Objekte landen dort. Reihenfolge der Angaben:
    (alt) abweichend am Objekt → Gruppe → Kunde. Ausstellen (`app.issue_invoice`), Monatslauf, Käufer-Schnappschuss,
    Versand und Mahnungs-Empfänger nutzen die Gruppe. Migration: bestehende Gruppen = Sammelrechnung mit Kundenangaben,
    Objekte mit abweichenden Angaben → eigene Gruppe, übrige → „Standard“.
  - Kunde: Mahnsperre und „öffentlicher Auftraggeber“ aus dem Formular entfernt (Felder bleiben in der DB); Status
    Kunde (grün) / Interessent (gelb) / ehemaliger Kunde (rot = inaktiv) im Formular, in der Liste und in der Kundenkarte.
  - Tests: 238 Unit-/DB-Tests, alle 22 Browser-Suiten grün (`e2e:rechnungsangaben` neu für Gruppen + Formular).
- 2026-10-06: Rückmeldungen Teil 2 (Ahmed, Screenshots Fortytools):
  - Kunde: Hauptansprechpartner aus dem Formular (→ Reiter Kontakte); Abschnitte „Basisdaten“ und „Zusatzinformationen“:
    USt-IdNr., Kurzinfo, Hinweise zur Rechnungsstellung (erscheinen beim Rechnungsentwurf), Einsatzort-Notizen (erscheinen in
    der Handy-App bei Einsätzen/QR-Seite), Warnhinweis (rot im Kundenkopf und beim Rechnungsentwurf). Nicht mitgeschickte
    Felder werden beim Speichern nicht überschrieben (Import/Altdaten bleiben).
  - Bearbeiten-Seiten (Kunde, Objekt) ohne Reiterleiste, nur Kopf mit Brotkrumen.
  - Zwei Tabs: Eingaben aller Eingabeformulare (POST) werden je Tab im sessionStorage gesichert (Schlüssel = Seitenadresse +
    Formularnummer, auch „Neu“-Formulare), nach Speichern verworfen; Browser-Test mit zwei Tabs (25 Prüfungen).
  - Kundenübersicht wie Fortytools: Aufgaben, Offene Posten (Rechnung, Datum, Tage bis fällig, Soll/Skonto/Haben/Saldo, Auswahl
    → „Mahnung erstellen“), offene Angebote, Netto-Umsatz (Säulen mit Achse + Monatstabelle mit Summe, nach Rechnungsdatum oder
    Leistungszeitraum, ab Jahr); rechts Kundenkarte (Adresse, Karte-Link, Rechnungs-E-Mails, Kunde seit, Status), Karte (lädt
    Google Maps erst auf Klick – Datenschutz), Bankkonten (IBAN-Prüfziffer), Rechnungsgruppen.
  - Design „klassisch“ statt „KI-Look“: Systemschrift, dunkle Bordeaux-Kopfzeile, weiße Menüleiste, Karteireiter mit weißem
    Inhaltsbereich, eckige Kästen/Schilder (3 px) ohne Schatten, Tabellenköpfe normal geschrieben.
  - Tests: 240 Unit-/DB-Tests, alle 22 Browser-Suiten grün.

- 2026-10-06: Runde 3b (Ahmed):
  - „Leer = übernommen“ überall durch Häkchen ersetzt, das die Felder aufklappt (`data-reveal`): Rechnungsgruppe (eigene
    Adresse, Mahnungs-E-Mails, Skonto, eigene Texte), individueller Stundenlohn, befristeter Einsatz, abweichendes
    Fälligkeitsdatum, Festpreis Sonderdienst. Zugeklappte Felder werden nicht gesendet.
  - Eigene E-Mail-Adressen für Mahnungen je Rechnungsgruppe (`invoice_groups.dunning_emails`), sonst Rechnungs-E-Mails.
  - Reiter „Rechnungen“ bei Kunde und Objekt wie Fortytools: Monatsübersicht netto/brutto (6 Monate), Liste mit Datum,
    Rechnung + PDF, Empfänger, Objekt (bzw. „ohne Objekt“ bei Sammelrechnungen), Positionen, Netto, Brutto, Status
    offen/bezahlt/storniert.
- 2026-10-06: Runde 3c, Teil 1 – Objektseiten:
  - Notizen wie Fortytools (Kunde, Objekt, Mitarbeiter): Liste mit Datum, Erfasser, Titel/Details, Anhänge, „+ Aufgabe
    hinzufügen“ (Aufgabe mit Titel vorbelegt). Notiz änderbar (Versionszähler, Erfasser bleibt, „geändert von“), Anhänge je
    Notiz (Recht wie die Notizen des Datensatzes). Spalten `notes.title/note_date/version`.
  - Objekt → Dokumente: Pflichtkategorien Raumbuch, Leistungsverzeichnis, Revierplan (fehlt = rot), dazu Vertrag/Sonstiges.
  - Objekt → Schlüssel: eigene Seite mit Liste, Ausgabe/Rückgabe direkt in der Zeile, „Schlüssel erfassen“ (Nummer
    `S-<Objektnr.>-NN` vorgeschlagen). Protokoll weiter im Schlüsselbuch.
  - Objekt → Angebote: Angebote des Objekts, „+ Angebot für dieses Objekt“; im Angebots-PDF steht über der Anrede fett
    „Objekt: Name (Nr.), Adresse“.
  - Behoben: Bei mehreren Upload-Feldern auf einer Seite funktionierte nur das erste.
  - Tests: neu `npm run e2e:objektseiten` (18 Prüfungen), Notiz-Test in `phase2.db.test.ts`.
- 2026-10-06: Runde 3c, Teil 2 – Raumbuch und Stundenvorgabe:
  - Leistungswerte (m²/h) entfernt: Raumbuch zeigt Etage, Raum-Nr., Raum, Raumart, Bodenbelag, Fläche, Intervall (+ Summe).
    Einstellungen → „Raumarten“ (nur Name/aktiv) statt „Leistungswerte“; alte Adresse leitet um.
  - Raumbuch aus Excel (.xlsx, erstes Blatt) oder CSV importieren: Kopfzeile wird gesucht (auch unter Titelzeilen),
    Spalten über Namen erkannt, Intervall aus Text („5x wöchentlich“, „täglich“ = Mo–Fr, „14-tägig“, „1x Monat“, Zahl bis
    7 = pro Woche), Fläche exakt (kein Gleitkomma). Vorschau als GET-Seite (Datei write-once), Fehlerzeilen werden
    übersprungen, unbekannte Raumarten angelegt, vorhandene Räume (Etage + Nr.) nur mit „überschreiben“. Feste IDs →
    doppelt absenden legt nichts doppelt an. Eigener xlsx-Leser (fflate + Textsuche, DOCTYPE abgelehnt).
  - Stundenvorgabe von Hand (`site_hour_targets`): je Wochentag Mo–So, je Monat oder je Jahr (2:30 oder 2,5); Umrechnung
    Woche = Jahr ÷ 52, Monat = Jahr ÷ 12; Vergleich mit Einsatzplan, fürs Büro Erlös je Stunde.
  - Tests: `sheet.test.ts` (xlsx/CSV/Intervall/Fläche), Import- und Stundenvorgabe-Test in `facility.db.test.ts`,
    `e2e:objektseiten` 26 Prüfungen, `e2e:objekt` angepasst.
- 2026-10-06: Runde 3c, Teil 3 – Einsätze und Erfasste Zeiten am Objekt (nach Ahmeds Screenshots):
  - Objekt → Einsätze: Kalender mit Ansichten Tag / 5 Tage / Woche (Standard) / Monat, blättern + „Heute“, Farben geplant /
    erledigt (Zeit erfasst) / Vertretung–umgeplant / abwesend / Feiertag / Ausfall. „Wiederkehrende Einsätze“ = bisherige
    Liste. Darunter „Zusammenfassung“ (Jahr und Monat: geplante Stunden + Termine, ohne Feiertage/Ausfälle) und
    „Nächste Einsätze“ (höchstens 15).
  - Objekt → Erfasste Zeiten: Monat oder freier Zeitraum, Ansicht Übersicht (je Mitarbeiter Einsätze, Dauer, Geplant,
    Differenz, Gesamtsumme; offene Nachträge markiert) oder Details (je Zeit Beginn/Ende/Pause/Dauer/Geplant/Status).
    Geplant zählt höchstens bis heute. Monatsübersicht 12 Monate mit „Zeiterfassung bestätigt“ (Büro, nicht
    Objektleitung): Bestätigen gesperrt bei laufender Stempelung/offenem Nachtrag und für künftige Monate; spätere
    Änderungen werden rot angezeigt („seit Bestätigung geändert“). Tabelle `site_time_confirmations` nur anhängen.
  - Tests: 273 Unit-/DB-Tests (neu `site-times.db.test.ts`), `e2e:objektseiten` 40 Prüfungen.
  - Offen aus Runde 3: Qualitätskontrolle mit Bildern + Auditanalyse (wartet auf Ahmeds Screenshots), Arbeitsschein-
    Varianten (pauschal / Regiestunden, Namen/Beschreibung optional, Vorgabe je Kunde).
- 2026-10-06: Runde 4a (Ahmed):
  - **Steuersatz:** keine Auswahl mehr in Leistungen, Rechnungs-/Auftragspositionen und Sonderdiensten – immer 19 %.
    **§ 13b UStG** als Häkchen: am Kunden („Kunde ist selbst Gebäudereiniger“, USt-IdNr. Pflicht) als Vorgabe, am
    Rechnungsentwurf abwählbar/anwählbar → alle Positionen 0 %, keine Mischung. E-Rechnung Kategorie AE mit
    `VATEX-EU-AE` und Begründung (KoSIT-gültig UBL + CII), PDF mit fettem Pflichthinweis „Steuerschuldnerschaft des
    Leistungsempfängers (§ 13b UStG)“ und USt-IdNr. des Kunden. Storno/Korrektur übernehmen das Kennzeichen.
    **Mit Steuerberater bestätigen** (offener Punkt bleibt).
  - Leistung: Kostenstelle mit Objektnummer vorbelegt (Bestand nachgetragen), Leistungsart füllt den leeren Titel,
    Art/Steuersatz/Stundenvorgabe aus dem Formular entfernt (Stundenvorgabe jetzt am Objekt). Neue Zyklen „einmalig“ und
    „je Ausführung“; Art wird abgeleitet (Einheit Stunde = Regie, regelmäßiger Zyklus = Pauschale im Monatslauf, sonst
    Sonderleistung). Bestehende Sonderleistungen/Regie → „je Ausführung“.
  - Leistungszeitraum: im Rechnungsentwurf Pflicht (nur „von“ = ein Tag), Ausstellen ohne Zeitraum gesperrt.
  - Tests: 279 Unit-/DB-Tests (neu § 13b-KoSIT, § 13b-Ablauf, Ausstellen ohne Zeitraum).
- 2026-10-06: Runde 4b – Leistungen verrichten und Vorfaktura (Ahmed, Fortytools-Bild „Markierte Leistung(en) verrichten“):
  - Objekt → Leistungen & Preise → „Leistungen verrichten“: Leistungen „je Ausführung“/„einmalig“ (auch Regie) ankreuzen,
    Menge je Zeile, Datum von (bis leer = ein Tag) → vorgemerkte Ausführung (`service_executions`, Preis eingefroren,
    feste ID je Formular → doppelt absenden legt nichts doppelt an; Datum muss in der Gültigkeit liegen; „einmalig“ nur
    einmal). Liste „Vorgemerkt“ mit „zurücknehmen“ und „Rechnungsentwurf daraus erstellen“.
  - Rechnungen → Entwürfe neu: „Vorgemerkte Leistungen“ je Kunde (Häkchen je Zeile, je Kunde, alle) → „Entwürfe
    erstellen“ mit Rechnungsdatum (je Objekt bzw. Rechnungsgruppe ein Entwurf wie der Monatslauf; Leistungszeitraum aus
    den Ausführungen). „Rechnungsentwürfe“ je Kunde mit Summen, Leistungszeitraum (fehlt = rot), Rechnungsdatum, Hinweisen
    (unfertig, § 13b); Auswahl → Rechnungsdatum setzen / markierte ausstellen (je Rechnung KoSIT, Fehler halten die
    anderen nicht auf, Meldung je Kunde/Objekt) / markierte löschen (Ausführungen werden wieder frei).
  - Tests: 281 Unit-/DB-Tests (neu `executions.db.test.ts`), neu `npm run e2e:vorfaktura` (12 Prüfungen).
- 2026-10-06: Runde 4c:
  - Angebot anlegen wie Fortytools (`/angebote/neu`): „Kunde suchen“ (Nummer oder Name), rechts „zuletzt bearbeitete
    Kunden“, Auswahl **Angebot schreiben** oder **Ausschreibung vormerken** (→ Ausschreibung mit Kunde vorbelegt: Frist,
    Bieterfragen, Link). Im normalen Angebot keine Vergabe-Felder mehr (nur bei Angeboten aus einer Ausschreibung).
  - „Alle Rechnungen“ und „Archiv“ zusammengelegt: Jahr, Suche, gruppiert nach Leistungszeitraum (Standard) oder
    Rechnungsdatum, je Monat Summen, Belege und ZIP (nach Leistungszeitraum). `/rechnungen/archiv` leitet um.
- 2026-10-06: Runde 4d – Nachunternehmer wie die alte App (Screenshots), Zahlungsliste:
  - Nachunternehmer mit Reitern: Übersicht (Ampel, Stammdaten, Nachweise je Kategorie, Upload-Portal, Nachforderung,
    Übergaben, Kündigung), **Stammdokumente / Unbedenklichkeit / Mindestlohn** (je Nachweis Karte mit PFLICHT/OPTIONAL,
    Status, Datei, „gültig bis“ mit Knopf „+12M/+36M“, „Neue Version hochladen“, frühere Versionen aufklappbar –
    archiviert, nie gelöscht; Zähler „5/6 + 0/2 optional“), Aufträge, **Ansprechpartner** (mehrere, Hauptkontakt geht in
    die Stammdaten; `supplier_contacts`, Bestand übernommen), **Dokumente** (Verträge, Schriftverkehr, Rechnungen,
    Sonstiges, write-once). Nachweis-Fristen und Ansprechpartner nicht mehr im Bearbeiten-Formular.
  - Abrechnung von Nachunternehmer-Aufträgen zusätzlich **je Tag** (Monatspauschale, je Einsatz, je Stunde, je Tag).
  - Nummern: Material- und NU-Bestellungen nutzen denselben Zähler `BE-JJJJ-NNNN` → keine doppelten Nummern.
    Auftragsvorlage der alten App folgt (Ahmed schickt sie).
  - Zahlungsliste ist ein Reiter im Rechnungseingang (Menü „Rechnungseingang & Zahlungsliste“).
  - Tests: `e2e:nachunternehmer` 27 Prüfungen (Reiter, +36M, Versionen, Ansprechpartner, je Tag).
- 2026-10-06: Runde 4e – Suche in Auswahllisten: jede Auswahl ab 12 Einträgen (Kunden, Objekte, Mitarbeiter, Lieferanten …)
  bekommt automatisch ein Suchfeld darüber (Nummer oder Name, ohne Umlaut-/Groß-Klein-Unterschied, mehrere Wörter); Enter
  übernimmt den ersten Treffer. Die echte Auswahlliste bleibt (Formulare/Prüfungen unverändert). Alle 23 Browser-Suiten grün.
- 2026-10-06: Runde 5a – Fortytools-Gesamtimport (Transfer → Import aus Fortytools, oben): die vier Exporte unverändert
  (Kunden, Objekte, aktive Leistungen, Mitarbeiter), Erkennung an der Kopfzeile, CSV mit Zeilenumbrüchen im Feld.
  Kunden: je Kontakt eine Zeile → ein Kunde + Kontakte; Name mehrzeilig → Name/Name 2; „7 Tage 3%, 20 Tage netto“ → Skonto
  3 %/7 Tage, Ziel 20; „SUBUNTERNEHMER“ → Warnhinweis § 13b; Interessenten ohne Nummer bekommen die nächste freie; IBAN
  (Prüfziffer) → Bankkonto; Format ZUGFeRD. Objekte: Nummer = Kundennummer + 2 Stellen, Kunde über Nummer oder Kurzname.
  Leistungen: Objekt über Kunde + Objektname (mehrdeutig → erstes, Hinweis), ohne Objekt → Objekt „Allgemein (aus
  Fortytools)“; Betrag = Einzelpreis; Menge 1 → pauschal, Preis < 2 € → m², sonst Stück; **Unterhaltsreinigung/Spüldienste
  monatlich, alles andere „je Ausführung“ (Ahmed: je Objekt prüfen)**; Leistungsarten werden angelegt. Mitarbeiter: Tags →
  Beschäftigungsart (ohne Tag aus Wochenstunden), Austritt in der Vergangenheit → ausgetreten; ohne Eintrittsdatum = Fehler.
  Feste IDs/external_ref → erneut importieren legt nichts doppelt an; „aktualisieren“ überschreibt, Nummern bleiben, bei
  Mitarbeitenden nur Fortytools-Felder (Steuer-ID, IBAN, Lohn bleiben). Probelauf mit den echten Exporten in einer
  Wegwerf-DB: 177 Kunden (4 ohne Adresse = Fehler), 391 Objekte (16 „Allgemein“), 678 Leistungen, 266 Mitarbeiter
  (4 ohne Eintritt/Personalnr.), 98 Kontakte, 60 Bankkonten; 11 s, zweiter Lauf ohne Dubletten. Echte Dateien nicht im Repo.
- 2026-10-06: Runde 5b – Nachkalkulation mit Lohnzuschlag je Beschäftigungsart (Einstellungen → DATEV/Nachkalkulation;
  Minijob = Beschäftigungsart Minijob, sonst Wochenstunden > 30 bzw. Vollzeit ohne Stunden = 26 %, Rest 28 %).
  Verzugspauschale 40 € (§ 288 Abs. 5 BGB) je Rechnung einmal (DB-Index), ab der Mahnstufe mit Häkchen (Standard ab
  1. Mahnung), nicht bei „Privatkunde (Verbraucher)“ (neues Kundenfeld). **Rechtlich: Die Pauschale wird auf
  Rechtsverfolgungskosten angerechnet (§ 288 Abs. 5 S. 3 BGB) → enthält eine Mahnung die Pauschale (jetzt oder früher),
  entfällt ihre Mahngebühr.** Kontenrahmen SKR03 war schon Standard. Raumbuch-Import: „täglich“/ohne Intervall wählbar
  Mo–Fr 260 / Mo–Sa 312 / Mo–So 365 („arbeitstäglich“ bleibt 260, „Mo–Sa“/„Mo–So“ eindeutig).
  Tests: 290 Unit-/DB-Tests; Browser-Test `e2e:import` 13 Prüfungen.
- 2026-10-06: Runde 6a (Ahmed, 7 Punkte + Fortytools-Screenshots Planung): Menü „Angebote“ ist ein einzelner Punkt
  (Übersicht mit „+ Angebot anlegen“, dort auch Ausschreibung vormerken; Reiter „Ausschreibungen“ bleibt in der Liste).
  Ausschreibung mit Abgabefrist = automatische Aufgabe (feste ID, Fälligkeit = Abgabetag, Link zur Ausschreibung; erledigt
  bei Abgabe/Entscheidung, Bestand übernommen). „Aufträge“ jetzt unter Rechnungen. „Einzelrechnung anlegen“ und
  „Mitarbeiter anlegen“ aus dem Menü (Knopf auf der Mitarbeiterliste). Eingaben werden still wiederhergestellt (kein gelber
  Balken mehr; nur bei Konflikt mit neuerem Stand wird gefragt). Unit-Test räumt seine 240-MB-Testdateien wieder weg.
- 2026-10-06: Runde 6b – Lieferanten & Nachunternehmer im Stil des alten Portals: eine Liste für beide (Karten mit Nummer,
  Ampel-Schild, Ort/Telefon/offene Bestellungen; bei Nachunternehmern Compliance-Balken, „Fehlt: …“, „Läuft ab: …“),
  Kennzahl-Kacheln als Filter (Aktiv/Kritisch/Warnung/Vollständig), Fristen-Hinweis (abgelaufen oder in 14 Tagen),
  Suche, Pillen Alle/Nachunternehmer/Lieferanten, Schalter „Inaktive einbeziehen“, Hinweis auf Portal-Uploads zum Prüfen.
  Eigene Seite „Nachweise & Fristen“ entfällt (/nachunternehmer leitet um). Bestellungen = Material-Bestellungen und
  Nachunternehmer-Aufträge in einer Liste (gleicher Nummernkreis BE-JJJJ-NNNN): Zu erledigen (Entwurf, geliefert ohne
  Rechnung) / Laufend / Abgeschlossen / Alle, Auswahl Lieferant, Suche; „+ Material bestellen“, „+ Nachunternehmer
  beauftragen“. Soll/Ist je Monat entfernt. Reiter „Aufträge“ beim Nachunternehmer heißt „Bestellungen“.
- 2026-10-06: Runde 6c – Planung wie Fortytools (Screenshots „Planung (KW 41)“, „Termin oder Terminserie planen“):
  - Tafel `/einsatzplanung`: „Zu planende Einsätze“ (Termine ohne Mitarbeiter, „Nicht zugeordnet“) und „Geplante Einsätze“ je
    Mitarbeiter, gruppiert nach Einsatzgruppe; Tag / 5 Tage / Woche / Monat, Heute/Diese Woche, ← →, Datum, Einsatzgruppen-
    Auswahl, Mitarbeiterfilter mit Häkchen und Suche, „auch ohne Einsatz“; Hinweis „x Einsätze für abwesende Mitarbeiter“,
    „Umplanen“ (→ Vertretungen); heute gelb, Feiertage blau, Abwesenheit schraffiert; Farben offen/geplant/erledigt/umgeplant/
    abwesend. Monatstafel ist die Monatsansicht (alte Adresse leitet um).
  - „Termin oder Terminserie planen“: Einsatzort nach Kunden gruppiert, Einmalig / Wöchentlich (alle n Wochen, mehrere Tage) /
    Monatlich (am selben Tag, alle n Monate), ab, Uhrzeit, Dauer, Enddatum, Pause in h, „In allen / ausgewählten Monaten“,
    mehrere Mitarbeiter oder „offen“, Einsatzgruppe, Beschreibung. Neue Spalten `shift_plans.recurrence/every/months/series_id/
    planning_group`, `employee_id` darf leer sein (offen; zählt nicht als Soll, erscheint nicht in der Handy-App).
  - Serie ändern behält vorhandene Einsätze (gleiche IDs, Zeiten hängen daran); weggefallene Mitarbeiter/Tage enden gestern.
    Offenen Termin anklicken → Serie zum Besetzen; geplanten Termin anklicken → Tag umplanen/Vertretung/Ausfall (zurück in
    die Tafel). „Vertriebskondition/Lohnkondition“ und „Weitere Tätigkeit“ aus Fortytools noch nicht übernommen.
  - Tests: 295 Unit-/DB-Tests (neu `shift-series.db.test.ts`), `e2e:planung` neu (24 Prüfungen), `e2e:zeit` angepasst.
- 2026-10-06: Runde 6d – Design moderner (Ahmed: „muss moderner wirken“), Formensprache des alten Viva-Portals für die ganze
  App: Schrift Inter, warmes Off-White, weiße Karten mit feiner Linie und weichem Schatten (Radius 12–14 px), Bordeaux-
  Kopfzeile mit Logo-Karte und Suchpille, weißes Menü mit unterstrichenem aktiven Punkt, Pillen-Schilder, Reiter als
  Unterstreichung, Knöpfe/Felder mit 8–10 px Radius und goldenem Fokus. Neuer CSS-Block am Ende von `layout.tsx` (der
  klassische Block bleibt als Grundlage darunter, wird überschrieben).
- 2026-10-06: Runde 7b: Auswahlfelder wie Fortytools – ab 8 Einträgen ins Feld klicken und tippen filtert, Objekte unter dem
  Kunden gruppiert, Tastatur (↑↓ Enter Esc); echte Auswahlliste bleibt (Formulare unverändert).
- 2026-10-06: Runde 8a – Kassenbuch wie die alte App (Verwaltung → Kassenbuch): Reiter Kasse / Karten-Belege / Auswertung,
  Monat wählen, Kacheln Anfangsbestand (festlegen, sonst Übertrag Vormonat) / Einnahmen / Ausgaben / Endbestand, Liste je Tag
  mit „Saldo Tagesende“, Suche, Typ-Filter, PDF/CSV, Buchung mit Beleg-Foto/PDF (write-once). Karten-Belege als Kacheln mit
  Vorschau und ZIP-Export (zählen nicht im Bestand). **Anders als die alte App (GoBD § 146 AO):** fortlaufende Kassen-
  Belegnummer, nie löschen (Storno mit Grund, bleibt sichtbar), Änderungen mit altem/neuem Stand im Protokoll, keine
  Buchung in der Zukunft, Bestand nie negativ, Monatsabschluss mit Kassensturz (gezählt = Buchbestand) sperrt den Monat.
- 2026-10-06: Import aus der alten App (Transfer → Import aus der alten App): Backup-ZIP (oder alle Teile backup-teil-aa …)
  in der App hochladen (fortsetzbar), prüfen (je Bereich neu/schon übernommen, Tabellen im Backup), übernehmen. Idempotent
  über `legacy_id`, Dateien write-once, Beträge über Text in Cent (kein Gleitkomma). Probelauf mit Ahmeds Backup: 334
  Kassenbuchungen, 312 Belege, 154 Karten-Belege, 6 Anfangsbestände – Bestände gehen lückenlos ineinander über.
  **Im Backup fehlen:** Stellenanzeigen, Tiefgaragen-Objekte/-Termine, Grundreinigungs-Planung, Glas-Kunden (gp_kunden).
  Tests: 301 Unit-/DB-Tests, neu `npm run e2e:kasse` (14 Prüfungen).
- 2026-10-06: Runde 8b – Eigen-Compliance wie die alte App (Verwaltung → Eigen-Compliance): 25 Nachweise in 5 Gruppen
  (Pflicht-Kennzeichen, Standard-Gültigkeit), Kacheln Kritisch/Läuft ab/Gültig als Filter, Suche; Hochladen → direkt
  „Datum & Gültigkeit“ (ausgestellt am + 3/6/12/24/36 Monate/5 Jahre/kein Ablauf/manuell, Vorschau „gültig bis“);
  Mehrfach-Nachweise Krankenkassen (+ AOK) und Geschäftsführer (schlechtester Status zählt); „Ersetzen“ schiebt die alte
  Datei ins Archiv (nie löschbar, DB-Trigger); „als geprüft markieren“. Prüfung: 16 Punkte Ja/Nein/N/A + Bemerkung,
  „Prüfung abschließen“ nur wenn alles beantwortet (Stand unveränderlich festgehalten). Report-PDF für Zoll/Auftraggeber
  und Vorlagen (Mindestlohn-Selbsterklärung, Tarif-Compliance, Eigenauskunft) auf Briefpapier. Import aus dem Backup:
  27 Dateien inkl. Archiv. `e2e:kasse` jetzt 22 Prüfungen.
- 2026-10-06: Runde 7c – Einstellungen wie Fortytools: „Einstellungen für <Firma>“ mit Gruppen Meine Daten, Mandantendaten,
  Benutzer & Gruppen, Grundeinstellungen, Vorgaben & Einstellungen, Dokumenteneinstellungen, Disposition-Einstellungen,
  Import & Export (je Eintrag eine Beschreibung), rechts Inhaltsverzeichnis. Zahnrad = Menü „Einstellungen für die Firma“,
  „Einstellungen für <Benutzer>“, Abmelden.
- 2026-10-06: Runde 8c – Akquise wie die alte App (Kunden → Akquise): Kacheln In Pipeline / Heute-überfällig / Gewonnen,
  Suche, „Pipeline · Funnel“ (Erstkontakt → Leichtes → Starkes Interesse → Gewonnen, Conversion = gewonnen/entschieden),
  Status-Pillen, Karten mit Wiedervorlage (überfällig rot, heute gelb) und „Zuletzt: …“, sortiert nach Wiedervorlage.
  Detail: Formular wie alt + „Aktivität“ (Anruf raus/rein, E-Mail, Termin, Angebot, Notiz) mit optionalem neuem Status und
  neuer Wiedervorlage; feste ID je Formular. Besser als alt: Datum Europa/Berlin statt UTC, Wiedervorlagen erscheinen auf
  der Startseite (in der alten App wegen falschem Feldnamen nie). Import: 642 Einträge, 529 Aktivitäten
  („kalt“/leer → Erstkontakt wie in der alten App). `e2e:kasse` jetzt 28 Prüfungen.
- 2026-10-06: Runde 8d – Bewerber & Stellen wie die alte App (Personal → Bewerber & Stellen, nur Admin/Personal): Reiter
  Offene Stellen / Bewerber-Pool / Manuelles Matching. Stellen mit 6 Vorlagen (Reinigungskraft, Glasreiniger, Hausmeister,
  Büro, Vorarbeiter, Fahrer), 26 Objektarten, Arbeitstage je Wochentag (fest/flexibel, „Mo–Fr: 06:00–10:00“), Karte mit
  „Passende Bewerber“ (ab 50 %), „als besetzt markieren“. Plakat A4 in 9 Sprachen (Übersetzungen aus der alten App,
  `src/i18n/job-poster.json`) als Druckseite → „Als PDF speichern“; WhatsApp-Nummer unter Firmendaten (sonst Telefon).
  Matching-Gewichte wie alt (Ort 25, PLZ 15, Sprache 15, Stunden 20/10, Art 15, Zeit 10). **Behoben gegenüber alt:**
  gleiches Vokabular für Art/Arbeitszeit bei Bewerbern und Stellen (alt passten z. B. „Büro“/„Bürokraft“ und
  „morgens“/„morgen“ nie – Treffer waren bei 75 % gedeckelt), „flexibel“ passt zu jeder Zeit. **DSGVO:** Unterlagen liegen
  in der Datenbank (nicht im write-once-Archiv) und werden mit dem Bewerber wirklich gelöscht; abgelehnte Bewerber
  erscheinen nach 6 Monaten als „bitte löschen“ (AGG-Frist). Import: 42 Bewerber (Unterlagen und Stellen nicht im Backup).
  `e2e:kasse` jetzt 37 Prüfungen.
- 2026-10-06: Runde 8e – Glasreinigung-Planer wie die alte App (Disposition → Glasreinigung): Reiter Termine / Kalender /
  Offene Planung / Kunden / Objekte, Kacheln Überfällig / Heute / Diese Woche / Objekte. Objekte mit Kunde, Bezirk aus PLZ,
  Hausmeister, Frequenz (1/2/3/4/6/12× jährlich), Teilbereiche mit eigenem Turnus, Wunschmonate je Termin, Ferien-
  Präferenz, Anforderungen (Führungszeugnis, Hebebühne), Team A/B (Namen einstellbar), Gesamtstunden. Termine auch
  mehrtägig (Block-Reinigung), Bestätigung, „Erledigt“ legt den Folgetermin nach Turnus an (genau einmal, DB-Index).
  Kalender (Feiertage, Schulferien Bayern, Teamfarben, Klick auf Tag = neuer Termin), Monat drucken, Jahresplaner (A4 quer +
  Terminübersicht) als Druckseite, CSV wie alt. Offene Planung je Jahr (Ist/Soll je Objekt und Teilbereich, Restaufwand).
  Auto-Planung mit dem Punktesystem der alten App (Wunschmonate, Mo–Fr, Di–Do bevorzugt, Ferienpräferenz, Brückentage,
  Wochenlast, max. 8 h je Tag, kurze Wege per PLZ, 120 Tage Abstand), Vorschau → übernehmen (feste IDs, nichts doppelt).
  **Schulferien Bayern liegen nur bis Sommer 2027 vor** (`src/domain/time/school-holidays.ts`, jährlich ergänzen).
  Import: 21 Kunden (aus dem Kundennamen am Objekt, Kundentabelle fehlt im Backup), 94 Objekte, 49 Termine, Teamnamen.
  Die bisherigen „Sonderdienste“ bleiben für sonstige Arbeiten. `e2e:kasse` jetzt 48 Prüfungen.
- 2026-10-06: Runde 8f – Tiefgaragenreinigung wie die alte App (Disposition → Tiefgaragenreinigung): Kunde Alle /
  Münchner Wohnen / Dawonia, Kacheln Termine / Offen / Abgeschlossen / Bestätigt, Suche (Objekt, Ort, WE-Nr., TOB).
  Objekte mit m², WE-Nr., Stellplätzen fest/Duplex, Dauer („4 Std.“, „1 Tag“, „1/2 Tag“), TOB + Vertretung, aktiv,
  „dieses Jahr pausiert“, Besitzgesellschaft, Verknüpfung mit einem Objekt (Kostenstelle) für Arbeitsscheine. Termine
  (mehrtägig), Leistungsart Nassreinigung/Kehren/Grundreinigung/Sonstige, „⏰ in N Tg.“, bestätigen / ✓ fertig / ↩.
  Auto-Termin-Planer wie alt (Mo–Fr nach Dauer packen, Tagesbeginn, Std./Tag, Feiertage, Sperrzeitraum, nur neue,
  Reihenfolge PLZ → Name, Vorschau → übernehmen, feste IDs). Aushang-PDF (Text wie alt inkl. Haftungsausschluss), alle
  Aushänge in einem PDF, Aushang-Mail und Erinnerung (an TOB, CC Vertretung), Terminliste und Vorarbeiter-Liste als
  Druckseite, Excel als CSV. Bestätigen legt (bei verknüpftem Objekt) den Arbeitsschein an – Dawonia mit den 13
  Positionen (Stellplätze/Duplex als Menge), Münchner Wohnen eine Position. Keine TG-Daten im Backup.
  `e2e:kasse` jetzt 55 Prüfungen.
- 2026-10-06: Runde 8g – Planung Grundreinigung wie die alte App (Disposition → Planung Grundreinigung): Jahr, Kacheln
  Gesamt / Geplant / Übergeben / Ausgeführt (Archiv), Suche, Summen Umsatz VK / an Sub / Deckungsbeitrag, Karten mit Status,
  Eigenpersonal/Sub, Beläge, VK, Stunden bzw. Preis an Sub („Vorschlag“), DB. Assistent in 5 Schritten (Kunde – Objekt aus
  der Objektliste füllt Kunde/Adresse; Objekt; Flächen & Preis nach Belägen oder pauschal; Ausführung & Kalkulation mit
  DB %, Material/Geräte von uns/vom Sub, Vorschlag an Sub, tatsächlicher Preis, bzw. Eigenleistung 40 €/h mit
  Stundenbudget; Zeitraum, Status, Bemerkung). Rechnung cent-genau (Basispunkte, kaufmännisch gerundet), Sub gewählt +
  „Geplant“ → „Übergeben“. PDF (Druckseite) und Excel (CSV) jeweils mit/ohne Preise. Noch nicht: Objektleitung-Sicht
  ohne Preise, Übergabe direkt als Nachunternehmer-Auftrag. Keine Grundreinigungs-Daten im Backup.
  `e2e:kasse` jetzt 62 Prüfungen (Kasse, Eigen-Compliance, Akquise, Bewerber, Glas, Tiefgarage, Grundreinigung).
- 2026-10-06: Import aus der alten App ergänzt („füg alles schon ein“): Nachunternehmer (Kreditor-Nr. = Lieferantennummer,
  vorhandene mit gleicher Nummer werden nicht doppelt angelegt; Ansprechpartner; 112 Nachweis-Dateien als geprüfte
  Versionen mit Ablaufdatum; 230 Auftragsscheine/Scans der alten Aufträge als Dokumente „Verträge“ – die alten Aufträge
  hängen an Objekt-Texten, daher keine neuen Aufträge), Schriftverkehr (10 Briefe → Dokumenteneingang), Arbeitskleidung
  (Bestand als Inventur, Ausgabe-Protokolle an die Personalakte über die Personalnummer, sonst Dokumenteneingang).
  Probelauf mit dem kompletten Backup: alle Bereiche in < 10 s, zweiter Lauf legt nichts doppelt an. Nur das Protokoll
  der alten App (audit_log) wird nicht übernommen. 320 Unit-/DB-Tests.
- 2026-10-06: Runde 9 – Design auf allen Seiten neu (Ahmed: „modern, schön, nicht wie mit KI“, Vorbilder Planday, Blink,
  zvoove): App-Rahmen mit dunkler, ruhiger Seitenleiste links (Symbole, aufklappbare Bereiche, aktive Seite markiert,
  kurze Bezeichnungen), schlanke weiße Kopfzeile mit Suche, Zahnrad und Benutzer; auf Tablet/Handy wird die Seitenleiste
  zur Schublade (☰). Damit entfällt die zweite, umbrechende Menüzeile; auch die Reiter bleiben einzeilig. Gestaltung:
  eine Akzentfarbe (Bordeaux) sparsam, Linien statt Schatten, Radius 6–8 px, keine Verläufe, Inter, Zahlen tabellarisch.
  Wirkt global über das gemeinsame Stylesheet (alle Seiten). Menü-Eintrag „Archiv“ entfernt (steckt in „Alle Rechnungen“).
