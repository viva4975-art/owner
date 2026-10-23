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
- [ ] Unbezahlte Abwesenheit in den Schulferien: Lexware-Abmeldung bei > 1 Monat ohne Entgelt klären (siehe 10.10.)
- [ ] Datenschutzbeauftragter: Zahl der Personen prüfen, die regelmäßig mit personenbezogenen Daten am Rechner arbeiten
      (ab 20 Pflicht, § 38 BDSG); AÜ-Erlaubnis unter Einstellungen → Firmendaten eintragen
- [ ] Lieferantennummern bei Behörden, Leitweg-IDs der Behörden-Kunden (Steuernummer 143/190/63154 vom Briefpapier übernommen)
- [x] ~~Mail-Zugang (SMTP) für buchhaltung@ in `.env.live`~~ – 11.10.2026 eingetragen (Ahmed)
- [ ] mstore-Reinigungsmittel (Unterhalts-/Sanitärreiniger): Produktnamen, Dosierung + Sicherheitsdatenblätter (PDF) unter
      Einstellungen → Objektordner-Vorlagen hochladen
- [ ] Testadresse für den Prototyp-Versand
- [x] ~~S3-Bucket mit Object Lock~~ – 11.10.2026 eingerichtet (IONOS eu-central-4, Bucket viva-archiv), Kopie läuft
- [x] ~~Ausfallmeldung~~ – 11.10.2026 UptimeRobot (`/health/voll`) + `ALERT_EMAIL` eingerichtet (Ahmed); healthchecks.io optional
- [x] IONOS VPS (4 vCores/8 GB, Ubuntu 24.04, 217.160.236.117) installiert, läuft unter https://app.viva-deluxe-reinigung.de
- [x] ~~AVV mit IONOS, IONOS Cloud Backup (Plan „Viva täglich“, verschlüsselt), root-Passwort, GitHub-Token~~ – 11.10.2026 erledigt (Ahmed);
      Probe-Wiederherstellung vierteljährlich (`docs/anleitung-naechste-schritte.pdf`, Schritt 8)
- [ ] Lexware-Lohnprogramm (genaue Bezeichnung, Importformat)
- [ ] Fortytools: eine Rechnungsgruppe von innen zeigen (dort stecken vermutlich die Preise je Objekt)
- [ ] Briefpapier ab 01.11.2026 (neue Adresse) als Datei vom Grafiker, 300 dpi – 11.10. angefragt
- [ ] Mit Steuerberater klären (11.10. angefragt): Belegart 384 für Storno/Korrektur; Bedarf § 13b (Reverse Charge)
- [ ] Branchen-Mindestlohn Gebäudereinigung (aktueller Wert) unter Zeiterfassung → Einstellungen eintragen
- [ ] Übersetzungen der Handy-Ansicht (ro, tr, pl, hr, bg) – 11.10. ans Team gegeben, Rückmeldung abwarten
- [ ] Steuerberater: DATEV Berater-/Mandantennummer, Kontenrahmen (SKR03/04), BU-Schlüssel für § 13b-Eingangsrechnungen,
      Behandlung Schlussrechnung/Abschläge und Skonto; ersten Testexport gemeinsam prüfen
- [x] ~~Lohnzuschlag~~ – Ahmed 06.10.: Minijob 32 %, Teilzeit bis 30 Std. 28 %, darüber 26 %
- [x] ~~Mahngebühren/Verzugspauschale~~ – Ahmed 06.10.: 0/5/10 € + 40 € Pauschale (umgesetzt, Anrechnung beachten)
- [ ] Rechnungsnummer-Startwert (Ahmed meldet sich), Screenshots Qualitätskontrolle (fehlten in der Anlage)
- [x] ~~Qwist~~ → Enable Banking (gebaut 08.10.): Schlüssel hochladen + Banken verbinden (Ahmed)
- [ ] SEPA-Zahlungslauf: erste pain.001-Datei als Testeinreichung bei der Bank hochladen (Format/Limit prüfen)
- [ ] Je ein echter Kontoauszug (CAMT.053, sonst CSV) von Münchner Bank und Targobank zum Testen des Imports
- [x] ~~Fortytools-XML-Exporte einspielen, Angebotsstatus-Zuordnung~~ – Ahmed 11.10.: Angebote „hat alles gestimmt“;
      in Fortytools keine Rechnungen/Angebote mehr schreiben (Nummernkreise)
- [ ] Word-Vorlagen V6 (vollständig) und Objektordner-Paket V5 hochladen – 11.10. erneut geschickt

## Risiken (rechtlich/steuerlich)

- **E-Rechnungspflicht B2B:** Ab 01.01.2027 dürfen Unternehmen mit mehr als 800.000 € Vorjahresumsatz an
  inländische Geschäftskunden keine reinen PDF-Rechnungen mehr senden (ab 2028 alle). Kundenformat „PDF“
  ist dann nur noch für Privatkunden zulässig → Firmenkunden bis Ende 2026 auf ZUGFeRD/XRechnung umstellen.
- **§ 13b UStG:** Reinigungsleistungen an andere Gebäudereiniger unterliegen ggf. dem Reverse-Charge-
  Verfahren (0 % + Pflichthinweis). Im Prototyp bewusst gesperrt (0 % wird abgelehnt).
- **Archiv:** (seit 11.10.2026 aktiv: IONOS S3 mit Object Lock) Supabase Storage kennt kein Object Lock. Für 10 Jahre revisionssichere Aufbewahrung (GoBD)
  zusätzlich S3-kompatiblen Speicher mit Object Lock (Compliance-Modus) in Deutschland/EU nutzen.
- **§ 13b bei Nachunternehmern:** Reinigungsleistungen von Subunternehmern an uns (selbst Gebäudereiniger) → wir
  schulden die Umsatzsteuer. Eingangsrechnungen dafür ohne USt erfassen (Kennzeichen „§ 13b“), Buchung über
  BU-Schlüssel – mit Steuerberater abstimmen.
- **PDF/A-3:** ZUGFeRD-Dateien (Rechnung, Storno, Schlussrechnung, Lastschrift) bestehen veraPDF PDF/A-3b
  (`npm run check:pdfa`, 04.10.2026; Gestaltung „edel“ erneut 10.10.2026, veraPDF 1.30.3) und KoSIT (XML).

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
    persönlichen Daten im Cache, Icons `assets/web/app-icon-*.png` via `scripts/app-icons.py`). Android:
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
- 2026-10-06: Runde 10 (Ahmed, 11 Punkte):
  - Rechnung: **Leistungsart je Position** (Auswahl aus Einstellungen → Leistungsarten, füllt leere „Leistung“; aus dem
    Leistungskatalog/Monatslauf automatisch übernommen; `invoice_lines.service_type_id`, Storno/Korrektur übernehmen sie).
    Beschreibung je Position mehrzeilig (Textfeld, wächst mit; Zeilenumbrüche in PDF und E-Rechnung).
  - Design: Seitenleiste in Bordeaux (Verlauf #821538 → #6c1130) statt Schwarz, helles Logo `assets/web/logo-hell.png`
    (aus dem Original erzeugt: `node scripts/logo-light.mjs`), aktive Filter/Pillen/Seitenzahlen Bordeaux statt Schwarz.
  - Startseite neu: Begrüßung mit Datum, Schnellknöpfe, 4 Kennzahlen (Offene Posten + Verzug, Umsatz netto des Monats vs.
    Vormonat bis heute, Rechnungsentwürfe, nicht versendet), kurze Listen (Aufgaben direkt abhakbar, Termine/Wiedervorlagen,
    Entwürfe + Monatslauf, Offene Posten nach Verzug, Hinweise, Geburtstage) mit „+ x weitere“ (vorher bis 50.000 px lang).
  - Mitarbeiter: Beschäftigungsart ohne Vorauswahl = Pflicht, Wochenstunden Pflicht bei Teilzeit/Minijob, **Vergütung Pflicht**:
    Tariflohn (Lohngruppe) / individueller Stundenlohn / Festgehalt (brutto/Monat; Stundensatz für Nachkalkulation und
    Mindestlohn-Prüfung = Gehalt × 3 ÷ 13 ÷ Wochenstunden, Wochenstunden dann Pflicht). Liste markiert „Vergütung fehlt“.
    Tariflöhne (bisher „Lohnstufen“) unter Einstellungen pflegbar; angelegt: Tariflohn 1 = 15,00 €, Tariflohn 4 = 16,66 €,
    Tariflohn 6 Glasreiniger = 18,40 € (Ahmed). Bestand: individueller Lohn → „individuell“, Lohnstufe → „Tarif“.
  - Einsatz vom Mitarbeiter/Objekt aus planen → Schließen/Speichern/Beenden führt dorthin zurück (`zurueck=`, nur eigene Pfade).
  - **Automatische Pause (§ 4 ArbZG):** Ausstempeln ohne Änderung → 30 Min. ab 6 Std., 45 Min. ab 9 Std., Beginn nach 4 Std.
    (`break_start_at`, `break_auto`); in der App „Pause ändern“ (ab/Dauer) → wird genau so übernommen. „Soll als Ist“ nimmt
    mindestens die gesetzliche Pause. Erinnerung als Browser-Benachrichtigung 5 Min. vor Pausenbeginn, solange die App offen
    ist. **Offen:** echte Push-Nachricht bei geschlossener App braucht Firebase/APNs (Konten fehlen noch).
  - **Urlaub/Krank auf Einsätze:** genehmigte Abwesenheit → Stunden je geplantem Einsatz (`absence_hours`, halber Tag = Hälfte,
    ohne Plan Wochenstunden ÷ 5); Urlaub/Krank/Sonstiges bezahlt, unbezahlt frei und Kind krank unbezahlt (Kinderkrankengeld
    § 45 SGB V – bei Fortzahlung nach § 616 BGB je Tag auf „bezahlt“ stellen). Büro: „Stunden je Einsatz“ ändern, Tag ergänzen;
    Storno entfernt die Stunden.
  - **Stundenzettel** (Personal → Stundenzettel, Mitarbeiter-Reiter „Stundenzettel“): je Tag Objekt, Soll von–bis, Beginn, Ende,
    Pause von–bis, Arbeitszeit, Abwesenheit; Summen Soll/gearbeitet/Pausen/Urlaub/Krank/unbezahlt/bezahlt/Differenz; Druck
    (A4 quer, einzeln oder alle) mit Unterschriftsfeldern und § 17 MiLoG-Hinweis. Mitarbeitende unterschreiben ab dem letzten
    Monatstag in der App (Häkchen + Finger-Unterschrift; nicht bei laufender Stempelung/offenem Nachtrag). Unterschrift (PNG
    write-once) + Prüfsumme + Inhalt werden festgehalten (`timesheet_signatures`, nur anhängen); spätere Änderung → „geändert,
    neu unterschreiben“. Rechtlich: Unterschrift ist nach § 17 MiLoG nicht vorgeschrieben, dient als Nachweis.
  - Tests: 328 Unit-/DB-Tests (neu `runde10.db.test.ts`), 25 Browser-Suiten grün (neu `npm run e2e:runde10`, 21 Prüfungen).
- 2026-10-06: Runde 11 (Ahmed):
  - Startseite: Kennzahl-Kacheln entfernt, Offene Posten wieder vollständig als Tabelle (alle Kunden, Verzug, Summe), dazu
    „Noch nicht versendet“ (Rechnungen, Storno/Korrektur, Mahnungen).
  - **Lohnarten** (Personal → Lohnarten, `/zeiterfassung/lohnarten`, CSV-Export für das Lohnprogramm, Format vorläufig):
    je Mitarbeiter/Monat Normalstunden, Urlaub, Krank, sonstige bezahlte Abwesenheit, unbezahlt (Info) und Zuschlagsstunden
    mit Betrag. Zuschläge nach **RTV Gebäudereinigung vom 31.10.2019 § 10** (allgemeinverbindlich): Nacht 22–6 Uhr 25 %,
    Sonntag und Feiertag 80 % (Ahmed 06.10.), regelmäßig am selben Arbeitsplatz 75 % (Häkchen),
    Neujahr/Ostersonntag/Pfingstsonntag/1. Mai/25.+26.12. 200 %; je Minute nur der höchste; Pause zählt nicht; Berliner
    Ortszeit inkl. Zeitumstellung; Beträge cent-genau. Sätze, Nachtzeit und Lohnart-Nummern unter Einstellungen → Zuschläge &
    Lohnarten. **Hinweis:** steuerfrei nach § 3b EStG nur bis 25 %/50 %/125 %/150 % und 50 € Grundlohn/Std. – Rest macht das
    Lohnprogramm. Mehrarbeits- und Nacht-über-Regelarbeitszeit-Zuschläge (25 %/100 %) noch nicht automatisch.
  - Urlaub ohne ausreichenden Anspruch wird abgelehnt (beim Antrag am Handy, bei Büro-Erfassung und beim Genehmigen; Rest =
    Anspruch + Übertrag − genommen − beantragt, je Jahr).
  - Handy-App neu im Stil der Fortytools-App, in Bordeaux: heller Bordeaux-Verlauf, Logo ohne weißen Kasten
    (`assets/web/logo-transparent.png`), große Begrüßung, runde Schnellknöpfe (QR, Nachtragen, Urlaub/Krank, Dokumente),
    „Heute“ mit Einsätze erledigt / gearbeitet / Pause + Fortschrittsbalken, Einsatz-Karten, Stempel-Knopf unten rechts,
    Navigation unten (Übersicht, Kalender, Zeiten, Urlaub). Neu: Kalender (`/m/kalender`, 2 Monate, Punkte an Einsatztagen,
    Monatswerte, Tag antippen). „Arbeit beenden“ dunkles Bordeaux statt Schwarz.
  - Tests: 336 Unit-/DB-Tests (neu `surcharges.test.ts`, `runde11.db.test.ts`), alle 25 Browser-Suiten grün (`e2e:runde10` 25).
- 2026-10-06: Runde 12 (Ahmed, Vergleich mit Fortytools am Handy): Büro-Oberfläche auf Handy/Tablet größer (Schrift 16 px,
  Titel 28–30 px, größere Knöpfe/Felder), Reiter brechen um statt seitlich zu scrollen, „Neu anlegen“ bricht um.
  Mitarbeiter-Übersicht oben „Aktuelle Einsätze“ (Objekt, Tage/Zeit, Einsatzbeginn/-ende, + Einsatz planen) wie Fortytools.
  Zuschläge Sonntag/Feiertag 80 %, hohe Feiertage 200 % (Ahmed; RTV sieht 100 %/150 % vor – Tarifbindung prüfen).
  Handy-App: Zeit bestätigen („so gearbeitet“) direkt in der Einsatz-Karte – heute nach Schichtende, frühere Tage (7 Tage)
  oben unter „Noch zu bestätigen“, auch im Kalender beim gewählten Tag. **Offen:** Qualitätsmanagement/Audit wie Fortytools –
  Ahmed schickt die Bilder Schritt für Schritt.
- 2026-10-06: QM-App Schritt 1 (Ahmed, Fortytools-Audit-App, weitere Bilder folgen): Handy-Ansicht `/qm` für Büro und
  Objektleitung (nur eigene Objekte) im Bordeaux-Stil der Mitarbeiter-App: Übersicht (Begrüßung, Kalender/Suche/Tickets/Alle
  Audits, heutige Audits mit Räumen und Ergebnis %, „+“ → „Was möchten Sie als nächstes erledigen?“ Audit starten / Ticket
  erstellen), Einsatzorte nach Kunde aufklappbar mit Suche, Objekt-Details (Raumbuch (n), Tickets (n), vergangene Audits:
  Datum, „x von y Räumen“, %). Audit = bestehende Qualitätskontrolle (Bewertung vorerst über /qualitaet/…). Neu: Tickets je
  Objekt (`site_tickets`, Nummer T-JJJJ-NNNN, Raum optional, Priorität, offen → in Arbeit → erledigt, feste ID). Menü
  Disposition → „QM-App (Audit, Handy)“. **Als Nächstes:** Audit-Ablauf (Raum für Raum), Fotos, Lernportal – nach Ahmeds
  Bildern.
- 2026-10-06: QM-App Schritt 2 + Zuschläge (Ahmed): Nachtzuschlag 30 %, regelmäßige Sonn-/Feiertagsarbeit 80 % (RTV: 25 %/75 %).
  Einstellungen → **Qualitätsmanagement** (am PC): Kontrollgegenstände (Skala Schulnote 1–6 oder Ja/Nein, Reihenfolge, aktiv,
  neue anlegen) und Matrix „was wird je Nutzungsart geprüft“ (Nutzungsart = Raumart des Raumbuchs; vorbelegt: Grund-
  gegenstände für alle, dazu Büro/Klassenzimmer, Sanitär, Flur, Küche). Raumbuch weiter am PC je Objekt. Audit am Handy wie
  Fortytools: „Audit starten“ → Raumliste mit Suche (Etage | Nr. | Belag | m², Ergebnis je Raum) → Raum: je Gegenstand
  Skala (links 6 … rechts 1) bzw. Ja/Nein, „Überspringen“, Begründung, bis 5 Fotos (write-once, an der Kontrolle), oben
  Gesamtnote live, „+ Ticket“ mit Raum vorbelegt; „Speichern & nächster Raum“. Ergebnis = Ø der Räume (Note 1 = 100 %,
  6 = 0 %; Ja 100 %, Nein 0 %), Raum ≥ 75 % = i. O., sonst Mangel mit den schwachen Gegenständen (→ Bericht/Abschluss wie
  bisher, Nachbesserungsaufgaben). Bewertungen nach Abschluss unveränderbar (Trigger). Tabellen `qm_items`,
  `room_type_qm_items`, `quality_check_ratings`.
- 2026-10-06: Runde 13 – Mitarbeiter wie Fortytools (Ahmed, 12 Punkte):
  - Beschäftigungsart wird automatisch als erster Tag gesetzt (Minijob/Teilzeit/Vollzeit …); Tags und Sprachen als
    Schaltflächen-Chips (Enter/Komma fügt hinzu, × entfernt; Sprachen nur aus der Liste). App-Sprache folgt der ersten
    Sprache mit App-Übersetzung (`src/domain/hr/lists.ts`, 23 Sprachen).
  - Stammdaten bearbeiten als eigene Seite (Knopf „Bearbeiten“ in der Übersicht), nicht mehr als Reiter.
  - Häkchen „regelmäßige Sonn-/Feiertagsarbeit“ entfernt: Zuschläge gelten automatisch für alle laut Lohnarten-
    Einstellungen (Sonntag/Feiertag 80 %, hohe Feiertage 200 %, Nacht 30 %). **Tarifhinweis bleibt: RTV sieht 100 %/150 %
    vor – bei Tarifbindung/Allgemeinverbindlichkeit Unterschreitung nicht zulässig, mit Steuerberater/Anwalt klären.**
  - Austritt (Datum + Grund, Hinweis Schriftform § 623 BGB) und Wiedereintritt; Beschäftigungszeiten append-only
    (`employee_employments`), Personalnummer bleibt.
  - Dokumente: Checkliste Personalakte – Arbeitsvertrag Pflicht, Unterweisung/Arbeitskleidung/Schlüssel optional
    (Kleidung/Schlüssel zählen auch über unterschriebene Übergaben). Neue Kategorien inkl. Aufenthalts-/Arbeitserlaubnis.
  - Aufenthaltstitel und Arbeitserlaubnis getrennt (gültig bis + Info), Warnhinweis § 4a AufenthG / § 404 SGB III
    (Bußgeld bis 500.000 €); Startseite warnt für beide 60 Tage vorher.
  - Krankenkasse als Auswahl (gesetzliche Kassen + PKV + Sonstige). Einsatzgruppe aus dem Formular entfernt (Feld bleibt).
  - Hintergrund am PC wie die App: dezenter Bordeaux-Verlauf (nicht vollflächig), Karten weiß.
  - iOS: keine installierbare Datei ohne Mac/Xcode + Apple-Developer-Konto (99 €/Jahr, TestFlight). Bis dahin `/m` per
    Safari → Teilen → „Zum Home-Bildschirm“.
  - Tests: 339 Unit-/DB-Tests, alle Browser-Suiten grün.
- 2026-10-06: Runde 14 (Ahmed, Fortytools-Screenshots QM-Einstellungen):
  - Behoben: Zahnrad-/Benutzermenü am Handy zeigte keinen Text (weiße Schrift auf weißem Grund) und lag quer – jetzt
    dunkle Schrift, untereinander, volle Breite.
  - Einstellungen → **Kontrollgegenstände** und **Nutzungsarten** wie Fortytools (eigene Seiten mit Reitern, ersetzen die
    Matrix `/einstellungen/qualitaet` und die Raumarten-Liste, alte Adressen leiten um): Liste Name/Bewertungsmodus bzw.
    Name/Anzahl Kontrollgegenstände/Räume/Objekte mit Bearbeiten/Löschen, Formular „… anlegen“ darunter; Nutzungsart mit
    Liste von Kontrollgegenständen („Kontrollgegenstand hinzufügen“, mindestens einer). Löschen nur, wenn nicht verwendet
    (Gegenstand in Audits bzw. Nutzungsart im Raumbuch) – sonst deaktivieren; Bewertungsmodus nach erster Bewertung fest.
  - Bewertungsmodi: Note 1 bis 6, **Gut/Mittel/Schlecht** (100/50/0 %), Ja/Nein, **Punkte 1 bis 5** (5 = 100 %,
    Gesamteindruck wie Fortytools). Je Bewertung wird der Prozentwert gespeichert (`quality_check_ratings.percent`).
  - Tests: 340 Unit-/DB-Tests, `e2e:runde10` 37 Prüfungen.
- 2026-10-06: Runde 15 (Ahmed, 8 Punkte; Punkt 9 kam leer an):
  - Mitarbeiter-Übersicht fürs Handy neu geordnet: Kopfkarte (Name, Personalnr., Beschäftigung, Status, „Stammdaten
    bearbeiten“), dann Aktuelle Einsätze (am Handy als Karten), Stammdaten, Objekte, Dispo (Monate kurz), Beschäftigungs-
    zeiten unten. Hilfsklassen `.stack-m` (Tabelle → Karten am Handy), `.hide-m`/`.only-m`.
  - Helle Bordeaux-Flächen an einzelnen Stellen wie das Hellblau bei Fortytools: Formularfuß, Tabellenköpfe, Leer-Hinweise.
  - Übergaben: Empfänger „eigener Mitarbeiter“ oder „Nachunternehmer“ – bei Nachunternehmer Person aus dessen
    Ansprechpartnern (oder „andere Person …“). „Übergeben durch“ entfällt (= angemeldeter Benutzer). Gegenstand bei
    „Sonstiges“ als Auswahl (Einstellungen → Gegenstände für Übergaben, plus Fahrzeuge; „anderer Gegenstand …“ blendet
    ein Feld ein), Kleidergröße als Auswahl je Artikel. **Schlüssel nicht mehr über Übergaben** (Schlüsselbuch bzw.
    Objekt → Schlüssel); alte Schlüssel-Übergaben bleiben lesbar.
  - Arbeitskleidung (Bestand, Artikel, Größen) liegt unter Einstellungen, nicht mehr im Inventar-Menü.
  - Inventar → **Fahrzeuge**: Kennzeichen, Marke, Modell, FIN (17 Zeichen, ohne I/O/Q geprüft), Erstzulassung,
    Kraftstoff, Eigentum/Leasing/Miete mit Geber und Ende, Versicherung, nächste HU (Monat) und Inspektion (Warnung
    30 Tage, überfällig rot), Kilometerstand, Fahrer/in, Tankkarte; Fahrzeugschein und weitere Unterlagen als Dateien
    (write-once). Liste mit Kennzeichen-Schild und „Fahrzeugschein fehlt“. Tabelle `app.vehicles`, `app.handover_objects`.
  - Tests: 342 Unit-/DB-Tests (neu `vehicles.db.test.ts`), `e2e:uebergabe` 25 Prüfungen.
- 2026-10-07: Runde 16 (Ahmed, 6 Punkte; Punkt 7 kam leer an):
  - **Übergaben ohne eigene Seite** (Menüpunkt weg, `/uebergaben` leitet um): anlegen beim Mitarbeiter (Reiter „Übergaben“),
    beim Nachunternehmer (Übersicht) und am Objekt (neuer Reiter „Übergaben“, auch für die Objektleitung). Je Entwurf
    „Unterschreiben lassen“ (Handy/Tablet), „PDF drucken“ und „Auf Papier unterschrieben“ (bucht und schließt ab).
    Zurück/Brotkrumen führen zum Mitarbeiter/Nachunternehmer/Objekt.
  - **Unterweisungen & Unterschriften** (Personal, Knopf „Unterweisung an alle freigeben“ in der Mitarbeiterliste): Beim
    Öffnen der Handy-App erscheint ein offenes Dokument sofort zum Lesen und Unterschreiben; „Später erinnern“ nur für heute
    (Cookie), danach wieder; nach dem Unterschreiben gleich das nächste. Überfällige Unterschriften als Hinweis auf der
    Startseite. **Echte Push-Nachricht bei geschlossener App braucht weiterhin Firebase/APNs.**
  - **Menü und Reiter entdoppelt:** Zeiterfassung, Transfer, Auswertungen, Rechnungen ohne Reiterzeile (Bereiche links im
    Menü; Rechnungen: Filter „Alle / Nicht versendet“). Kassenbuch und Urlaub behalten ihre Reiter, dafür nur ein Menüpunkt.
    Disposition: Planung, Arbeitsscheine, Qualitätskontrollen (Knopf zur QM-App), Zählerstände, Glas, Tiefgarage,
    Grundreinigung. Raus aus dem Menü: Sonderdienste (Daten bleiben), Vertretungen (über die Planung), Soll/Ist-Doppel,
    Urlaubskalender (unter Urlaub), Karten-Belege (Reiter im Kassenbuch).
  - **Urlaubskalender:** Filter Art/Suche/nur mit Abwesenheit/nur genehmigte, Tage U/K je Monat, Export **PDF** (A4 quer,
    farbig) und **CSV**. **Heute abwesend** auf der Startseite und in der Zeiterfassung (Objektleitung nur Mitarbeitende
    ihrer Objekte und ohne Art – Krankheit = Gesundheitsdaten).
  - **Stundenzettel & Lohnarten** zu einer Seite: Monat, Suche, Beschäftigungsart, Objekt, Unterschrift-Status; Ansicht
    Stunden oder Lohnarten & Zuschläge; Export PDF-Übersicht, Stundenzettel drucken/PDF, CSV-Übersicht, CSV fürs
    Lohnprogramm (alle mit Filter). `/zeiterfassung/lohnarten` leitet um. Neuer Listen-PDF-Baustein `src/pdf/table.ts`.
  - Lokale Entwicklung: nach Container-Neustart war die Dev-DB älter als das Archiv → neue DB `viva_dev16` mit eigenem
    Archiv-Ordner (`.env.dev`, nicht im Repo); nichts gelöscht.
  - Tests: 343 Unit-/DB-Tests (neu `runde16.db.test.ts`), alle 25 Browser-Suiten grün.
- 2026-10-07: Runde 17 (Ahmed): Karte „Abwesend“ (Startseite, Zeiterfassung) zeigt „Heute“ und „Nächste 7 Tage“ (Urlaub eine
  Woche vorher), jetzt auch für die Objektleitung mit Art inkl. „krank“ – nur Mitarbeitende ihrer Objekte, keine Diagnose
  (wird nie erfasst). **Sonderdienste gelöscht** (Ahmed: „ja lösch“): Modul, Seiten, Test, Demo-Daten und Tabellen
  (`special_services`, `special_service_runs`, Migration `20261107000001`); Rechnungen/Arbeitsscheine daraus bleiben,
  archivierte Aushang-PDFs bleiben write-once im Archiv. 338 Unit-/DB-Tests.
- 2026-10-07: Seite **Zählerstände entfernt** (Ahmed): Menüpunkt, Objekt-Reiter „Zähler“ und Seiten weg, alte Adressen leiten
  auf Objektliste bzw. Objekt um. Danach auf Ahmeds Ja („hatte nichts drin“) auch Tabellen `meters`/`meter_readings`
  (Migration `20261107000002`), Service-Funktionen, Test und Demo-Daten entfernt.
- 2026-10-07: Stellenplakat (Bewerber & Stellen): Knopf „Als JPG herunterladen“ (A4, 1240 × 1753 px, im Browser über
  html2canvas – lokal aus `node_modules` unter `/static/vendor/`, kein fremdes CDN). Nummer auf dem Plakat jetzt Handy
  0176 63050802 statt Festnetz (Migration `20261107000003`, Einstellungen → Firmendaten „Handy-/WhatsApp-Nummer für
  Stellenplakate“). `e2e:kasse` 63 Prüfungen.
- 2026-10-07: Runde 18 (Ahmed, 19 Punkte):
  - Bewerber/Stellen: Stunden mit Komma (32,5; Spalte numeric). Menü „Lieferanten & Nachunternehmer“ (Seitenleiste
    bricht um). Akquise-Filter mit Abstand. Angebote: Reiter „Ausschreibungen“ mit Anzahl offener. Entwürfe: „Markierte
    löschen (n)“ deutlich sichtbar (gab es schon).
  - Mitarbeiter: Beschäftigungszeiten/Austritt/Wiedereintritt als Knopf in den Stammdaten; **Austritt zurücknehmen**
    (falsch erfasst; Protokoll).
  - **Objektleitung mehreren Objekten zuordnen:** Einstellungen → Benutzer → Person: Objekte nach Kunde gruppiert, Suche,
    „alle angezeigten markieren“, je Kunde alle, „bisher: …“. Knopf „Objektleitungen zuordnen“ in der Objektliste.
  - **Objekt-Auswahl zeigt überall den Kunden** (gemeinsamer Baustein `site-options.tsx`: je Kunde gruppiert, im
    geschlossenen Feld „Objekt – Kunde“).
  - **Interner Bereich:** Kunde „Viva-Deluxe intern“ (`INTERN`, `customers.is_internal`) mit Objekt „Büro“ (`INT-BUERO`)
    = eigene Kostenstelle und Einsatzort für Büromitarbeitende (Planung, Zeiterfassung). Keine Rechnungen, nicht im
    Monatslauf. Weitere interne Bereiche (Lager …) als Objekte dieses Kunden anlegen.
  - **Handy-PIN = Geburtsdatum TTMMJJ**, solange keine eigene PIN gesetzt ist (wird beim ersten Versuch als PIN
    hinterlegt → Fehlversuche/Sperre gelten). **Risiko:** Kollegen kennen Personalnummer und Geburtstag – eigene PIN
    empfohlen (Hinweis unter Mitarbeiter → Handy-Zugang).
  - **Erfasste Zeiten entfernen:** mit Begründung; Status „abgelehnt / entfernt“, zählt nirgends mehr, bleibt mit altem
    Stand im Protokoll (§ 17 MiLoG – nicht spurlos löschen).
  - **Abwesenheiten ändern/löschen** (Büro/Personal): Art, Zeitraum, halber Tag; Stunden je Einsatz neu berechnet;
    Urlaubsanspruch geprüft; Löschen mit Protokoll (`audit_log`).
  - Stundenzettel-Druck und Listen-PDFs mit Logo.
  - **Globale Suche wie Fortytools:** Vorschau unter dem Suchfeld (je Bereich 5, „… und einige weitere“, Fundstelle
    markiert, Tastatur), Ergebnisseite gruppiert mit Anzahl; durchsucht Kunden (inkl. Adresse, Leitweg-ID, E-Mails),
    Objekte, Mitarbeiter, Kontakte, Rechnungen inkl. Positionstexte, aktive Leistungen, Angebote inkl. Positionen,
    Aufträge, Arbeitsscheine, Ausschreibungen, Lieferanten, NU-Aufträge, Bestellungen, Eingangsrechnungen, Dokumente
    (Dateinamen), Notizen, Aufgaben, Akquise, Bewerber, Fahrzeuge, Artikel. Mehrere Wörter = alle. Rechte je Rolle,
    Objektleitung nur eigene Objekte.
  - **Rechnungseingang → „Rechnung erwartet“:** je laufendem NU-Auftrag (erteilt/beendet) und abgelaufenem Zeitraum
    (monatlich bzw. Turnus, Rückblick 12 Monate) bis eine Eingangsrechnung ihn abdeckt oder „keine Rechnung“ (Grund)
    vermerkt ist. **Eine Rechnung für mehrere Aufträge/Objekte/Monate** (`incoming_invoice_subcontracts`, z. B. Glas):
    Zeilen Auftrag/Zeitraum/Betrag; Beträge (Summe = netto) verteilen die Kosten automatisch je Objekt. Bestand übernommen.
  - **Word-Vorlagen** (Einstellungen → Word-Vorlagen): Ahmeds Fortytools-Vorlagen (ZIP, 40 Dateien) hochladen; Platzhalter
    `${Mitarbeiter.*}`, `${Kunde.*}`, `${Objekt.*}`, `${Firma.*}`, `${Dokument.*}` werden ausgefüllt (auch über Word-Läufe
    zerteilt, Formatierung bleibt), leere Werte = Linie. „Aus Word-Vorlage erstellen“ bei Mitarbeiter (Dokumente), Kunde
    (Dokumente), Objekt (Dokumente) → .docx write-once in der Akte, Name `Typ_JJJJ-MM-TT_Name.docx`, Ablage-Kategorie aus
    der Anleitung (Arbeitsvertrag, Vertragsänderung, Beendigung, Nutzungsüberlassung …). Kündigung/Aufhebung/Befristung:
    nur ausdrucken und auf Papier unterschreiben (Schriftform). **Auf dem Live-Server die ZIP einmal hochladen.**
  - Tests: neu `runde18.db.test.ts`, `expected-invoices.db.test.ts`, `word-templates(.db).test.ts`.
- 2026-10-07: Runde 19 (Ahmed, 10 Punkte):
  - **Fehlende Pflichtunterlagen** (Personal → Fehlende Unterlagen, `/personal/unterlagen`): Arbeitsvertrag, Unterweisung,
    Arbeitskleidung, Schlüssel jetzt Pflicht (Kleidung/Schlüssel zählen auch über Übergaben), dazu Aufenthaltstitel/
    Arbeitserlaubnis außerhalb EU/EWR/CH (nicht abgelaufen) und fehlende Staatsangehörigkeit. Sortiert nach Objektleitung
    (wer an mehreren Objekten arbeitet, steht bei jeder), Filter Objektleitung/„fehlt“, Export CSV und PDF.
  - **Startseite selbst bauen** (Knopf „Übersicht anpassen“, `/startseite/anpassen`, je Benutzer in `app.user_prefs`):
    Karten ein-/ausblenden, Spalte, Reihenfolge, zurücksetzen. „Wiedervorlagen Akquise“ ist eine eigene Karte;
    Ausschreibungs-Termine stehen bei den Aufgaben (nicht mehr bei den Wiedervorlagen). „Abwesend“ zeigt Heute /
    Nächste 7 Tage / In 8–14 Tagen.
  - **Fortytools-XML-Import** (Transfer → Import aus Fortytools, Karte „XML-Exporte“): customers, facilities,
    staff_members, offers, invoices. Probelauf (Vorschau) → übernehmen; Abgleich mit dem CSV-Import über Fortytools-ID,
    Nummer, Name – nichts doppelt, vorhandene Felder werden nur ergänzt. Mitarbeitende: Wochenstunden, Urlaubstage,
    Sprache, Anschrift, Krankenkasse (IK). Angebote mit Positionen und Folgeangebot. Rechnungen als **Archiv
    „Rechnung (Fortytools)“** (`app.legacy_invoices`, unveränderbar, nur „bezahlt“ setzbar) beim Kunden, Objekt, in der
    Suche und in den Offenen Posten. Monatspauschalen für Objekte ohne Leistung aus der letzten vollen Monatsrechnung
    (gültig ab Folgemonat). Probelauf mit den echten Exporten (Wegwerf-DB): 181 Kunden, 376 Objekte, 266 Mitarbeitende
    (3 ohne Eintritt übersprungen), 408 Angebote, 3.200 Rechnungen, 171 Monatspauschalen, ~4 s; zweiter Lauf ändert nichts.
    **Nummernkreise werden angehoben (nie gesenkt): Rechnung ab 1038308 (höchste Fortytools-Nr. 1038307), Angebot ab 3897.
    Nach dem Umstieg in Fortytools keine Rechnungen mehr schreiben – sonst doppelte Nummern.** Angebotsstatus aus
    Fortytools ist abgeleitet (1 angenommen, 2 abgelehnt, 3 zurückgezogen, 4 versendet, 5 Entwurf) – **Ahmed bestätigen**.
    Dokumente/Anhänge sind nicht im XML-Export.
  - **Stundenzettel je Person** filterbar: Häkchen je Person → „Auswahl drucken“ (je Person ein Blatt), Objekt-Filter mit
    „nur Zeiten dieses Objekts“ = Auszug je Objekt (ohne Unterschrift, z. B. Nachweis für den Kunden); beim Mitarbeiter
    Auswahl „nur <Objekt>“. Lohnprogramm-CSV rechnet weiter mit allen Zeiten.
  - **Personalakte mit Archiv:** je Datei „ins Archiv“ / „zurückholen“, je Kategorie „ältere ins Archiv“ (neueste bleibt
    vorne), Archiv aufklappbar je Kategorie. Datei bleibt write-once, nur die Verknüpfung wird gekennzeichnet
    (`file_links.archived_at/by`, Protokoll). Pflichtunterlagen zählen nur aktuelle Dateien.
  - **Wochenstunden mit Verlauf** (`app.employee_hours`, nur anhängen): im Formular „Stunden gültig ab“ (leer = heute),
    Verlauf in den Stammdaten („geplant“ für Zukunft). Zukünftige Werte übernimmt der Server am Stichtag (Start + stündlich).
    Soll (Dispo, Kalender) rechnet je Abschnitt.
  - **Word-Vorlagen:** „Aus Word-Vorlage erstellen“ → Seite „Angaben prüfen“ mit allen Platzhaltern der Vorlage,
    vorbelegt, Datumsfelder als Datumsauswahl (Dokument.Datum/Unterschriftsdatum/Frist, Vertrag.Datum/Beginn/Ende …,
    Neu.Wochenstunden/Stundenlohn …), Stammdaten eingeklappt. Eigene Seite **Personal → Vorlagen (Word)** (`/vorlagen`):
    Person/Kunde/Objekt wählen → Vorlage ausfüllen, „zuletzt erstellt“. Beträge ohne „€“ (Vorlagen schreiben EUR dahinter).
    **Fund: Fast alle Vorlagen hatten Word-Datumsfelder (DATE) – die zeigen beim Öffnen immer das heutige Datum.** Beim
    Erzeugen werden sie jetzt auf das Dokumentdatum festgeschrieben. Ahmeds Vorlagen korrigiert (V3: Leerstellen →
    Platzhalter, „München, den ${Mitarbeiter.Eintrittsdatum}“ → Unterschriftsdatum, Stundenlohn statt Gehalt im
    Arbeitsvertrag, Vorarbeiter-ZV ohne festes 01.09.2026/16,66 €/Lohngruppe 4). Neue Fassung (gleicher Code, höhere
    „-Vn“) deaktiviert die alte beim Hochladen. **Ahmed: korrigierte ZIP unter Einstellungen → Word-Vorlagen hochladen.**
  - Tests: 355 Unit-/DB-Tests (neu `runde19.db.test.ts`, erweitert `word-templates.db.test.ts`).
- 2026-10-07: Runde 20 (Ahmed):
  - **Einsatz löschen** (Einsatzliste beim Mitarbeiter/Objekt: Knopf „Löschen“; Terminserie: Kasten „Serie löschen“):
    entfernt den Einsatz ganz (Tagesausnahmen mit, Abwesenheitsstunden verlieren nur die Verknüpfung, alter Stand im
    Protokoll). Nur solange keine Zeit dazu erfasst ist (verknüpft oder gleicher Mitarbeiter/Objekt/Wochentag im
    Gültigkeitszeitraum) – sonst Hinweis „beenden“ (§ 17 MiLoG, Soll/Ist-Nachweis bleibt).
  - **Tiefgaragen aus Fortytools:** 117 Objekte „TG …“/„Tiefgarage …“ (Dawonia 65, Münchner Wohnen 44, Zeus Property
    Management 8) werden beim XML-Import zusätzlich in Disposition → Tiefgaragenreinigung angelegt (verknüpft mit dem
    Objekt = Kostenstelle, Objektnummer, Adresse; nichts doppelt). Kunde „Zeus Property Management“ als dritter Filter.
    **In Fortytools fehlen m², WE-Nr., Stellplätze, Dauer, TOB** – in der alten App waren keine TG-Daten im Backup →
    Ahmed: Liste (Excel) mit diesen Angaben schicken oder in der App je Objekt nachtragen.
  - Tests: 357 Unit-/DB-Tests (neu `runde20.db.test.ts`).
- 2026-10-07: Fortytools-Rechnungen (Import) erscheinen jetzt auch unter Rechnungen → **Alle Rechnungen** (Schild
  „Fortytools“, Link zur Archiv-Ansicht, „PDF in Fortytools“), nach Leistungszeitraum oder Rechnungsdatum, Jahre aus beiden
  Quellen, Suche; Zähler „Alle Rechnungen (n + m aus Fortytools)“. ZIP nur für eigene Belege. Vorher nur bei Kunde/Objekt/
  Offenen Posten sichtbar (Ahmed: „trotz Import keine Rechnungen“).
- 2026-10-07: Fortytools-Rechnungen in „Alle Rechnungen“ (Jahr, Suche, Zähler „n + m aus Fortytools“, Link aufs Archiv).
  **Fund Dubletten (Ahmed: Baubüro doppelt, Beträge falsch):** Wurde erst der XML-, dann der CSV-Import eingespielt, legte
  der CSV-Import jedes Objekt und viele Kunden ein zweites Mal an (Abgleich nur über Fortytools-ID/Nummer) – Leistungen
  doppelt, Monatssumme in der Probe 596 T€ statt 337 T€. Behoben: CSV-Import gleicht Kunden über Name/Kurzname und Objekte
  über Kunde + Name (+ Straße) ab und schaltet die aus Rechnungen abgeleiteten Monatspauschalen ab, sobald echte Leistungen
  da sind. Außerdem: XML-Import in eine leere DB scheiterte an doppelten Kundennummern (neue Nummern kollidierten mit
  späteren aus der Datei). **Bestandsdaten bereinigen:** Transfer → Import aus Fortytools → „Doppelte Kunden/Objekte
  prüfen“ (nur Admin): Vorschau, dann „Jetzt zusammenführen“ – behält den XML-Datensatz, hängt alles um, löscht die
  Dublette (sonst deaktiviert „(Dublette)“), Protokoll `merge_duplicates`. Probe: 445 Dubletten → 193 Kunden, 397 Objekte,
  341.776 € monatlich. **Rest:** Fortytools hat selbst gleichnamige Objekte beim selben Kunden (z. B. 20017 „Treppenhaus“
  3×) – Leistungen dort nicht eindeutig zuzuordnen, Kontrollliste auf derselben Seite, Ahmed prüft von Hand.
  Tests: 358 Unit-/DB-Tests (neu `import-duplicates.db.test.ts`).
- 2026-10-07: Runde 21 (Ahmed: Statistik wie Fortytools, Beträge falsch, Baubüro/Treppenhaus doppelt, Rechnungen als PDF,
  Offene Posten leer, Logo):
  - **Fund 1 (XML-Import):** Fortytools-Objekte wurden über Nummer oder Namen zugeordnet – bei gleichnamigen Objekten eines
    Kunden („Treppenhaus“ Stollbergstr./Baaderstr./Arcisstr.) landeten alle auf demselben Objekt, ebenso deren
    Rechnungspositionen. Jetzt: jedes Objekt höchstens einmal, Name UND Straße müssen passen, Fortytools-ID zählt nur bei
    passender Straße; falsche Zuordnung wird gelöst, Nummern/Namen werden korrigiert. Erneuter XML-Import ordnet auch die
    bereits importierten Rechnungspositionen neu zu (Spalte `legacy_invoice_lines.facility_ref`, nur Zuordnung änderbar –
    Migration `20261110000001`). **Fund 2 (Zusammenführen):** gleichnamige Objekte mit anderer Straße wurden zusammengelegt
    → nur noch bei gleicher Adresse.
  - **Transfer → Import aus Fortytools → „Abgleich mit Fortytools-Rechnungen“** (nur Admin): je Objekt monatliche Leistungen
    der App gegen die letzte volle Monatsrechnung aus Fortytools (stimmt / abweichend / fehlt / nur App / zuletzt älter),
    Positionen zum Aufklappen; „übernehmen“ beendet die monatlichen Leistungen zum Ende dieses Monats und legt die
    Fortytools-Positionen ab dem Folgemonat an (feste IDs, Protokoll). Probe mit den echten Exporten: 13 abweichend → danach
    103 stimmen, 8 nur App, 15 zuletzt älter (prüfen, ob beendet).
  - **Auswertungen → Statistiken** wie Fortytools: Zeitraum, Kunde, Monat/Quartal/Jahr, Leistungszeitraum/Rechnungsdatum,
    Säulen + Tabelle, Umsatz pro Kunde und nach Leistungsart (Anteil), CSV. Eigene + Fortytools-Rechnungen ohne Unterschied.
    Leistungszeitraum: Position tageweise auf die Monate verteilt, je Monat auf Cent gerundet; Kunden/Leistungsarten nach
    Rechnungsdatum – **am echten Export geprüft: alle Monate 11/2025–10/2026 und Summe 3.965.480,18 € centgenau wie
    Fortytools.** „Netto-Umsatz je Monat“ entfällt (leitet um), Kundenübersicht-Umsatz rechnet genauso.
  - Fortytools-Rechnungen: „Alle Rechnungen (n)“ ohne Zusatz, Art Rechnung/Storno-Korrektur, **PDF** auf unserem Briefpapier
    aus den Rechnungsdaten, gekennzeichnet „Kopie – Original in Fortytools“ (**nicht erneut als Rechnung versenden – § 14c UStG**).
    Offene Fortytools-Rechnungen zählen in den Offenen Posten der Startseite und beim Kunden.
  - Übersicht: Firmenlogo oben wie Fortytools.
  - Tests: 359 Unit-/DB-Tests (neu `runde21.db.test.ts`).
  - **Auf dem Server:** 1) XML-Exporte noch einmal importieren (repariert Objekte + Zuordnung der Rechnungen), 2) Abgleich
    öffnen, abweichende prüfen und übernehmen, 3) Liste „gleicher Objektname“ unter Dubletten kontrollieren.
- 2026-10-07: Runde 22 (Ahmed: Offene Posten wie Fortytools, Beträge, Rechnungs-Statistik, Kopie-Text, „pauschal“ im PDF,
  Mahnwesen leer, Einsätze übernehmen?):
  - **Offene Posten (Startseite) wie Fortytools:** Spalten Tage (bis zur nächsten Fälligkeit, negativ = überfällig) /
    Offen / Überfällig / Summe mit Summen-Schildern grün/rot/gelb, alphabetisch, Karte standardmäßig breit links.
    Fortytools-Rechnungen: Storno/Korrektur wird über die Fortytools-Gruppe (`open-items-root-id` → `ft_root_id`) mit der
    Rechnung verrechnet; Korrektur zu einer bezahlten Rechnung ist kein offener Posten (Kochel −351,81). View
    `app.legacy_open_items`. Mit dem Export: 25 Kunden; Abweichung zum Fortytools-Bildschirm nur bei 3 Kunden (ARGE
    121,20, Münchner Wohnen 140,97, MW Immobilien 4 687,04 €) = **Teilzahlungen, die nicht im XML-Export stehen** →
    neu: Zahlung je Fortytools-Rechnung mit Betrag (weniger als offen = Teilzahlung, `paid_part_cents`). Erneuter
    XML-Import übernimmt „in Fortytools inzwischen bezahlt“ (nie zurück).
  - **Mahnwesen** enthält überfällige Fortytools-Rechnungen (Vorschläge, Stapel, Mahnung/PDF; `dunning_items` ohne FK,
    Prüf-Trigger auf eine der beiden Tabellen). **Achtung:** Mahnstufen aus Fortytools sind nicht im Export – bereits dort
    gemahnte Rechnungen beginnen hier wieder bei der Zahlungserinnerung.
  - Rechnungs-Statistik zählt Fortytools-Rechnungen mit; Rechnungen-Menü: „Statistiken“ und „Rechnungs-Statistik“.
  - PDF Fortytools-Rechnung ohne „Kopie“-Vermerk (Ahmed). **Risiko § 14c UStG bleibt: nicht als Rechnung erneut versenden.**
  - PDF-Einheit: „pauschal“ überlappte lange Einzelpreise → „psch.“; Einheit wird generell nie mehr in den Preis
    geschrieben (kürzen/verkleinern). Doppelte Anrede bei übernommenen Fortytools-Texten entfernt.
  - **Fund:** XML-Import hat Entitäten nicht aufgelöst („Rußbach GmbH &amp; Co.KG“) → behoben, Bestand per Migration
    `20261110000003` korrigiert.
  - Einsätze/Planung: **nicht im Fortytools-XML-Export** (staff_members/facilities enthalten keine Planungen).
  - Tests: 360 Unit-/DB-Tests (neu `runde22.db.test.ts`).
- 2026-10-07: Runde 23, Teil A (Ahmed, 30 Punkte – schnelle Punkte zuerst):
  - Begrüßung „Guten Morgen/Tag/Abend“ war immer „Abend“ (Stunde wurde als „18 Uhr“ gelesen → NaN) – jetzt `hourBerlin()`
    (Büro, Handy-App, QM-App), Test.
  - Kundenliste zeigt standardmäßig nur aktive Kunden („alle“ wählbar). Logo auf der Übersicht als Karte wie Fortytools.
  - Objektleitung überall mit Telefon und E-Mail (View `app.manager_contacts`: Profil, sonst Mitarbeiter gleichen Namens).
  - Objekt-Auswahl (Einsatz planen u. a.) zeigt zusätzlich Straße + Ort (gleichnamige Objekte unterscheidbar).
  - Alle Tabellen per Klick auf den Spaltenkopf auf-/absteigend sortierbar (gemerkt je Tab); Exporte der Stundenliste
    übernehmen die Sortierung; Spalte Pers.-Nr.
  - Menü: „Aufträge“ entfernt (Daten bleiben), Prüfbericht Zoll gelöscht (alte Adressen → Stundenliste), Qualitäts-
    kontrollen nur noch am Objekt/QM-App, Auswertungen ohne Doppel (Übersicht, Stundenkontrolle Soll/Ist raus),
    Vorlagen (Word) unter Einstellungen, Urlaub & Abwesenheiten unter Disposition (mit Personalnummer).
  - Zeiterfassung: „Zeiterfassung heute“ und „Nachträge freigeben“ als Seiten entfallen – eine Seite „Zeiterfassung“ mit
    „Ein Tag“ / „Zeitraum“, Schnellwahl Heute/Gestern/7 Tage/Monat, Nachträge aufklappbar direkt darin.
  - Übersicht erinnert an fehlende Pflichtunterlagen (Link). Datei-Upload-Felder als ruhige Ablagefläche gestaltet.
  - Tests: 361 Unit-/DB-Tests, Browser-Suiten grün.
  - Neu nachgeschoben (Ahmed): Leistungsbeschreibung mehrzeilig; Objektleiter-/Büro-App umfangreicher (Schlüssel,
    Unterweisungen, Personalbogen mehrsprachig, Objektordner, Einsätze, Zeiten, NU-Auftrag mit Freigabe im Büro);
    nur noch „Statistiken“ unter Auswertungen mit farbigen Diagrammen.
- 2026-10-07: Runde 23, Teil C:
  - **Eine Statistik** (Auswertungen → Statistiken; Rechnungs-Statistik aufgegangen, alte Adresse leitet um, nicht mehr
    unter Rechnungen): Kennzahlen-Kacheln in Farbe (Umsatz mit Vorjahresvergleich, Rechnungen/Storno/Kunden,
    Ø Rechnungsbetrag, Ø Zahlungsdauer, offen/überfällig), Säulen Zeitraum vs. Vorjahr mit Werten, Tabelle mit
    Veränderung %, Ringdiagramme + farbige Balken je Kunde und Leistungsart, Schnellwahl 12 Monate / Jahr / Vorjahr.
  - Mahnwesen mit den echten Fortytools-Exporten geprüft (Wegwerf-DB): 9 Mahnvorschläge, 41 überfällige Rechnungen –
    auf dem Server nach dem Update XML-Exporte erneut einspielen, dann erscheinen sie.
  - „Stundenzettel“ heißt jetzt **Stundenliste** (Büro, Druck, PDF, Handy-App). Getrennt: Ansicht „Stundenliste
    (Ablage, Zoll)“ – Soll/Gearbeitet/Pausen/Differenz/Unterschrift, Einzelblätter je Person – und „Lohnarten
    (Lohnabrechnung)“ – Normalstunden, Urlaub, Krank, sonstige bezahlt, unbezahlt, Zuschläge; je eigenes PDF/CSV.
    Druck kräftiger (dunkle Linien, Zebra, Farben werden mitgedruckt), Logo größer.
  - Logo auf allen Druckansichten: jede App-Seite beim Drucken (Kopf mit Logo), Tiefgarage-, Grundreinigungs-,
    Glas-Jahresplaner-Druck, Stellenplakat, QR-Aushänge.
  - Voller Name statt Benutzername (Begrüßung, Kopfzeile, QM-App; gespeicherte Namen = Benutzername werden umgestellt).
  - Leistungsbeschreibung am Objekt mehrzeilig (Zeilenumbrüche gehen auf die Rechnung).
- 2026-10-07: Runde 23, Teil F – Importe:
  - Transfer → Import aus Fortytools → Karte **„Artikel und erfasste Zeiten (CSV)“** (`fortytools-more-import.ts`):
    Artikel (items.csv) mit EK/VK cent-genau, Beschreibung; negativer Fortytools-Bestand → 0 mit Hinweis „Inventur“
    (Bestand bei uns nie negativ), Bestand nur beim ersten Import als Buchung „Übernahme aus Fortytools“. Artikel haben
    jetzt Verkaufspreis + Beschreibung (für „+ Artikel“ in Rechnungen).
  - Zeiten (Zeiten.csv): je Zeile freigegebene Zeit (Quelle Büro, „aus Fortytools“ + Servicebericht-Link), Mitarbeiter über
    Personalnummer, Objekt über Kundennummer + Objektname; Buchungen nur auf Kundenebene → Objekt „Allgemein (aus
    Fortytools)“ (wird angelegt). Personalnummern ausschließbar (Vorgabe **1013 – Ahmed: Dilmans Zeiten nicht übernehmen**).
    Überschneidungen werden übersprungen, über Mitternacht korrekt. Daraus **wöchentliche Einsätze** (Mitarbeiter +
    Objekt + Wochentag + Beginn mindestens 2× im Export, Dauer/Pause = Median), gültig ab dem Tag nach der letzten Zeit.
    Probelauf echte Daten (Wegwerf-DB): 2.459 Zeiten (21 von 1013 ausgeschlossen, 4 mit 0 Minuten), 660 Einsätze,
    63 Artikel; zweiter Lauf legt nichts doppelt an.
  - **Nachunternehmer-Aufträge aus der alten App** werden jetzt als echte Aufträge angelegt (Import aus der alten App →
    Nachunternehmer): Objekt über Kostenstelle (auch 8-stellig 20200001 → 2020001), Objektnummer im Text, Adresse/Name,
    sonst „Allgemein (aus Fortytools)“ des Kunden; Turnus/Abrechnung/Status übernommen (Stundensatz aus „x 25,00 €“),
    alte Nummer bleibt. Probelauf: 122 von 122 Aufträgen (13 auf „Allgemein“). **Auf dem Server: Backup erneut einspielen
    (Bereich Nachunternehmer) – vorhandene Firmen/Nachweise bleiben, nur die Aufträge kommen dazu.**
- 2026-10-07: Runde 23, Teil D – Offene Posten wie Fortytools: Seite enthält jetzt auch die offenen **Fortytools-
  Rechnungen** (Schild „Fortytools“, Korrekturen derselben Gruppe im Haben). Je Rechnung Betrag eintragen („voll“ füllt
  den offenen Betrag) und wählen „Rest bleibt offen“ (Teilzahlung) oder „Rest als Skonto“; Zahlungsdatum und
  Verwendungszweck oben; „Zahlungen buchen“ bucht alle ausgefüllten Zeilen (feste IDs je Formular → nichts doppelt).
  Fortytools-Zahlungen in `app.legacy_payments` (nur anhängen; Zahlung/Skonto je Zeile), „als bezahlt“ an der
  Fortytools-Rechnung schreibt ebenfalls eine Zeile. **Hinweis Skonto:** Abzug mindert die Umsatzsteuer (§ 17 UStG) –
  Korrektur macht der Steuerberater (DATEV-Export enthält „Skonto-Abzug“).
- 2026-10-07: Runde 23, Teil E – Einzelrechnungen wie Fortytools (Münchner Wohnen, bis 600 Bestellungen/Jahr):
  - Rechnungsentwurf: **Rechnungsadresse nur für diese Rechnung** (Häkchen, vorbelegt mit Gruppe/Kunde), Referenz-/
    Bestellnummer, **Kundenreferenz** („Ihre Referenz“ im PDF; in der E-Rechnung BT-10, falls keine Leitweg-ID, sonst als
    Hinweis), **Zahlungsbedingung je Rechnung** (sofort … 60 Tage) und „ohne Skonto“ (in `app.issue_invoice`),
    **Leistungszeitraum je Position** (PDF „Leistung: …“, E-Rechnung BT-134/135, KoSIT-gültig), **Minus-Positionen**
    (Menge negativ, Rechnung muss insgesamt positiv bleiben), **„+ Artikel hinzufügen“** (VK aus Artikeln), Einheit „lfm“.
  - Ausgestellte Rechnung: **Kopieren** (neuer Entwurf ohne Verknüpfung zu Objekt-Leistungen) und **„Adresse ändern“** =
    berichtigte Fassung: neue Anschrift + Grund, E-Rechnung vorher gegen KoSIT geprüft, neue Belege (PDF, XRechnung,
    ZUGFeRD) **zusätzlich** archiviert (`invoice_documents.revision`, `app.invoice_revisions` nur anhängen), Original
    unverändert; Versand der berichtigten Fassung genau einmal je Fassung. **Rechtlich:** Berichtigung durch den
    Aussteller (§ 31 Abs. 5 UStDV) nur für Anschrift/Schreibweise desselben Empfängers – anderer Empfänger = Storno +
    neue Rechnung (steht so in der App).
  - **Alle Rechnungen** schöner: Kennzahlen (Netto Jahr, offen/überfällig, nicht versendet, Link Statistik), Spalten
    Netto/Brutto/Fällig, Status-Schild (bezahlt / offen / überfällig mit Betrag / storniert) und Versandstatus.
  - Nicht gebaut: Lieferschein (Fortytools) – bei Bedarf als PDF ohne Preise nachrüsten.
  - Tests: 367 Unit-/DB-Tests (neu `runde23-invoice.db.test.ts` mit KoSIT, `runde23-op.db.test.ts`), Browser-Suiten grün.
- 2026-10-07: Runde 23, Teil G1 – Planung und Arbeitsschein:
  - **Planung:** Klick auf einen Einsatz öffnet ein Detailfenster wie Fortytools (Objekt, Kunde, Adresse mit Karte,
    Mitarbeiter mit Telefon, Zeit/Dauer/Pause, Serie, Objektleitung, Beschreibung) mit **„Vertretung einplanen“**
    (Tagesseite mit Vertretung vorgewählt), „Umplanen / Ausfall“, „Serie bearbeiten“; offene Termine „Mitarbeiter
    einplanen“. Kacheln zeigen in Woche/Tag Objekt, Zeit, Dauer und Straße (Text bricht um, Woche passt ohne Scrollen),
    Monat breiter und **mit gedrückter Maustaste seitlich ziehbar**, Namensspalte bleibt stehen.
  - **Arbeitsschein wie die alte App:** Leistungen aus dem Leistungskatalog des Objekts wählen (Preis wird eingefroren,
    `work_report_lines.service_id/unit_price_cents`) oder frei; **Regiestunden je Person** (Name, Stunden; angehakte
    Mitarbeiter werden übernommen, Stunden aus Beginn/Ende vorgeschlagen). **„Speichern und PDF erstellen“** schließt
    ohne Unterschrift ab (Unterschrift optional), danach **„Rechnung erstellen“** direkt am Schein: Leistungen mit
    Katalogpreis, Regie mit Regiestundensatz des Objekts und Namen, Leistungsdatum je Position, Schein-PDF als Anlage.
- 2026-10-07: Runde 23, Teil G2 – Unterweisungen und Objektordner:
  - **Unterweisungen & Unterschriften:** statt eigenem PDF auch **eigene Word-Vorlage** wählen (Einstellungen →
    Word-Vorlagen, Mitarbeiter-Vorlagen; „Unterweisung/Belehrung“ zuerst). Der Text wird mit den Firmendaten
    ausgefüllt und als PDF auf dem Briefpapier verteilt (Formatierung vereinfacht – aufwendige Vorlagen besser als PDF).
    **Mitarbeitersuche** über der Empfängerliste (Name oder Personalnummer). Listenfilter `data-filter-list` jetzt global.
  - **Objektordner je Objekt** (Objekt → Reiter „Objektordner“, auch Objektleitung): Ahmeds Paket
    „Objektordner-Komplettpaket“ einmal unter **Einstellungen → Objektordner-Vorlagen** hochladen (write-once im
    Archiv). „Objektordner herunterladen (ZIP)“ füllt in allen Word-Dateien die Lücken (Inhaltsverzeichnis-Kopf,
    Notruf, Kontaktkarten, Notfall-/Meldeplan …: Objekt, Kunde, Objektleitung + Tel, Bereichsleitung + Tel,
    Ansprechpartner Kunde, Ersthelfer, Angelegt am) und legt PDFs aus der App dazu: Objektstammblatt,
    Leistungsverzeichnis (ohne Preise), Reinigungsplan aus dem Raumbuch, Revierplan aus den Einsätzen.
    **Fehlende Angaben fragt die Seite ab** (Bereichsleitung, Ersthelfer, Ansprechpartner, Putzraum, Zugang,
    Reinigungsmittel, Besonderheiten → `sites.folder_info`) bzw. verlinkt Objektleitung/Telefon, Raumbuch, Einsätze,
    Leistungen. Probe mit dem echten Paket: 32 Dateien, Lücken gefüllt. **Auf dem Server: Paket einmal hochladen.**
- 2026-10-07: Runde 23, Teil H – App für Objektleitung/Büro (`/qm`, Rechte wie bisher: Objektleitung nur eigene Objekte):
  - Startseite mit weiteren Kacheln (Zeiten, Personalbogen, NU-Auftrag, Arbeitsscheine); Objekt-Details mit Einsätzen,
    Zeiten, Schlüsseln, Übergabe/Unterweisung, Objektordner, Arbeitsschein, Personalbogen, NU-Auftrag.
  - **Personalbogen zum Selbstausfüllen** (`/qm/personalbogen`, de/en/ro/tr/pl/hr/bg, deutsche Bezeichnung klein darunter):
    neue Mitarbeitende füllen am Handy der Objektleitung aus → `app.personnel_forms` (vertraulich: lesen per RLS nur
    Admin/Personal, die Objektleitung kann nur absenden). Büro: Personal → Personalbögen → „Als Mitarbeiter anlegen“
    (Formular vorbelegt) oder verwerfen; Hinweis auf der Startseite. **Übersetzungen von Muttersprachlern gegenlesen lassen.**
  - **NU-Auftrag anfragen** (`/qm/nu-auftrag`): Objektleitung legt einen Entwurf an (`subcontracts.requested_by/request_note`),
    Büro sieht ihn unter Bestellungen als „angefragt (Objektleitung) · Freigabe nötig“ (+ Hinweis Startseite, Banner im
    Auftrag), ergänzt Preis/Nachweise und erteilt. Erteilen bleibt Büro-Recht.
  - Leistungsbeschreibung mehrzeilig; nur noch eine Statistik (Auswertungen) mit farbigen Diagrammen; volle Namen statt
    Benutzernamen (Teil C).
  - Tests: 371 Unit-/DB-Tests (neu `runde23-olapp.db.test.ts`), e2e/rechte/runde10 grün.
- 2026-10-07: Runde 23, Teil B – Sortierung überall: jede Liste ist per Klick auf die Spaltenüberschrift sortierbar (Teil A);
  **alle CSV-Exporte** übernehmen jetzt die Bildschirm-Sortierung (Browser hängt `sort`/`dir` an jeden CSV-Link, eine
  Middleware sortiert die fertige CSV nach der gleichnamigen Spalte um, `src/web/csv-sort.ts`; Summenzeilen bleiben unten,
  DATEV/Windows-1252 bleibt unberührt). PDF-Exporte der Stundenliste wie gehabt.
- 2026-10-07: **Eine gemeinsame App** (Ahmed) für App Store/Google Play: Startbildschirm `/app` (ohne Anmeldung) mit
  „Mitarbeiter“ (→ `/m`, Personalnummer + PIN) und „Objektleitung & Büro“ (→ `/qm`, Benutzer + Passwort); wer angemeldet
  ist, landet direkt im Bereich (`/app?wahl=1` zeigt immer die Auswahl). Eigenes Manifest `/app/manifest.webmanifest`
  (Scope `/`), Capacitor lädt `/app`. Fund (Ahmed: „als Admin keine Dokumente, Objekte“): online war die Mitarbeiter-
  Ansicht `/m` offen – die zeigt nur eigene Einsätze/Dokumente. `/qm` jetzt für alle Büro-Rollen (auch Personal) mit
  Kacheln je Rolle: Objekte, Planung, Zeiten, Mitarbeiter, Dokumente (Unterweisungen), Urlaub, Kunden, Tickets, Audits,
  Arbeitsscheine, Personalbogen, NU-Auftrag, Posteingang, Büro-Ansicht; Objekt-Details zusätzlich Dokumente, Notizen,
  Leistungen & Preise (nur Büro), „am PC öffnen“. Link „Objektleitung & Büro: hier anmelden“ auf der Mitarbeiter-Anmeldung.
  **Store-Veröffentlichung wartet auf:** D-U-N-S-Nummer, Google-Play- und Apple-Developer-Konto (GmbH), Firebase (Push).
- 2026-10-07: **Eine Anmeldung für alle** (Ahmed: „automatisch über den Zugang erkennen“): `/app` hat nur noch ein
  Formular „Personalnummer oder Benutzername“ + „PIN oder Passwort“. Nur Ziffern → Personalnummer + PIN →
  Mitarbeiter-Ansicht `/m`; sonst Benutzername + Passwort → Objektleitung & Büro `/qm`. Geprüft wird über die
  bestehenden Anmeldungen (`/m/anmelden`, `/anmelden`, gleiche Sperren nach 5 Fehlversuchen); Fehler → zurück zu `/app`
  mit Meldung, Kennung bleibt stehen. Benutzernamen enthalten nie nur Ziffern (Regel `[a-z0-9._@-]`, Personalnummern
  sind Ziffern) – die Weiche ist eindeutig, solange kein Benutzername nur aus Ziffern besteht.
- 2026-10-07: **Objektleitung und Büro stempeln selbst** (Ahmed): Benutzer ↔ Mitarbeiter verknüpft
  (`app.profiles.employee_id`, Einstellungen → Benutzer → „Mitarbeiter (eigene Zeiterfassung)“; ohne Verknüpfung gilt
  genau ein aktiver Mitarbeiter mit gleichem Namen). Mit der Büro-Anmeldung öffnet `/m` die eigene Zeiterfassung ohne
  PIN (Stempeln, Zeiten, Urlaub, Dokumente, Stundenliste unterschreiben); oben „Büro“ statt „Abmelden“. Am PC Knopf
  „Meine Zeiterfassung“ in der Kopfzeile (und im Benutzermenü), in der App Kachel „Meine Zeiterfassung“ (Team-Zeiten
  heißen „Zeiten (Team)“). Tests: neu `npm run e2e:login` (13 Prüfungen), 373 Unit-/DB-Tests.
- 2026-10-07: **In der App bleiben** (Ahmed: „komme wieder auf die Seite vom PC“):
  - **App-Rahmen:** Wer die App (`/qm`, `/app`) öffnet, bekommt das Cookie `vd_app=1` – danach erscheint jede Büro-Seite
    (Objekt, Schlüssel, Übergaben mit Unterschrift, Arbeitsschein, Dokumente, Formulare …) im App-Design: oben Zurück +
    Titel + Übersicht, unten die Leiste Übersicht / Objekte / Team / Zeiten / Ich, ohne PC-Menü (`Layout` mit `app`).
    Kachel „PC-Ansicht“ bzw. `?pc=1` schaltet zurück. Symbole der Handy-Ansichten jetzt in `src/web/m/icons.tsx`.
  - **Eigene App-Seiten** (`routes-qm-team.tsx`): **Team** (Suche, Status heute „im Einsatz“/„abwesend“, je Person
    Anrufen, WhatsApp, Einsätze, Abwesenheiten, Objekte; Personal/Admin zusätzlich Dokumente, Übergaben, Stammdaten),
    **Urlaub / Krankheit für andere eintragen** (Admin/Personal sofort genehmigt; Objektleitung: Krankheit sofort, Urlaub
    und Sonstiges als Antrag ans Büro; Urlaubsanspruch und Überschneidung wie im Büro geprüft; Buchhaltung sieht keine
    Art der Abwesenheit), **Zeiten heute** (jeder geplante Einsatz mit erledigt / seit … / nicht gestempelt / abwesend,
    „ohne Einsatz gestempelt“, Nachträge direkt freigeben oder mit Grund ablehnen). Objektleitung nur eigene Objekte.
  - Tests: `npm run e2e:login` jetzt 23 Prüfungen; 373 Unit-/DB-Tests, Browser-Suiten grün.
- 2026-10-07: Rechte Abwesenheiten (Ahmed): **Objektleitung genehmigt Urlaub selbst** – in der App eingetragene Abwesenheiten
  sind sofort genehmigt; Anträge aus der Mitarbeiter-App (eigene Leute) stehen unter Team → „Anträge zum Genehmigen“
  (genehmigen/ablehnen, Urlaubsanspruch wird geprüft). **Buchhaltung sieht Urlaub/Krank (Lohn):** Art der Abwesenheit
  überall sichtbar, Zugriff auf Urlaub & Abwesenheiten, Stundenliste & Lohnarten, Auswertungen Urlaub/Krankheit.
  Datenschutz: Krankheit = Gesundheitsdatum (Art. 9 DSGVO) – nur „krank“, nie Diagnose; Zugriff auf Lohn-Zwecke beschränkt
  (im Verzeichnis der Verarbeitungstätigkeiten so festhalten). `e2e:login` 25 Prüfungen.
- 2026-10-07: Ahmed: „Meine Zeiterfassung soll nicht so aussehen“ / App aufgeräumter:
  - **Am PC: Personal → „Meine Zeiten“** (`/zeiterfassung/meine`, Knopf oben rechts, für alle Büro-Rollen mit verknüpftem
    Mitarbeiter): Monat blättern, Summe Stunden/Tage, Liste der eigenen Zeiten, **nachtragen und ändern** (Änderung nur mit
    Grund; gespeichert wie eine Büro-Korrektur `officeSave`, alter/neuer Stand im Protokoll, Überschneidungen und Pause
    geprüft). Nur der eigene Mitarbeiter-Datensatz. **Hinweis:** Wer seine eigene Zeit ändert, gibt sie sich selbst frei –
    das Protokoll zeigt es; bei Prüfungen (Zoll) muss die Änderung begründet sein.
  - **App (Objektleitung/Büro):** nach der Anmeldung zuerst die **eigene Zeit** (Mitarbeiter-Ansicht `/m`) – oben Umschalter
    **Meine Zeit · Qualität · Verwaltung**. Verwaltung (`/qm`): Kennzahlen heute (im Einsatz, nicht gestempelt, abwesend,
    Anträge, Nachträge) und Bereiche „Team & Zeiten“, „Objekte & Dokumente“, „Formulare“ mit Kacheln + Kurzbeschreibung,
    Leiste unten Übersicht/Team/Zeiten/Objekte. Qualität (`/qm/qualitaet`): heutige Audits, Audit starten, Tickets, alle
    Audits, Arbeitsscheine, Leiste unten Audits/Audit starten/Tickets. Ohne verknüpften Mitarbeiter direkt Verwaltung.
  - Tests: `e2e:login` 30 Prüfungen, alle Suiten grün.
- 2026-10-07: **Einsatzkalender und Einsatzliste beim Mitarbeiter wie Fortytools** (Ahmed, Screenshots):
  - Kalender (`/personal/:id/kalender`, `pages-employee-calendar.tsx`): Tag / 5 Tage / Woche / Monat (Standard), ← Heute/
    Dieser Monat →, „+ Einsatz planen“; Kennzahlen geplant / gearbeitet / „bestätigt x von y Einsätzen“ / „n ohne erfasste
    Zeit“. Je Einsatz ein Balken mit Objekt und Uhrzeit: geplant (hell), **Zeit bestätigt (Bordeaux + Uhr-Symbol)**, läuft
    (blau), Nachtrag offen (gelb), keine Zeit erfasst (rot gestrichelt, nur Vergangenheit), abwesend/Ausfall
    (durchgestrichen), ohne Einsatz gearbeitet (grün mit Uhr). Heute gelb, Feiertage blau mit Namen, Abwesenheitstage
    schraffiert mit Art. Monat höchstens 3 Einsätze je Tag + „x weitere“. Antippen → Detailfenster (geplant, erfasst, Pause,
    Arbeitszeit, Quelle, Serie) mit Zeit erfassen/ändern, Umplanen/Vertretung, Terminserie, Objekt. Alte Links `?monat=` gehen.
  - Einsatzliste (`/personal/:id/einsaetze`): je Objekt eine Karte (Kunde, Adresse, „letzte 7 Tage: x von y bestätigt“),
    gleiche Zeiten mit allen Wochentagen in einer Zeile (Mo–So-Kästchen), Std. je Einsatz, Turnus/gültig ab–bis, „Ändern“;
    oben Anzahl Objekte und ≈ Std. pro Woche; beendete Einsätze eingeklappt; die bisherige Einzelliste (Beenden/Löschen)
    eingeklappt darunter. `e2e:login` 33 Prüfungen, alle Suiten grün.
- 2026-10-07: **Fund Zeiten-Import (Ahmed: „Stunden drin, aber keine Einsätze“):** Die abgeleiteten Einsätze galten erst
  ab dem Tag nach der letzten Zeit bzw. ab dem Anlagetag (Soll zählt erst ab Anlage) – im importierten Zeitraum waren
  sie daher unsichtbar, die Zeiten hingen an keinem Einsatz. Jetzt: gültig ab dem **ersten Vorkommen** im Export
  (Anlagezeitpunkt wird mitgesetzt), bei Exporten unter 14 Tagen reicht ein Vorkommen. Ein erneuter Import derselben
  Datei zieht bereits angelegte abgeleitete Einsätze auf das erste Vorkommen vor (nichts doppelt). Probe mit dem echten
  Export: 660 Einsätze vorgezogen, 2.311 von 2.366 Einsatztagen im September mit Zeit („Zeit bestätigt“), Rest = Tage
  ohne erfasste Zeit. **Auf dem Server: Zeiten.csv noch einmal importieren (Häkchen „Einsätze ableiten“).**
- 2026-10-07: **Mitarbeitende ohne Einsatz** (Ahmed): aktive Mitarbeitende ohne laufenden/künftigen Einsatz bekommen in der
  Mitarbeiterliste das Schild „kein Einsatz“ (Link zur Einsatzliste), oben den Hinweis „n aktive Mitarbeitende ohne
  laufenden Einsatz – anzeigen“ (Filter `?einsatz=ohne`), auf der Startseite einen Hinweis (Objektleitung: nur
  Mitarbeitende ihrer Objekte → Planung), oben in der Planung (gelber Balken) und in der Mitarbeiter-Übersicht.
  Objekt „Allgemein (aus Fortytools)“ (Buchungen nur auf Kundenebene, z. B. Epox Entsorgungs GmbH) darf umbenannt werden:
  Zeiten-, CSV- und Nachunternehmer-Import erkennen es über die feste ID wieder (kein zweites „Allgemein“). 375 Tests.
- 2026-10-07: **Handy + Listen schöner** (Ahmed, Fortytools-Screenshots):
  - Sortier-Pfeile in allen Tabellen entfernt (auf dem iPhone als Emoji-Kästchen); Sortieren per Klick bleibt, die
    sortierte Spalte ist Bordeaux unterstrichen.
  - **Mitarbeiterliste als Karten wie Fortytools:** Initialen-Kreis, Name + Personalnr., Tags/Beschäftigung, Hinweise
    (kein Einsatz, Vergütung fehlt), Warnhinweis, Adresse mit Kartenlink, Telefon (antippen = anrufen), E-Mail, Objekte,
    Geburtsdatum + Alter, Betriebszugehörigkeit + Wochenstunden, Staatsangehörigkeit, Aufenthaltstitel/Arbeitserlaubnis
    (gelb ≤ 60 Tage, rot abgelaufen). 25 je Seite, „1–25 von N“, Sortierung Name/Personalnr./Eintritt. **Steuer-ID und
    SV-Nummer bewusst nicht in der Liste** (Datensparsamkeit, DSGVO) – stehen in der Personalakte.
  - Kunden-/Objektliste: Initialen-Kreis, Name in Bordeaux, Adresse mit Ortssymbol, Anzahl Objekte, offener Betrag als
    Schild; am Handy Buchstabenleiste wischbar, QR-Druck/Objektleitungen-Zuordnen nur am PC.
  - Startseite am Handy: Karten liefen rechts über den Rand (Raster ohne `minmax(0,…)`) → behoben; Offene Posten am Handy
    je Kunde voller Name, darunter Tage/Offen/Überfällig/Summe. Gelbe Hinweiskästen brechen am Handy sauber um.
- 2026-10-07: Rückmeldung Handy/Objekte (Ahmed):
  - **Fund:** „Mitarbeitende“ in der Objektliste zählte nur die Zuordnung Mitarbeiter ↔ Objekt – der Zeiten-Import hat
    sie bei abgeleiteten Einsätzen nicht gesetzt (normale Planung schon). Folge auch: Stempeln am Objekt nur bei
    Zuordnung. Behoben im Import; Migration `20261111000010` ergänzt die Zuordnung für alle laufenden/künftigen Einsätze
    (nur hinzufügen, nichts löschen).
  - Einsatzkalender am Objekt: jeder Einsatz anklickbar (→ Tag umplanen / Vertretung / Ausfall, zurück zum Kalender);
    Wochenansicht am Handy je Tag mit den Einsätzen darunter (vorher alle Tage oben, Einsätze unten); Monat am Handy nur
    Uhrzeit je Einsatz, Tag antippen = Tagesansicht.
  - Objektliste: „Kunde“ kleiner mit Beschriftung, „Objektleitung“ beschriftet. Kundenliste: graues Schild „n Objekte“
    entfernt (doppelt zum Knopf „Objekte (n)“).
- 2026-10-07: Objektliste zählte alle zugeordneten Mitarbeitenden, die Objektseite nur „Reinigungskräfte“ (ohne Kennzeichen
  „Objektleitung“) → 5 vs. 4. Jetzt beide gleich: „n Reinigungskräfte“ ohne Mitarbeitende mit Tag „Objektleitung“.
- 2026-10-08: Ahmed: RTV-Sätze übernehmen – Sonntag/Feiertag 80 %, **hohe Feiertage 150 %** (vorher 200 %; Migration
  `20261111000011` ändert nur, wenn noch 200 % eingestellt war). PDF-Checkliste Echtbetrieb (`docs/checkliste-echtbetrieb.html`):
  SMTP über IONOS Exchange (`smtp.exchange2019.ionos.de:587`, in `/opt/viva/deploy/.env.live`), Cloud Backup prüfen
  (Acronis-Agent, `/opt/viva-sicherung`), Patentamt über Portal (XRechnung hochladen), D-U-N-S online nicht gefunden
  (Firmenname im HRB prüfen: „Viva-Deluxe GmbH Gebäudeservice“ vs. „Gebäudereinigung“). Bauplan: eingehende E-Rechnungen,
  Lohnkostenanteil Pflicht + Preisanpassung, Portal-Versand, kleine Punkte, Erinnerungen, Ampel, Monatsabschluss,
  Arbeitszeitkonto, Stempeln mit Standort, Lohnabrechnungen aus Sammel-PDF, Store-App, Bankabruf (am Ende).
- 2026-10-08: **Eingehende E-Rechnungen** (Rechnungseingang → „E-Rechnung einlesen“; auch aus dem Dokumenteneingang „als
  E-Rechnung lesen“): XRechnung UBL (Invoice/CreditNote), CII und ZUGFeRD/Factur-X-PDF (eingebettetes XML wird aus der PDF
  gelöst). Eigener Leser `src/domain/einvoice/incoming.ts` (xmlbuilder2 + pdf-lib, DOCTYPE abgelehnt, Beträge als Cent).
  Prüfseite mit Kopf, Rechnungssteller, Positionen, Steueraufschlüsselung, Skonto (#SKONTO# oder Freitext); Lieferant über
  USt-IdNr./Steuernr. → IBAN → Name erkannt, sonst „neu anlegen“ aus den Rechnungsdaten. Übernahme = Eingangsrechnung mit
  fester ID je Datei (doppelt absenden legt nichts doppelt an), Datei write-once an der Rechnung, Positionen bleiben an der
  Eingangsrechnung sichtbar (`incoming_invoices.einvoice`). Warnungen: Summen passen nicht, Dublette (gleiche Nummer),
  eigene Ausgangsrechnung, anderer Rechnungsempfänger, **IBAN weicht von der hinterlegten ab (Betrugsmasche – vor Zahlung
  telefonisch bestätigen)**. Freigabe „sachlich und rechnerisch richtig“ wie bisher.
  Fund nebenbei: Kontoauszug-Import (CAMT) löste „&amp;“ in Namen nicht auf – gemeinsamer Helfer `src/domain/xml.ts`.
  Noch nicht: automatischer Abruf aus dem Postfach buchhaltung@ (IMAP) – sinnvoll, sobald der Mail-Zugang steht.
- 2026-10-08: **Lohnkostenanteil Pflicht + Preisanpassung** (Ahmed: „nicht bei jedem gleich wegen dem Lohnkostenanteil“):
  Leistungsformular verlangt den Lohnkostenanteil (vorbelegt aus der Leistungsart; leer → Vorgabe der Leistungsart, sonst
  Fehler; Importe bleiben ohne). Rechnungen → **Preisanpassung**: „Lohnkostenanteil fehlt“ (gesammelt nachtragen, nur leere
  Felder), Vorschau ab Monatsersten + Tariflohnerhöhung % (Filter Kunde/Leistungsart): neuer Preis = alt + alt × Anteil ×
  Erhöhung (half-up auf Cent). Gesperrt: Anteil fehlt, Beginn ab Stichtag, Stichtag mitten im Abrechnungszeitraum
  (quartalsweise usw.). Übernahme: alte Leistung endet am Vortag, Kopie mit neuem Preis ab Stichtag (feste ID je Leistung +
  Stichtag), optional Zusatztext wie Fortytools „3.099,86 € + 4,00 % Tariflohnerhöhung ab 01.01.2027“. Läufe/Positionen
  nur anhängen (`price_adjustments`, `price_adjustment_items`). **Anschreiben** je Kunde (PDF auf Briefpapier mit
  bisher/neu, auch in der Kundenakte „Schriftverkehr“). **Rechtlich:** Erhöhung nur mit Preisgleitklausel im Vertrag oder
  Zustimmung des Kunden; bei öffentlichen Auftraggebern nach Vertragsbedingungen (steht als Hinweis auf der Seite).
  Tests: `price-adjustment.db.test.ts`, `e2e:leistungen` 16 Prüfungen.
- 2026-10-08: **Portal-Versand** (Ahmed: nur Patentamt lädt über sein Portal): Rechnungsgruppe → „Versandweg“ E-Mail oder
  **Portal des Kunden** (+ Name des Portals; nur mit E-Rechnung). Bei Portal kein Mailversand (gesperrt mit Hinweis); an
  der Rechnung „Im Portal hochgeladen“ (+ Upload-Referenz) → Versandprotokoll Kanal „portal“ mit Zeitpunkt, Benutzer,
  E-Rechnungsdatei (nur KoSIT-gültig), genau einmal je Fassung; zählt als versendet. Spalten
  `invoice_groups.delivery_channel/portal_name`, `invoice_deliveries.channel/portal_reference/recorded_by`.
  **Einstellungen → Nummernkreise** (nur Admin): alle Kreise mit höchster vergebener (inkl. Fortytools-Rechnungen) und
  nächster Nummer, nur **anheben** (nie senken, nie ≤ vergebene Nummer; Protokoll). Tests: `portal-ranges.db.test.ts`.
- 2026-10-08: **Erinnerungen** (`/erinnerungen`, Hinweis oben auf der Startseite): Aufenthaltstitel/Arbeitserlaubnis
  (60 Tage), NU-Nachweise, HU/Inspektion (30 Tage), Ausschreibungs-Termine (7 Tage), Eigen-Compliance, fällige Aufgaben,
  Skonto im Rechnungseingang (3 Tage), Einsätze von gestern ohne Zeit; rot/gelb sortiert. **Tägliche Sammel-Mail**
  (Einstellungen → Erinnerungen per E-Mail: an/aus, Empfänger, ab Uhrzeit), Server prüft alle 15 Min., höchstens einmal je
  Tag (Datum wird vor dem Versand gesetzt), ohne Fristen/ohne SMTP keine Mail, im Test nur an die Testadresse.
  Push aufs Handy folgt mit Firebase. **Ampel Nachkalkulation** als Startseiten-Karte (Vormonat: ≥ Ziel / unter Ziel /
  Verlust, schlechteste 5 Objekte). Behoben: Stunde aus Intl („05 Uhr“) → NaN, jetzt `hourBerlin()`.
  Tests: `reminders.db.test.ts`.
- 2026-10-08: **Monatsabschluss-Assistent** (Rechnungen → Monatsabschluss, Standard Vormonat, ← →): Schritte mit Zähler und
  Link – Zeiten (laufende Stempelungen, Nachträge, Einsätze ohne Zeit, Urlaubsanträge, Objekt-Bestätigungen,
  Stundenlisten unterschrieben), Abrechnung (fällige Pauschalen ohne Rechnung, verrichtete Leistungen, Entwürfe,
  nicht versendet), Einkauf (erwartete NU-Rechnungen, zu prüfen), Lohn & Buchhaltung (Kasse abgeschlossen, Lohnarten-
  und DATEV-Export von Hand). „Monat abschließen“ hält den Stand fest (`month_closings`, nur anhängen; bei offenen
  Punkten nur mit Begründung), sperrt nichts. Tests: `month-close.db.test.ts`.
- 2026-10-08: **Arbeitszeitkonto** (Personal → Arbeitszeitkonto, Admin/Personal/Buchhaltung): je Mitarbeiter und Monat
  Soll (Wochenstunden ÷ 5 × Arbeitstage, Stunden-Verlauf), gearbeitet, bezahlte Abwesenheit, Ist, Saldo, Buchungen,
  **Kontostand** fortlaufend ab Startmonat (Standard: erster Monat mit Zeiten, höchstens 24 Monate gerechnet). Buchungen
  Startsaldo/Auszahlung/Freizeitausgleich/Korrektur mit Begründung, nur anhängen (`time_account_bookings`). CSV-Export.
  **Rechtlich § 2 Abs. 2 MiLoG:** Plusstunden höchstens 50 % der Monats-Sollzeit, Ausgleich binnen 12 Monaten – Zeilen
  darüber rot. Tests: `time-account.db.test.ts`.
- 2026-10-08: **Stempeln mit Standort** (Zeiterfassung → Einstellungen „Stempeln mit Standort“, Standard aus): Handy fragt
  nur beim Ein-/Ausstempeln nach dem Standort; gespeichert werden nur Bewertung (am Objekt / nicht am Objekt / ungenau /
  kein Standort), Entfernung und Genauigkeit – **keine Koordinaten, kein Bewegungsprofil**. Bewertung zugunsten der
  Mitarbeitenden (Entfernung − Genauigkeit ≤ Umkreis), Genauigkeit > 1 km = ungenau. Stempeln wird nie verweigert; im Büro
  erscheinen Schilder „Ein/Aus nicht am Objekt (1,2 km)“. Standort je Objekt unter Objekt → „QR-Aushang & Standort“
  (Google-Maps-Link, Koordinaten oder „Mein aktueller Standort“ vor Ort), Umkreis 50–5000 m (Standard 250 m).
  **Datenschutz:** Mitarbeitende vorher informieren (Art. 13 DSGVO), Betriebsrat beteiligen falls vorhanden (§ 87 Abs. 1
  Nr. 6 BetrVG), Verzeichnis der Verarbeitungstätigkeiten. Tests: `geo.test.ts`, `geo-stamp.db.test.ts`.
- 2026-10-08: Kleine Punkte:
  - **Lieferschein** (Knopf an jeder Rechnung/Entwurf): PDF auf Briefpapier mit Positionen, Menge, Einheit – ohne
    Preise – und Feld „Empfangen“ zum Unterschreiben.
  - **Schriftverkehr:** freier Brief auf Briefpapier an Kunde (Dokumente → „Freien Brief schreiben“), Mitarbeiter
    (Dokumente) oder Lieferant/Nachunternehmer (Dokumente): Betreff, Datum, Anrede, Text → PDF, write-once in der Akte
    unter „Schriftverkehr“ (feste ID je Formular). Hinweis Schriftform bei Kündigung/Aufhebung/Befristung.
  - **Anlaufplan Objektübernahme** (Objekt → Aufgaben): 12 Schritte als Aufgaben für die Objektleitung relativ zum
    Leistungsbeginn (Begehung −21 Tage … Abstimmungsgespräch +30 Tage), erneut erstellen verschiebt nur offene Schritte.
    Hinweis § 613a BGB bei Übernahme von Personal des Vorgängers.
  - Tests: `runde24-small.db.test.ts`.
- 2026-10-08: **Grundreinigung für die Objektleitung** (Disposition → Grundreinigung, `/grundreinigung/objektleitung`):
  Termine der eigenen Objekte je Jahr mit Objekt, Adresse, Zeitraum, Eigenpersonal/Nachunternehmer, Flächen und
  Hinweis – **ohne Preise**, nur lesen. **Mehrarbeitszuschlag** (RTV § 10, Einstellungen → Zuschläge & Lohnarten:
  ab 39 Std./Woche, 25 %): je Kalenderwoche über alle Objekte, Minuten über der Schwelle dem Tag zugeordnet, an dem sie
  anfallen (Wochen am Monatsrand vollständig gerechnet), neue Lohnart „Zuschlag Mehrarbeit“ mit Betrag im CSV.
  Tests: `runde24-small.db.test.ts` (Mehrarbeit über Monatsgrenze).
- 2026-10-08: **Lohnabrechnungen verteilen** (Personal → Lohnabrechnungen, Admin/Personal/Buchhaltung): Monat wählen, ZIP mit
  Einzel-PDFs oder eine Sammel-PDF aus dem Lohnprogramm hochladen. Zuordnung über die Personalnummer im Text (bzw.
  Dateinamen); Folgeseiten ohne Nummer gehören zur vorigen Person; nicht zuordenbare Seiten werden aufgelistet. Ablage
  write-once in der Personalakte (Kategorie „Lohnabrechnung“, feste ID je Person/Monat/Inhalt → doppelt hochladen legt
  nichts doppelt an). Freigabe für die Mitarbeiter-App (`/m/dokumente`, Karte „Lohnabrechnungen“), „gesehen am“ wird
  vermerkt. **Rechtlich:** Elektronische Abrechnung (§ 108 GewO) ist zulässig, wenn die Beschäftigten sie abrufen können
  (BAG 28.01.2025, 9 AZR 48/24) – wer kein Handy nutzt, bekommt sie weiter auf Papier. Neue Abhängigkeit `unpdf` 1.8.1
  (Text aus PDF). **Ahmed: eine echte Sammel-PDF aus Lexware zum Testen der Erkennung schicken.**
- 2026-10-08: Rückmeldung Ahmed (3 Punkte):
  - **Karten-Belege:** Kachel antippen öffnet den Beleg (neuer Tab), „bearbeiten“ und „+ Karten-Beleg“ auf eigener Seite
    (kein Sprung nach unten mehr). **Löschen** nur im Monat des Belegs (Datei bleibt write-once im Archiv, Stand im
    Protokoll), danach **stornieren** mit Grund (bleibt durchgestrichen sichtbar, zählt nicht in Summe/ZIP, nicht mehr
    änderbar). Spalten `card_receipts.cancelled_at/by/cancel_reason`.
  - **Zeiten endgültig löschen** (nur Admin): Zeiterfassung → Zeitraum, Filter „Herkunft: aus Fortytools übernommen /
    abgelehnt-entfernt“, Häkchen (auch „alle“) → „Markierte löschen“ mit Grund; einzeln auf der Zeit-Seite. DB-Funktion
    `app.purge_time_entry` schreibt Zeile + Änderungsprotokoll vollständig ins **Löschprotokoll**
    (`time_entry_deletions`, nur anhängen, auf der Seite aufklappbar); normales DELETE bleibt gesperrt.
    **Rechtlich:** nur für Testdaten/falsche Importe – echte Arbeitszeiten 2 Jahre aufbewahren (§ 17 MiLoG), dafür
    weiter „korrigieren“ oder „entfernen“.
  - **September leer:** Mit dem echten Export lokal geprüft – Import 2.459 Zeiten in 12 s, Tagesansicht 15.09. Soll
    399 Std. / Ist 414 Std. Der Code zeigt die Zeiten; auf dem Server sind sie offenbar nicht (vollständig) übernommen.
    Neu: Import-Seite zeigt „Bisher übernommene Zeiten“ je Monat mit Link. **Ahmed: Transfer → Import aus Fortytools →
    Karte „Artikel und erfasste Zeiten“ prüfen; steht dort „noch keine“, Zeiten.csv hochladen → Prüfen → Übernehmen.**
  - **Fund Lohnabrechnungen:** Die aufgeteilten PDFs bekamen einen Zeitstempel – dieselbe Sammel-PDF eine Sekunde später
    erneut hochgeladen hätte jede Abrechnung doppelt abgelegt. Jetzt ID aus Quelldatei + Seiten, feste Zeitstempel.
  - Tests: 411 Unit-/DB-Tests (neu `runde25.db.test.ts`), `e2e:kasse` 68, `e2e:zeit` 26, `e2e:rechte` 30 Prüfungen.
- 2026-10-08: Runde 26, Paket A (Ahmed, 33 Punkte; Pakete B–E folgen):
  - **„Fortytools“ ausgeblendet** (Kunde, Objekt, Rechnungen, Stundenliste, Offene Posten): Schild/Zusätze „(Fortytools)“
    entfernt, Migration `20261113000001` bereinigt Importtexte (Objekt „Allgemein (aus Fortytools)“ → „Allgemein“,
    Warnhinweis „Fortytools: Zahlungsbedingung …“, Notiz „Import aus Fortytools“, Leistungs-Notizen „Fortytools-Auftrag
    …“/„abgelöst durch …“, Zeiten-Notiz „aus Fortytools · …“, Einsatz-Notiz). Importe schreiben diese Texte nicht mehr;
    das „Allgemein“-Objekt wird über die feste ID bzw. beide Namen wiedererkannt. Import-Seiten selbst heißen weiter so.
  - **Leistungen am Objekt übersichtlicher:** Zeilen statt breiter Tabelle (Titel + Leistungsart, Zyklus/Zeitraum,
    Menge × Preis, Gesamt), Gruppen „Regelmäßige Leistungen“ / „Je Ausführung / einmalig“ / „Beendete“ (eingeklappt),
    Summe „regelmäßig je Monat“. Link „Leistungsarten“ entfernt (nur noch Einstellungen).
  - **Weniger Rot:** Hintergrund neutral grau, Tabellenköpfe/Formularfuß/Hinweisflächen grau statt rosa; Bordeaux nur
    Seitenleiste, Knöpfe, aktive Reiter. App (/m, /qm) unverändert.
  - **Rechnung ohne Rechnungs-E-Mail:** Kein „Per E-Mail versenden“ (Server lehnt auch ab), stattdessen „Als versendet
    markieren“ (Post / persönlich übergeben / Fax / sonstiges + Bemerkung) → Versandprotokoll Kanal „manuell“, genau
    einmal je Fassung (Migration `20261113000002`).
  - **Dokumente:** „Alle als ZIP herunterladen“ bei Kunde, Objekt, Mitarbeiter (Ordner je Kategorie, Archiv-Unterordner,
    gleiche Rechte wie Einzeldateien, max. 800 MB). Kunden-Dokumente unterteilt (Vertrag, Leistungsverzeichnis, Angebot &
    Ausschreibung, Schriftverkehr, Protokolle & Abnahmen, Rechnungen & Belege, Sonstiges; alte Ablage unter „Weitere“).
  - **Freier Brief** oben auf den Dokumenten-Reitern von Kunde, Objekt (an die Rechnungsanschrift des Objekts, abgelegt
    beim Objekt, Objektleitung nur eigene Objekte) und Mitarbeiter; Briefpapier wie Rechnungen. **Briefpapier ab
    01.11.2026 (neue Adresse) fehlt noch.**
  - **Word-Vorlage ≠ unterschrieben:** Beim Mitarbeiter erzeugte Word-Dokumente landen in „Entwurf (aus Vorlage)“ und
    haken die Pflichtunterlage nicht mehr ab (Bestand per Migration `20261113000003` umgehängt).
  - **Fehlende Unterlagen:** zusätzlich Pflicht „Personalunterlagen“ und fehlende Stammdaten (Steuer-ID, SV-Nummer, IBAN,
    Krankenkasse, Geburtsdatum, Anschrift).
  - Ahmed 08.10.: **D-U-N-S 343512805.** Qwist-Zugangsdaten wurden im Chat geschickt → **nicht verwendet, bitte bei Qwist
    neu erzeugen** und nur auf dem Server in `.env.live` eintragen (`QWIST_CLIENT_ID`, `QWIST_CLIENT_SECRET`).
- 2026-10-08: Runde 26, Paket B – Zeiterfassung wie Fortytools (Ahmed, Screenshots):
  - **Ein Einsatzkalender für alles** (`pages-employee-calendar.tsx`, Daten `employee-calendar-data.ts`): Mitarbeiter-Reiter
    „Einsatzkalender“ und „Zeiten“ (Standard Liste), **Zeiterfassung → Je Mitarbeiter** (`/zeiterfassung/mitarbeiter`,
    Mitarbeiterauswahl; `/zeiterfassung` ohne Datum führt dorthin, Tagesübersicht über „Ein Tag“) und **Meine Zeiten**.
    Monat mit Balken je Einsatz (Uhr = Zeit bestätigt, rot gestrichelt = keine Zeit), Woche/5 Tage/Tag als Stundenraster
    (Objekt, Zeit, Dauer, Adresse; Überschneidungen nebeneinander), Liste (geplant/erfasst/Pause/Dauer/Status). Rechts
    „Geplant“ (Einsätze, Std.) mit **„Plan-Zeiten als Ist-Zeiten erfassen“**, „Erfasst“ (Einsätze, Krank, Urlaub, Sonstiges,
    Gesamt) und **Soll/Ist als Balken** mit Differenz bis heute. Klick auf einen Einsatz: Details mit „So gearbeitet –
    bestätigen“, Zeit erfassen/ändern, Serie bearbeiten, nur diesen Tag umplanen, Einsatz löschen.
  - **Plan als Ist im Büro** (`officeConfirmPlanned`): vergangene Einsätze ohne Zeit (nicht abwesend, kein Ausfall, kein
    Feiertag) → freigegebene Zeit mit Plan-Zeiten, Pause mindestens gesetzlich, Protokollgrund „Plan als Ist (Büro)“,
    feste ID wie in der App (nichts doppelt), Überschneidungen übersprungen. Objektleitung nur eigene Objekte; eigene Zeiten
    (Meine Zeiten) für jede Büro-Rolle. **Hinweis:** Bestätigt das Büro Plan-Zeiten, ohne dass gestempelt wurde, muss die
    Arbeitszeit tatsächlich so geleistet sein (§ 17 MiLoG – Aufzeichnung muss stimmen).
  - **Einsätze löschen** geht jetzt immer (auch vom Import): erfasste Zeiten bleiben erhalten, nur ihre Verknüpfung zum
    Einsatz entfällt (Protokoll). In der Einsatzliste beim Mitarbeiter „Löschen“ je Zeile (alle Wochentage), im Kalender
    im Detailfenster.
  - **Objekt → Einsätze:** Klick auf einen Termin öffnet dasselbe Detailfenster mit „Serie bearbeiten“ (Standard), „Nur diesen
    Tag umplanen / Vertretung / Ausfall“, Mitarbeiter, Löschen.
  - Tests: 412 Unit-/DB-Tests (neu `runde26.db.test.ts`), e2e zeit/login/planung/runde10/objektseiten/rechte grün.
- 2026-10-08: Runde 26, Paket C – Finanzen (Ahmed, Punkte 11–14, 26):
  - **Entwürfe:** Filter „Abrechnungsmonat“, „PDF aller Entwürfe“ (Monat, max. 300) und „PDF der Markierten“ – ein
    zusammengefügtes PDF zum Prüfen vor dem Ausstellen.
  - **Mahnwesen:** „Vorschau als PDF (Entwurf)“ in der Stapelverarbeitung und in den Offenen Posten: alle markierten
    Mahnungen mit Wasserzeichen ENTWURF, gleiche Stufen/Gebühren/Pauschale wie beim Erstellen, nichts wird gespeichert.
  - **Offene Posten neu (einfacher):** je Kunde eine aufklappbare Zeile (offen, überfällig, max. Tage), darin kompakte
    Tabelle (Rechnung, Datum, Fällig/Skonto, Tage, Betrag, bezahlt/verrechnet, offen, Zahlung erfassen aufklappbar);
    unten fest stehende Leiste: Zahlungen buchen / Mahnung als Vorschau / Mahnung erstellen.
  - **Preisanpassung:** zusätzlich „übrige Kosten erhöhen um %“ (Bezeichnung frei, z. B. Material- und Sachkosten):
    neuer Preis = alt + alt × Lohnanteil × Lohnerhöhung + alt × (100 % − Lohnanteil) × Sachkostenerhöhung (einmal
    kaufmännisch auf Cent gerundet). Fehlt der Lohnanteil, kann ein **angenommener Anteil** für den Lauf gesetzt werden
    (gelb „angen.“ in der Vorschau, im Lauf festgehalten `price_adjustment_items.labor_assumed`); dauerhaft nachtragen
    weiter unter „Lohnkostenanteil fehlt“ (jetzt unten). Formular oben, Vorschau direkt darunter. Anschreiben nennt
    Lohn- und Sachkostenerhöhung getrennt. Migration `20261113000004`.
  - Lohnabrechnungen einlesen: jetzt unter **Transfer** (Adresse unverändert `/personal/lohnabrechnungen`).
- 2026-10-08: Runde 26, Paket D – Personal (Ahmed, Punkte 1, 19, 22, 27, 29):
  - **Word-Vorlagen: Kästchen und Lücken** (`src/services/word-form.ts`): Word-Kontrollkästchen (w14:checkbox), ☐-Zeichen
    und Lücken „____“ erscheinen auf der Ausfüll-Seite mit dem Text daneben (Reihenfolge wie im Dokument) – ankreuzen bzw.
    ausfüllen, z. B. „keine Schwerbehinderung“ / „Grad: 50“. Vorbelegt, was sicher bekannt ist: Vollzeit/Teilzeit/Minijob,
    unbefristet/befristet bis (+ Datum), ungekündigt. Leere Lücken bleiben Linie.
  - **Urlaubskonten/Krankheitstage aus Fortytools** (Transfer → Import aus Fortytools, Excel): Stand zum Stichtag je
    Personalnummer in `app.leave_openings` (Resturlaub, Anspruch, genommen, verfügbar, Krankheitstage). Urlaubskonto rechnet
    ab dem Folgetag mit App-Abwesenheiten weiter (nichts doppelt); verfallener Resturlaub so wie Fortytools („verfügbar“).
    Probe mit Ahmeds Dateien: 219 Konten (1 Personalnummer 1382 nicht in der App), 28 Krankheitsstände; Werte = Fortytools.
    Krankheitstage-Auswertung mit Spalte „übernommen“. Fortytools liefert keine einzelnen Tage → Kalender bleibt dafür leer.
  - **Unterweisungen:** Liste mit Fortschrittsbalken, Frist (überfällig rot), Aktiv/Beendet; „Löschen“ ohne Unterschrift
    (ganz weg, Protokoll), mit Unterschriften nur „Beenden“ (offene zurückgezogen, Nachweise bleiben – Beweis § 12
    ArbSchG), „Wieder aktiv“. Migration `20261113000006` (Trigger erlaubt Löschen nur über `app.purge`).
  - **Urlaubskalender neu:** standardmäßig nur Personen mit Abwesenheit („alle Mitarbeitenden“ zuschaltbar), farbige
    durchgehende Balken je Art (anklickbar = ändern), heute markiert, Kennzahlen (heute abwesend, Urlaubs-/Krankheitstage,
    offene Anträge), Leerhinweis.
  - **Arbeitsschein:** Leistungsauswahl nur am Arbeitsdatum gültige Leistungen mit Leistungsart und Einheit; hat das
    Objekt keine eigenen Leistungen, stehen die der anderen Objekte des Kunden zur Auswahl (vermutlich Ahmeds Fall: leere
    Liste), sonst klarer Hinweis.
- 2026-10-08: Runde 27 (Ahmed, 7 Punkte):
  - **Bestellnummer je Leistung** (`site_services.order_reference`, Migration `20261113000007`): Monatslauf und
    Vorfaktura übernehmen sie – alle Leistungen einer Rechnung gleich → Rechnungskopf (BT-13), verschieden → je Position
    „Bestellnummer: …“ im Text; ohne eigene gilt weiter Gruppe/Objekt.
  - Rechnungsentwurf: gelber Balken „Entwurf – noch änderbar“ mit **„✎ Entwurf bearbeiten“**, Link an „Positionen“ und je
    Entwurf in der Entwurfsliste.
  - Startseite: Rechnungsentwürfe mit „×“ löschbar (Rückfrage, zurück auf die Startseite).
  - Einsatzkalender/Zeiten: Bordeaux statt Blau (geplant hell-Bordeaux, bestätigt Bordeaux, Feiertage gold), auch
    Objekt-Kalender.
  - **Umsatz-Vorschau** mit „nicht monatliche Leistungen wie im Vorjahr“: je Vorschau-Monat der Umsatz derselben
    Leistungsarten im Vorjahresmonat (eigene + Fortytools-Rechnungen nach Leistungszeitraum); Leistungsarten wählbar,
    Vorgabe = ohne laufende Monatspauschale, ohne Fahrzeugverkauf/Material. Probe echte Daten: 3,65 Mio. regelmäßig +
    1,30 Mio. wie Vorjahr. Schätzung, kein Auftragsbestand.
  - Google-Play-Entwicklerkonto angelegt (Ahmed). Anleitung „Zugangsdaten auf dem Server eintragen“
    (`docs/anleitung-server-eintragen.html/.pdf`: KVM-Konsole/ssh, `nano /opt/viva/deploy/.env.live`, `update.sh`).
- 2026-10-08: **Fund Server-Fehler „column dunning_emails does not exist“** (Rechnungsgruppe speichern): Die Spalte war in
  Runde 3b an die schon eingespielte Migration `20261029000001` angehängt worden – Server, die sie vorher hatten, bekamen
  sie nie. Nachtrag `20261113000008` (`add column if not exists`). Einziger solcher Fall (alle Migrationen gegen ihren
  ersten Commit geprüft). **Schutz:** `supabase/migration-checksums.json` + Test `migration-checksums.test.ts` – geänderte
  alte Migration = Test rot; neue Migration → `node scripts/migrations-lock.mjs`.
- 2026-10-08: **Rechnungsgruppen übersichtlicher** (Ahmed: „schlecht gelöst“): Übersicht als Karten je Gruppe (Rechnung an,
  Format/Versand, E-Mail – fehlt rot, Leitweg-ID, Zahlung/Skonto, Bestellnr., Objekte eingeklappt), Bearbeiten ohne die
  Liste darüber („← alle Gruppen“), im Formular nur „n Objekte“ + „Weitere Objekte in diese Gruppe holen“ (eingeklappt, Suche)
  statt 66 ausgegrauter Häkchen. Neu **„Objekte den Gruppen zuordnen“**: Tabelle aller Objekte mit Gruppen-Auswahl je
  Zeile, Suche, einmal speichern (`setSiteInvoiceGroup`, Protokoll). `e2e:rechnungsangaben` 13 Prüfungen.
- 2026-10-08: **Arbeitsschein und NU-Bestellschein wie die alte App** (Ahmeds PDFs AS-2026-1024/1028, BE-2026-0001): neuer
  Baustein `src/pdf/form-doc.ts` (Briefpapier, Bordeaux-Titel mit Linie, grauer Infokasten mit Bordeaux-Strich, Kunden-/
  Objektanschrift, Abschnittsbalken, Tabellen, Unterschriftslinien, senkrechte Kennung „… · Seite x von y“).
  Arbeitsschein: Datum/Zeit/Kostenstelle/Abrechnung/Auftrag, Positionen, Regie-/Stundennachweis mit Gesamt, Abnahmesatz +
  Unterschrift (zusammen gehalten). Bestellschein an Nachunternehmer (5 Seiten): Auftragnehmer [Nr.], Kasten Objekt/Adresse/
  Häufigkeit/Kostenstelle/Leistungsart/Zeitraum/Status/Stundensatz bzw. Preis/Gesamtbetrag/Bestelldatum, Kurzfassung der
  Bedingungen + Unterschrift; Leistungsbeschreibung; Auftragsbedingungen 1–10 wörtlich (`src/domain/subcontract/conditions.ts`);
  Bestätigung mit Unterschrift. Bereits archivierte Arbeitsschein-PDFs bleiben unverändert (write-once).
- 2026-10-08: **Rechnungs-PDF neu geordnet** (Ahmed: „das Objekt sollte woanders stehen“): Objekt steht nicht mehr in jeder
  Position, sondern als „Leistungsort / Objekt“ rechts neben der Anschrift; der gemeinsame Leistungszeitraum steht im
  Infoblock (Pflichtangabe § 14 Abs. 4 Nr. 6 UStG), abweichende Zeiträume weiter an der Position. Sammelrechnung:
  Zwischenüberschrift je Objekt (fett, mit Adresse) und „Summe <Objekt>“ ab zwei Positionen. Zusatztexte der Position
  grau und kleiner, weniger Leerraum über der Tabelle. Nur Darstellung (`splitLineDetail` in `src/pdf/render.ts`) – gespeicherte
  Positionstexte und E-Rechnung (BT-127) unverändert, bereits archivierte PDFs bleiben wie ausgestellt. Angebote mit
  Betreffzeile „Objekt: …“ wie bisher. PDF/A: nur Text/Flächen mit eingebetteten Schriften – `npm run check:pdfa` auf
  einem Rechner mit Docker wiederholen.
- 2026-10-08: Ahmed will **jetzt live gehen** (alle sollen die neue App nutzen). Bankabruf: eigene PSD2-Schnittstelle
  braucht BaFin-Erlaubnis (Kontoinformationsdienst, § 34 ZAG) → nicht sinnvoll; Optionen Qwist (lizenziert, einfach),
  EBICS (Bankvertrag, für Firmen gedacht), bis dahin CAMT-Upload. Empfehlung: Qwist.
- 2026-10-08: **Stichtag Umstellung = 08.10.2026** (Ahmed). Anleitung `docs/umstellung-heute.html/.pdf` (Qwist → Fortytools
  abschließen → Importe → Mailtest → `APP_ENV='live'` **und Zeile `MAIL_TEST_RECIPIENT` löschen** (sonst gehen auch im
  live-Betrieb alle Mails an die Testadresse, `isMailRedirected`) → Benutzer/PINs → Sicherheit). Qwist lief über den
  Partnervertrag von Fortytools – Bankfreigabe nicht übertragbar; Ahmed fragt Qwist-Connect-API (Client-ID/Secret, Sandbox,
  Doku) an, verbindet die Konten später selbst im Qwist-Fenster. **Qwist-Abruf ist noch nicht gebaut** – erst mit Doku.
  Fortytools nicht kündigen, bevor alte Rechnungen (PDF/XML) für 10 Jahre gesichert sind.
- 2026-10-08: Rechnungskopf neu (Ahmed: „Leistungsort weiter runter, alles hingeklatscht“): grauer Balken nur Datum,
  Kundennummer, Seite; darunter Raster in 3 Spalten (Leistungsort/Objekt fett mit Adresse, Leistungszeitraum, Leitweg-ID,
  Lieferanten-Nr., Bestellnummer, Ihre Referenz) mit feiner Linie. Gilt auch für Angebote (Objekt aus der Betreffzeile,
  Ansprechpartner, Gültig bis) und Auftragsbestätigungen. Rechnungsentwurf: Einleitungstext mit Standardtext vorbelegt,
  Kasten „Text auf der Rechnung“ (Einleitung, Schlusssatz) in der Entwurfsansicht. Standardtexte als Konstanten
  `INVOICE_INTRO_DEFAULT`/`INVOICE_CLOSING_PAY` in `src/pdf/render.ts`.
- 2026-10-08: Rechnungskopf (Ahmed): Angaben unter dem Balken in **einer Zeile**, Spaltenbreite nach Inhalt, Leistungsort
  bekommt den Rest und bricht um (Leitweg-ID bricht notfalls am Bindestrich), Schrift wird bei vielen Angaben bis 7 pt kleiner,
  Zeitraum kurz „01.09.–30.09.2026“. „Lieferanten-Nr.“ heißt „Unsere Lieferantennr.“ (unsere Nummer beim Kunden).
  **Strich unter der Absenderzeile** in allen Briefen auf Briefpapier (Rechnung, Angebot, AB, Mahnung, Briefe).
  Server-Fehler „unterminated quoted value“ in `.env.live` Zeile 18 (MAIL_FROM ohne schließendes Hochkomma): Anleitungen
  empfehlen jetzt `MAIL_FROM='buchhaltung@viva-deluxe-reinigung.de'` (ohne Name/spitze Klammern).
- 2026-10-08: **Fund Server: „E-Rechnung kann nicht erzeugt werden: validation failed“** (auch bei PDF-Kunden – die E-Rechnung
  wird immer für Archiv/ZUGFeRD erzeugt und vor dem Ausstellen geprüft). Die Bibliothek nannte das Feld nicht. Jetzt
  `src/einvoice/errors.ts`: Meldung nennt das Feld auf Deutsch („Land der Rechnungsanschrift“, „Einheit einer Position
  (Position 2)“, „Fälligkeitsdatum“ …). Bereinigung vor dem Erzeugen: Ländercode („Deutschland“/„de“/leer → DE) und
  Einheiten als Text („Std.“, „m²“, „psch.“, leer → Code). Ursache auf dem Server noch offen – Ahmed schickt die neue Meldung.
- 2026-10-08: Runde 28 (Ahmed, Fortytools-Screenshots):
  - **Entwurfsliste wie Fortytools:** links kompakte Liste (Datum/Typ, Empfänger als Link + Kundennr., darunter Objekt(e) mit
    Adresse und Leistungszeitraum, PDF, Pos, Netto, Brutto, Löschen je Zeile), Summenzeile gelb, unten Alle auswählen /
    Datum setzen / Vorschau / Ausgewählte fertigstellen / Löschen. Rechts: Entwürfe je Monat (Link = Filter), **Aus
    Einzelleistungen erstellen** je Kunde aufklappbar → je Objekt mit Betrag → Einzelleistungen mit Datum und Betrag,
    Monatslauf. `draftListInfo()` (Positionen, Empfänger aus eigener Anschrift/Gruppe/Kunde, Objekte auch bei Sammelrechnung).
  - **Entwurf als Brief** (`pages-invoice-letter.tsx`): Blatt mit Absender (unterstrichen), Anschrift, grauem Balken
    „Rechnung (Entwurf)“, Leistungsort/Zeitraum/Leitweg-ID/Bestellnr., Anrede + Text, Positionen (je Objekt gruppiert wie im PDF),
    Summen, Zahlungsbedingung, Schlusssatz; rechts Knöpfe Bearbeiten / Fertigstellen / PDF-Vorschau / KoSIT / Kopieren /
    Lieferschein / Löschen, Rechnungsdatum, Anhänge, Versand. Storno-/Korrektur-Entwürfe und ausgestellte Rechnungen wie bisher.
  - **Fund:** PDF-Vorschau eines Entwurfs setzte die Fälligkeit = heute („ohne Abzug bis heute“). Jetzt `loadDraftPreview()`:
    Rechnungsdatum (geplant oder heute) + Zahlungsziel (Rechnung, sonst Gruppe/Objekt/Kunde).
  - App-Paketname für Google Play/App Store: **`de.vivadeluxe.app`** (eine App für Mitarbeitende und Büro; vorher
    `de.vivadeluxe.mitarbeiter`, noch nie hochgeladen). Nach dem ersten Upload nicht mehr änderbar.
  - Qwist: Server-Einträge `QWIST_CLIENT_ID/SECRET` werden von der App noch nicht gelesen (kein Abruf gebaut, keine
    öffentliche API-Doku gefunden) – Ahmed fragt bei Qwist die Partner-/API-Dokumentation an.
- 2026-10-08: **Fund „E-Rechnung … cac:AccountingCustomerParty/cac:Party“** (Kunde 20167 „Viva-Deluxe … (Büro) / Zeiterfassung
  Büro“ aus Fortytools): XRechnung verlangt eine elektronische Adresse des Empfängers (BT-49: Leitweg-ID oder E-Mail).
  Jetzt: Format „PDF“ ohne E-Mail/Leitweg-ID → nur PDF (keine E-Rechnung, Versand per Post); sonst klare Meldung „Rechnungs-
  E-Mail bzw. Leitweg-ID fehlt (Kunde → Rechnungsgruppen)“. Kunden-Häkchen **„Interner Bereich – nie Rechnungen“**
  (`customers.is_internal`, Monatslauf/Entwürfe/Ausstellen gesperrt). Ahmed: bei 20167 Häkchen setzen, Entwurf löschen.
  **Rechtlich:** PDF ohne E-Rechnung an inländische Firmenkunden nur noch bis Ende 2026 (Übergang; ab 2027 Pflicht bei
  > 800.000 € Vorjahresumsatz) – Rechnungs-E-Mails nachtragen.
- 2026-10-08: Bankabruf über **Enable Banking** (statt Qwist, sofort ohne Vertrag; Restricted Production = eigene Konten).
  Ahmed legt die Anwendung an (Production, Schlüssel im Browser erzeugt, Redirect
  `https://app.viva-deluxe-reinigung.de/transfer/bank/rueckkehr`). Einbau folgt.
- 2026-10-08: **Bankabruf Enable Banking gebaut** + Kontoumsätze wie Fortytools („Neue Umsätze zuordnen“, Ahmeds Screenshots):
  - Einstellungen → Bankabruf (nur Admin): Application ID + .pem hochladen; Schlüssel AES-256-GCM verschlüsselt in
    `app.bank_feed_config` (Schlüssel aus SESSION_SECRET – ändert sich SESSION_SECRET, neu hochladen), keine Lese-Policy.
    JWT RS256 (`kid` = App-ID). „Bank verbinden“ → `/auth` (Gültigkeit bis 180 Tage bzw. Höchstwert der Bank) → Rückkehr
    `/transfer/bank/rueckkehr` (state geprüft, Code einmal) → `/sessions` → Konten (`bank_feed_accounts`, nur eigene IBANs
    aus Firmendaten aktiv). Abruf: Kontostand (`/balances`, CLBD bevorzugt) + Umsätze (`/transactions`, Seiten, nur BOOK,
    erster Abruf 90 Tage, danach ab letztem Buchungstag − 10 Tage), Rohdaten write-once im Archiv, Import-Format `api`.
    ID aus dem Inhalt (nicht aus der Bank-Referenz) → doppelt abrufen legt nichts doppelt an; schon per CAMT/CSV
    eingelesene Umsätze werden erkannt. Automatisch alle 30 Min. geprüft, 6–21 Uhr, je Konto höchstens alle 4,5 Std.
    (PSD2: max. 4 Abrufe/Tag ohne TAN). Abgelaufene Freigabe → Hinweis (14 Tage vorher gelb).
  - **Neue Umsätze zuordnen:** Kontenwahl mit Anzahl offener, Vorschlag rechts (Kunde/Nr., Betrag, Rechnung, Datum, sicher/
    wahrscheinlich/prüfen) mit grünem „✓ Zuordnen“ + ✎; ohne Vorschlag Kunde / Lieferant / Mitarbeiter / Nicht zuordnen.
    Vorschläge jetzt auch für **Fortytools-Rechnungen** (Zahlung in `legacy_payments` mit `bank_transaction_id`, Rechnung
    bezahlt), über **Konto des Kunden** (`customer_bank_accounts`), für **Eingangsrechnungen** im Ausgang (Rechnungsnummer im
    Zweck, IBAN des Lieferanten, Betrag mit/ohne Skonto; auch schon von Hand „bezahlt“ festgehaltene werden verknüpft) und
    für bekannte IBANs von Lieferanten/Mitarbeitern. Mitarbeiter/Kunde/Lieferant **ohne Rechnung** = erledigt ohne Buchung
    (`assigned_kind/assigned_id`, wieder öffnen möglich). „sichere Vorschläge zuordnen“ in einem Klick; „Ältere Umsätze
    abhaken“ bis Datum (vor der Umstellung in Fortytools zugeordnet). Reiter Neu / Erledigt / Alle, 40 je Seite.
  - **Transfer → Kontoauszug**: Konto, Zeitraum, Filter, errechneter Anfangs-/End-Saldo (rückwärts aus dem Kontostand der
    Bank), Eingänge/Ausgänge, Saldo-Verlauf 12 Monate (30-Tage-Durchschnitt), Drucken/PDF. Startseite: Karte **Bankkonten**
    (Kontostand je Konto, Summe, „n neu“).
  - Migration `20261114000001_bankabruf.sql`. Tests: `bank-feed.db.test.ts` (Schlüssel, JWT, Verbinden, Abruf mit Seiten,
    Dubletten, Fortytools-Rechnung, Eingangsrechnung, Mitarbeiter, Salden), `e2e:transfer` 14 Prüfungen.
  - Anleitung `docs/anleitung-bankabruf.html/.pdf`; `docs/umstellung-heute` Punkt 1 auf Enable Banking umgestellt.
    **Ahmed: Schlüssel unter Einstellungen → Bankabruf hochladen, Banken verbinden, „Ältere Umsätze abhaken“ bis 07.10.**
- 2026-10-08: **Kontoumsätze: alles erkennen** (Ahmed: Rechnungseingang über Nummer bezahlt, Skonto-%, Verrechnung,
  Nicht zuordnen, Schnellanlage Lieferant, Ausgaben-Diagramme):
  - Eingangsrechnungen: Nummer im Verwendungszweck auch anders geschrieben (nur Buchstaben/Ziffern verglichen, ab 4 Zeichen),
    Lieferant auch über IBAN oder Namen (erstes kennzeichnendes Wort); auch noch **nicht freigegebene** Rechnungen (werden beim
    Zuordnen mit freigegeben). **Skonto** = Differenz bis 5 % (vereinbart oder nicht), „sicher“ bei Nummer + rundem Prozentsatz.
    **Verrechnung**: kleinste Auswahl (bis 14 Posten) offener Rechnungen und Rechnungskorrekturen (Minusbeträge) desselben
    Lieferanten, deren Summe genau dem Betrag entspricht; Korrektur → bezahlt mit negativem Zahlbetrag, Zahlart „Verrechnung“
    (Migration `20261114000002`: Prüfregel `paid_amount_cents` erlaubt Minus bei Minus-Rechnungen).
  - Kunden: Skonto-Abzug ohne Vereinbarung (bis 5 %) als Vorschlag „mit Skonto-Abzug x %“ (bei rundem % vor der
    Teilzahlung); Sammelzahlungen als Teilmenge der offenen Rechnungen; von Hand eingetragener Skonto erlaubt, wenn er die
    Rechnung ausgleicht (≤ 5 %). **Rechtlich:** nicht vereinbarter Skonto ist eine Kürzung – Restforderung bleibt bestehen,
    Ausbuchen ist eine Entscheidung (mindert USt nach § 17 UStG, Steuerberater).
  - Die App **lernt IBANs**: Kunde (`customer_bank_accounts`) und Lieferant (falls leer) nach jeder Zuordnung.
  - „Nicht zuordnen“ in jeder Zeile (auch mit Vorschlag); **Kostenart** (Material, Fahrzeuge/Tanken, Miete, Personal,
    Steuern, Versicherung, Bankgebühren, Privat …) bei „Nicht zuordnen“ und „Lieferant ohne Rechnung“
    (`bank_transactions.expense_category`). **Lieferant schnell anlegen** nur mit Namen (IBAN übernommen, nächste Nummer ab 70001).
  - **Auswertungen → Ausgaben** (wie die Statistik): Grundlage Kontoausgänge (brutto, Kostenart aus Eingangsrechnung bzw.
    Zuordnung, Mitarbeiter = Personal) oder Eingangsrechnungen (netto); Säulen mit Vorjahr, Tabelle mit Veränderung,
    Ringdiagramme nach Kostenart und Empfänger/Lieferant, Kennzahlen (Ø je Monat, Einnahmen − Ausgaben, größte Kostenart,
    offene Eingangsrechnungen), Schnellwahl 12 Monate / Jahr / Vorjahr / **Jahr für Jahr** (5 Jahre), CSV.
  - Tests: `bank-recognition.db.test.ts` (Skonto 3 % bei abweichender Schreibweise, Verrechnung mit Korrektur, Kunden-Skonto
    2 %, Schnellanlage, Kostenart, Ausgaben-Statistik).
- 2026-10-08: Rückmeldung Bankabruf (Ahmed):
  - **Fund Targobank nicht abgerufen:** Konten aus der Bank-Anmeldung wurden nur aktiv, wenn die IBAN unter Firmendaten
    stand. Die hinterlegte Targobank-IBAN `DE66 7019 0000 0003 1914 27` hat die Bankleitzahl der Münchner Bank (70190000),
    Targobank wäre 30020900 (Fortytools zeigt Konto 5310569341) → **IBAN unter Firmendaten prüfen, sie steht auf jeder
    Rechnung.** Jetzt gelten alle Konten der Anmeldung als eigene Konten (Migration `20261114000003` aktiviert sie), Hinweis
    „Konto aus der Bank steht nicht unter Firmendaten“.
  - **„Alle n nicht zuordnen“** oben in der Liste (bucht nichts, unter „Erledigt“ wieder zu öffnen).
  - **Zuordnen direkt in der Zeile wie Fortytools:** Kunde / Lieferant / Mitarbeiter (und ✎) öffnen sich in der Zeile:
    Auswahl (vorbelegt über IBAN bzw. Rechnungsnummer), offene Rechnungen zum Ankreuzen (vorbelegt, wenn die Nummer im
    Verwendungszweck steht), Summe/Saldo/% rechnet mit, „Komplett bezahlt (Differenz als Skonto)“ (≤ 5 %), Zuordnen /
    Abbrechen; „ohne Rechnung zuordnen“, Lieferant „+ als neuen Lieferanten anlegen“. Ohne JavaScript bleiben die Seiten.
    Kunde: angekreuzte Rechnungen werden der Reihe nach bezahlt (`/auswahl`), Überzahlung abgelehnt.
  - **Ausgaben: Kostenart automatisch** (Ahmed: „DEVK ist klar Versicherung, Nachunternehmer usw.“): Schlüsselwörter für
    Versicherung, Steuern/Abgaben/Sozialversicherung, Fahrzeuge/Tanken, Material, Miete/Büro, Bankgebühren, Personal
    (`guessCategory`), Nachunternehmer über Lieferant (Art „nachunternehmer“, auch per IBAN), Mitarbeiter-IBAN → Personal.
    Umschalter „Kostenart: automatisch erkennen / nach Zuordnung“; eine von Hand gewählte Kostenart geht immer vor.
    Zeitraum bleibt frei wählbar (Ahmed).
- 2026-10-08: Runde 29 (Ahmed, 4 Punkte + „Seite lädt langsam“):
  - **Langsam (Kontoumsätze):** Die Fortytools-Sicht `legacy_open_items` lief ohne Index auf `ft_root_id` (~0,6 s) und wurde
    je Umsatz-Zeile neu abgefragt. Jetzt einmal je Seite (Vorschlags-Cache) + Indizes (Migration `20261114000004`) → ~3 ms.
  - **Entwürfe → Einzelleistungen** je Monat des Leistungszeitraums aufklappbar; maßgeblich ist das **Ende**
    (31.10.–03.11. → November), neuester Monat oben/offen, Häkchen je Monat/Kunde/Zeile.
  - **Entwurf direkt bearbeiten:** in der Briefansicht Anschrift, Einleitung, Positionen und Schlusstext anklickbar →
    Editor an der passenden Stelle (Anschrift klappt „Rechnungsadresse nur für diese Rechnung“ auf).
  - **Anschrift nach DIN 5008:** Anschriftfeld 80 mm, lange Zeilen umbrochen, höchstens 6 Zeilen (sonst 9 pt bzw. ohne
    Ansprechpartner) – gilt für alle Briefe auf Briefpapier (`addressLines` in `src/pdf/render.ts`).
  - **Ausgestellte Rechnung: „Name / Adresse ändern“** = berichtigte Fassung (wie bisher „Adresse ändern“, jetzt auch Name);
    Kunde, Objekt und Kostenstelle bleiben. **Rechtlich § 31 Abs. 5 UStDV:** nur derselbe Empfänger – anderer Empfänger =
    Storno + neue Rechnung.
  - **Monatsauswahl überall wie Fortytools:** jedes Monatsfeld wird zu zwei Auswahllisten Monat + Jahr (`monthPick` in
    `src/web/client.ts`, das echte Feld bleibt versteckt → Formulare unverändert).
  - **XRechnung ohne Leitweg-ID:** Rechnungsgruppe/Kunde mit Format XRechnung braucht Leitweg-ID **oder** Rechnungs-E-Mail
    (bzw. Portal). Ohne Leitweg-ID: Empfängeradresse BT-49 = E-Mail, Käuferreferenz BT-10 = Kundennummer – KoSIT-gültig
    (Test). Behörden brauchen weiter ihre Leitweg-ID.
- 2026-10-09: Runde 30 (Ahmed, 11 Punkte):
  - Kontoumsätze: neueste oben, innerhalb eines Tages stabil (Valuta, Abrufzeit) – Liste „Zuordnen“ und Kontoauszug.
  - **Einmalige Leistungen mehrfach verrichten** (je Ausführung mit eigenem Datum; Sperre „schon verrichtet“ entfällt).
  - Angebote: Statistik mit Zeitraum **Dieser Monat / Letzter Monat / Quartal / Jahr / 12 Monate**; angenommen/abgelehnt
    nach Tag der Entscheidung (`decided_at`), offene nach Angebotsdatum.
  - Symbole: farbige Emojis (🗑 ⚠ 📄 📎 ⏰ ⚙ ✍ 🔔 ☺ …) durch einheitliche Strich-Symbole (`Icon`) ersetzt; PDF-Knopf in den
    Entwürfen als Symbol; Mitarbeiter-Tags als ruhige helle Schilder (keine grauen Großbuchstaben-Klötze), Adresse mit
    „Karte“-Link; rechte Spalte der Entwürfe lief über den Rand.
  - **4,33 Wochen je Monat** (Ahmed): Soll = Wochenstunden × 4,33 je Monat, angebrochene Monate anteilig nach
    Kalendertagen (`src/domain/time/soll.ts`) – Dispo, Kalender, Arbeitszeitkonto, Stundenvorgabe (Monat = Woche × 4,33).
    Abwesenheitsstunden je Tag bleiben Wochenstunden ÷ 5.
  - **Erfasste Zeit löschen ohne Begründung** (Admin/Personal): Papierkorb im Kalender-Detail und in der Liste, Grund
    freiwillig; Stand weiter im Löschprotokoll. **Rechtlich:** echte Arbeitszeiten 2 Jahre aufbewahren (§ 17 MiLoG).
  - **NU-Bestellschein auf 2 Seiten**: Seite 1 Auftrag + Leistungsbeschreibung, Bedingungen zweispaltig (ausgeglichen),
    eine Unterschrift für Bestellung + Bedingungen (`FormDoc.columns`).
  - **Unterweisungen endgültig löschen** auch mit Unterschriften (nur Admin, für Tests; Papierkorb neben „Beenden“).
    Stand vorher ins audit_log, PDFs bleiben im Archiv. Migration `20261115000001`.
  - **Soll als Ist automatisch nach 2 Tagen** (Zeiterfassung → Einstellungen, 1/2/3/5/7 Tage oder aus): Einsätze ohne
    Zeit werden stündlich mit Plan-Zeiten übernommen (nicht bei Abwesenheit/Ausfall/Feiertag/Überschneidung), Akteur
    „automatisch“, nur Einsätze ab dem Einschalttag (09.10.2026, kein Auffüllen alter Monate). Migration
    `20261115000002`. **§ 17 MiLoG:** abweichende tatsächliche Zeiten müssen korrigiert werden.
  - **Vorab-Lohnabrechnung** (Stundenliste & Lohnarten → Lohnarten, „Vorab-Abrechnung“): Ist bis Stichtag + geplante
    Einsätze bis Monatsende (mit Zuschlägen). Jeder „CSV Lohnprogramm“-Export wird festgehalten (`payroll_exports`, nur
    anhängen, Migration `20261115000003`); im Folgemonat enthält die CSV Zeilen „<Monat> Korrektur“ mit der
    Stunden-Differenz (auch minus), auf der Seite aufklappbar.
  - **Tiefgaragen-Aushang** auf dem Briefpapier mit Logo: Bordeaux-Titelband, Termine als Karten, gelber Hinweiskasten,
    Haftungsausschluss.
- 2026-10-09: Runde 31 (Ahmed, 9 Punkte):
  - **Nachkalkulation & Kostenstellen sind eine Seite** (Auswertungen → Nachkalkulation & Kostenstellen; `/auswertungen/
    kostenstellen` leitet um). Fund: Die Nachkalkulation zählte nur aktive Objekte, nur einen Monat und nur eigene
    Rechnungen (Erlös aus Fortytools-Rechnungen fehlte → überall 0 €), allgemeine Kostenstellen fehlten; die Kostenstellen-
    Auswertung rechnete anders. Jetzt: Zeitraum von–bis, Erlös aus eigenen + übernommenen Rechnungen (je Position dem
    Objekt zugeordnet, Leistungszeitraum), jedes Objekt mit Erlös, Zeiten oder Kosten im Zeitraum (auch inaktive – z. B.
    Nachunternehmer ohne Erlös, Hinweis „Kosten ohne Erlös“), darunter die allgemeinen Kostenstellen, Ergebnis gesamt und
    Liste „Eingangsrechnungen nicht (vollständig) zugeordnet“.
  - **Objekte mehrere auf einmal aktiv/inaktiv** (Objektliste: Häkchen je Zeile, „alle auf dieser Seite“, Protokoll).
  - **Angebote: Zuschlagsquote zusätzlich nach Umsatz** (angenommener ÷ entschiedener Wert; Monatspauschalen × 12).
  - **Offene Posten: „✓ bezahlt“ je Rechnung** (voller offener Betrag, Datum oben, auch Fortytools-Rechnungen). Normalfall
    bleibt die Zuordnung der Kontoumsätze – Abhaken nur für Bar-/Sonderfälle, sonst doppelte Zahlung.
  - **NU-Bestellung: Standard-Leistungsbeschreibung** je Leistung (wie alte App; wird beim Wechsel eingesetzt, solange
    nichts Eigenes drinsteht; `SERVICE_DESCRIPTIONS`).
  - **Rechnungsverfolgung je NU-Bestellung:** Bestellungen-Liste Spalte „Abrechnung“ (laufender Zeitraum, z. B. „10/2026
    läuft“, „09/2026 fehlt“, Anzahl Zeiträume ohne Rechnung); in der Bestellung Tabelle je Zeitraum (bis 24) mit
    abgerechnet (Link zur Eingangsrechnung, Betrag) / keine Rechnung (Grund) / fehlt / läuft noch, „Rechnung erfassen“,
    „keine Rechnung …“ (`billingTracking`).
  - **Zeit löschen im Kalender** auch bei Zeiten ohne Einsatz (grüne Balken) und im Objekt-Kalender (Admin/Personal).
  - **Einsätze für abwesende Mitarbeiter:** „Nicht notwendig“ und **Nachunternehmer-Bestellung** (erteilte Bestellungen,
    die des Objekts zuerst) wählbar → Tag gilt als Ausfall mit Vermerk, Bestellung an `shift_exceptions.subcontract_id`
    (Migration `20261116000001`).
  - **Kassenbuch-PDF neu wie übliche Kassenbuch-Vordrucke** (Ahmed: „online anschauen, unten brauchst du nichts, nur
    oben Logo, quer geht auch“): A4 quer, kein Briefpapier, nur Logo + Titel/Firma/Zeitraum oben, Kopfkasten
    Anfangsbestand + Einnahmen − Ausgaben = Endbestand, Spalten Lfd. Nr. · Datum · Beleg-Nr. (✓ = Beleg archiviert) ·
    Buchungstext · Kategorie · Einnahmen · Ausgaben · Bestand, „Übertrag“ am Seitenende/-anfang, Summe Monat,
    Kassensturz, Stornos kompakt, Hinweis § 146 AO, drei Unterschriftslinien (`src/pdf/cashbook.ts`).
  - Tests: neu `runde31.db.test.ts`, `src/pdf/cashbook.test.ts` (Übertrag/quer), Rechnungsverfolgung in `expected-invoices.db.test.ts`.
- 2026-10-09: **NU-Bestellung am Handy unterschreiben** (Ahmed: „Scan-Knopf hässlich, NU in meiner App unterschreiben
  lassen“): In der Bestellung „Am Handy / Tablet unterschreiben lassen“ (nur erteilte), in der App Verwaltung → Formulare →
  „NU unterschreiben“ (Liste erteilter Bestellungen ohne Unterschrift; nicht für Objektleitung). Seite mit PDF-Link, Preis,
  Beginn, Annahmeerklärung, Name + Unterschrift (Finger). Ergebnis: Bestellschein mit eingesetzter Unterschrift und
  Vermerk „elektronisch unterschrieben von … am … um …“, PDF + Unterschrift-PNG write-once, als unterschriebener Auftrag
  hinterlegt, genau einmal (`signSubcontract`). Scan-Upload bleibt eingeklappt für Papier. Einfache elektronische
  Signatur = Beweismittel für die Annahme, keine Schriftform. Datei-Feld-Stil global repariert (Knopf war abgeschnitten).
- 2026-10-09: **Datei-Felder überall neu** (Ahmed: „Choose File“-Knopf hässlich): jedes Datei-Feld wird im Browser zu einem
  deutschen Ablagefeld (Upload-Symbol, „Datei auswählen – oder hierher ziehen · PDF, ZIP“, nach Auswahl Dateiname + Größe,
  × zum Entfernen). Das echte Feld liegt unsichtbar darüber → Formulare, Pflichtfeld-Prüfung, Ziehen & Ablegen bleiben
  (`filePick` in `client.ts`, CSS `.fpick`). Ausgenommen: versteckte Felder, Felder in eigenen Knöpfen (label) und die
  großen Upload-Zonen.
- 2026-10-09: **Arbeitsscheine** (Ahmed): **Datum von – bis** bei mehrtägigen Arbeiten (`work_reports.work_date_to`);
  Regiestunden mit **Datum je Zeile** (`work_report_lines.line_date`, muss im Zeitraum liegen) und **„Kopieren“** (gleiche
  Zeile für den nächsten Tag). PDF: „Zeitraum 05.10. – 07.10.2026“, Stundennachweis nach Datum sortiert; Abrechnung
  übernimmt das Datum je Stundenzeile als Leistungsdatum, sonstige Positionen den Zeitraum. **Entwurf löschen**
  (Verknüpfung Tiefgarage-Termin wird gelöst, Fotos bleiben im Archiv); **abgeschlossene stornieren** mit Grund (bleibt
  sichtbar, Schild „storniert“, PDF mit Wasserzeichen STORNIERT, nicht abrechenbar, danach unveränderbar). Bereits
  abgerechnete: erst Rechnung stornieren bzw. Entwurf löschen. Migration `20261116000002` (Trigger erweitert).
- 2026-10-09: **Fortytools-Zeitbericht importieren** (Ahmed: „Zeiten.csv wurde nicht erkannt“ – es ist eine Excel-Datei mit
  Endung .csv, anderer Bericht): Transfer → Import aus Fortytools → „Artikel und erfasste Zeiten“ erkennt jetzt auch den
  Zeitbericht (Art, Soll/Ist, Mitarbeiter als „Nachname, Vorname“, Einsatzort nur mit Namen). Einsatzzeit → freigegebene
  Zeit (Ist), Pause = Pausen-Zeilen innerhalb der Zeit bzw. Differenz zur Netto-„Dauer“ (Fortytools zieht die geplante Pause
  ab); Soll-Zeit → abgeleitete Einsätze (gültig ab erstem, bis letztem Vorkommen, wenn das > 2 Wochen vor Exportende liegt).
  Mitarbeiter über alle Namensteile (mehrteilige Nachnamen anders aufgeteilt), Objekt über Namen (gleichnamig → das Objekt
  mit Zuordnung/Einsatz der Person, sonst das erste des Kunden mit Hinweis), gekürzter Kundenname → Objekt „Allgemein“.
  Urlaub/Krankheit/Unbezahlt → genehmigte Abwesenheiten (Tage zusammengefasst, Lücken nur über Wochenende/Feiertag),
  Stunden je Tag aus „Dauer“ (`absence_hours`, „Krank ohne Abrechnung“ unbezahlt). Übernahme in Blöcken (~20.000 Zeilen
  in 5 s), feste IDs → nichts doppelt; schon übernommene September-Zeiten werden erkannt. Probe mit Ahmeds Datei
  (Jan–Sep 2026): 17.257 Zeiten, 360 Abwesenheiten, 542 Einsätze; Stunden je Monat = Datei (ohne 1013, 94 Überschneidungen).
  Buchungen nur auf den Kunden → je Kunde Objekt „Allgemein“ (Probe: 4 neu). **Ahmed prüfen:** 301 Zeiten „Flüchtlingsunterkunft“ (zwei
  gleichnamige Objekte Arnold-Sommerfeld-Str. 11/15) liegen auf 2010022.
- 2026-10-09: **Lohnart „Feiertag (Entgeltfortzahlung)“** (§ 2 EFZG, fehlte bisher): geplante Einsätze an Feiertagen ohne
  erfasste Zeit/Abwesenheit/Ausfall → bezahlte Stunden in Lohnarten und Lohnprogramm-CSV. Fortytools-Zeilen
  „Feiertagslohnfortzahlung“ werden deshalb nicht importiert. Lohnart-Nummer unter Einstellungen → Zuschläge & Lohnarten.
- 2026-10-09: **Einsätze Ausgetretener** zählen bis zum Austrittstag (vorher fehlte das Soll früherer Monate komplett,
  importierte Zeiten erschienen als „ohne Einsatz“).
- 2026-10-09: **Nachkalkulation:** importierte Zeiten zählen als Ist-Stunden (status freigegeben). Urlaub/Krank werden
  bewusst nicht zusätzlich als Lohnkosten gerechnet – das deckt der Lohnzuschlag (26–32 %) ab; sonst doppelt.
- 2026-10-09: **Rechnungen vor der Umstellung ohne Import-Kennzeichen** (Ahmed: „wie originale Dateien“): gleiche Adresse
  `/rechnungen/<id>` (alte `/rechnungen/fortytools/…` leiten um), Ansicht = PDF-Blatt + Angaben/Status/Zahlung, in der
  Rechnungsliste von Kunde/Objekt (Zähler, Monatsübersicht) zusammen mit den eigenen, „versendet“, Kunden-Offene-Posten in
  einer Tabelle; Kästen „Frühere Rechnungen“ / „Offene Rechnungen vor der Umstellung“ entfallen. Liste beim Kunden zeigt
  die neuesten 60 („alle anzeigen“). **§ 14c UStG bleibt:** diese Rechnungen nicht erneut versenden.
- 2026-10-09: Runde 32 (Ahmed, 5 Punkte):
  - **Einsatz „Auch an Sonn- und Feiertagen arbeiten“** (Häkchen in „Termin oder Terminserie planen“, Standard aus;
    `shift_plans.holiday_work`, Migration `20261117000001`): ohne Haken ist der Feiertag frei (bezahlter Feiertag, nicht
    in Soll/App/Vorab-Lohn) und es gibt **keine Sonn-/Feiertagszuschläge** – auch nicht für Zeiten, die trotzdem an dem
    Tag erfasst sind (Lohnarten zeigen „x Std. Sonn-/Feiertag ohne Zuschlag“ als Hinweis). Sonntags-Einsätze haben den
    Haken immer (Bestand per Migration gesetzt). Nachtzuschlag gilt unabhängig davon. Zuschlagsrechnung: Satz 0 = gilt
    nicht (vorher bekam ein 0-%-Feiertag die Minuten statt Nacht). **Rechtlich:** Arbeitet jemand tatsächlich an einem
    Sonn-/Feiertag, sind die RTV-Zuschläge geschuldet – dann den Einsatz mit Haken anlegen, Hinweis in den Lohnarten
    beachten.
  - **Entwurf direkt im Brief ändern** (`/rechnungen/<id>`): Klick auf Anschrift, Einleitung, eine Position (Text
    mehrzeilig, Menge, Einheit, Einzelpreis, löschen), „+ Position hinzufügen“ oder Schlusstext öffnet ein kleines
    Formular an Ort und Stelle → `POST /rechnungen/<id>/direkt` → `patchDraft` (gleiche Prüfungen wie der Editor,
    Versionsschutz gegen zweiten Tab). „✎ alle Felder“ führt weiter in den vollen Editor (Leistungsart, Zeitraum …).
  - **Arbeitsschein in der Mitarbeiter-App:** Entwürfe, denen eine Person zugeordnet ist (Häkchen „Eingesetzte
    Mitarbeiter“), stehen sofort in ihrer App-Übersicht („Arbeitsscheine zum Unterschreiben“); Details + PDF, der Kunde
    gibt seinen Namen ein und unterschreibt mit dem Finger (Texte für den Kunden immer Deutsch) → wie im Büro
    unterschrieben, PDF write-once. Ohne Zuordnung bleibt der Schein nur im Büro (Versand per Mail usw.).
  - **Kalender-Abo (ICS) für iPhone, Outlook, Google** (Benutzermenü → „Kalender abonnieren“, Mitarbeiter-App →
    Kalender → „Einsätze im Handy-Kalender anzeigen“): geheimer Link `/kalender/abo/<token>.ics` (`app.calendar_feeds`,
    Migration `20261117000002`, neu erzeugen macht den alten ungültig). Inhalt: eigene Einsätze (verknüpfter
    Mitarbeiter), offene Aufgaben (mir oder niemandem zugewiesen), Ausschreibungs-Fristen/Bieterfragen/Besichtigung,
    Glas- und Tiefgaragen-Termine (nicht Objektleitung); 14 Tage zurück bis 90 Tage voraus, stündlich aktualisiert,
    nur lesen. In Outlook (IONOS Exchange) einmal „Aus dem Internet abonnieren“ → erscheint auf allen Geräten.
  - Anlagen-Feld in der Rechnung zeigte wieder den englischen „Choose Files“-Knopf → ausgeblendet.
  - **Vorschlag Münchner Wohnen (Einzelaufträge ohne Objekt) und Outlook-Kalender in der App: siehe offene Fragen.**
- 2026-10-09: Runde 33 (Ahmed, 4 Punkte + Nachträge):
  - **Nachkalkulation/Ø Stundensätze leer – Fund:** Ohne Vergütung beim Mitarbeiter war der Lohn 0 (fast alle importierten
    Mitarbeitenden) → jetzt **niedrigster aktiver Tariflohn** als Annahme (Hinweis „Lohn angenommen (Tariflohn)“), und
    Ø Stundensätze zählte keine Rechnungen von vor der Umstellung (Erlös 0). **Ahmed: echte Vergütung je Mitarbeiter
    nachtragen**, sonst ist der Lohn nur geschätzt.
  - **Nachunternehmer in Nachkalkulation und Ø Stundensätzen:** Eingangsrechnungen nach Kostenstelle/Leistungsmonat; fehlt
    für einen Monat die NU-Rechnung, zählt die **Monatspauschale der erteilten Bestellung** (mit Preisnachträgen, „davon x
    lt. Bestellung“, `subcontractEstimates`). Abrechnung je Einsatz/Tag/Stunde lässt sich ohne Rechnung nicht schätzen.
    Ø Stundensätze: Spalten „Nachunternehmer“ und „nach NU je Ist-Std.“.
  - **Arbeitsschein aus dem Rechnungsentwurf** (Knopf unter „Lieferschein erstellen“): Objekt, Zeitraum, Positionen werden
    übernommen; die Rechnung lässt sich erst ausstellen, wenn der Schein **vom Kunden unterschrieben** ist – das PDF hängt
    sich beim Unterschreiben automatisch an. „Pflicht aufheben“ nur mit Grund (Protokoll). Spalten
    `invoices.work_report_required`, `work_reports.draft_invoice_id`.
  - **Arbeitsschein Regiestunden:** je Zeile Uhrzeit von–bis und Pause (Stunden werden daraus berechnet) oder nur Stunden;
    Summe darunter. PDF „Zeit (Pause)“. Auf der Rechnung werden die Stunden **je Tätigkeit zusammengefasst, ohne Namen**
    (Namen stehen im angehängten Arbeitsschein).
  - **Arbeitsschein einzeln „erledigt“** (ohne Rechnung, z. B. in Pauschale enthalten; zurücknehmbar) und **löschen**:
    Entwurf jederzeit, abgeschlossene nur Admin (Stand ins Protokoll, PDF/Unterschrift bleiben im Archiv), nicht wenn schon
    ausgestellt abgerechnet. Stornieren löst den Schein aus einem Rechnungsentwurf.
  - **Fund: Rechnungsentwürfe mit Anhang ließen sich nicht löschen** (Archiv-Tabelle sperrte jedes Löschen). Jetzt dürfen
    Anhang-Verweise eines Entwurfs mit weg (Datei bleibt write-once), Arbeitsscheine/Aufträge werden wieder frei.
  - **Einzelaufträge** (Rechnungen → Einzelaufträge, Kunde → „+ Einzelauftrag“; nutzt die Aufträge AU-JJJJ-NNNN): Kunde,
    Objekt **oder** Leistungsort als Text (Münchner Wohnen), Bestellnummer, Termin mit Uhrzeit, Mitarbeiter/Vorarbeiter,
    Positionen mit Preisen, Häkchen **„Arbeitsschein erforderlich“**. Termin erscheint in der App der Eingeteilten
    („Einzelaufträge“, 14 Tage) und im **Kalender-Abo** (Büro: alle offenen). Mit Arbeitsschein-Pflicht entsteht sofort ein
    Schein-Entwurf für das Team (ohne Objekt → Objekt „Allgemein“ des Kunden), der in der App unterschrieben wird; Rechnung
    erst danach. Offene Einzelaufträge stehen immer unter **Entwürfe → „Aus Einzelleistungen erstellen“** (je Kunde, Häkchen,
    je Auftrag eine Rechnung, Leistungszeitraum = Termin). Migrationen `20261117000003`–`…05`.
  - Tests: 467 Unit-/DB-Tests (neu `runde33.db.test.ts`), e2e auftrag/vorfaktura/leistungen/objekt/rechte/runde10 grün.
- 2026-10-09: **Vorschüsse an Nachunternehmer** (Ahmed: erfassen und wieder löschen können):
  - Nachunternehmer → Reiter **„Vorschüsse“**: Datum, Betrag, Zahlart, optional Bestellung, Zweck; Kacheln gesamt /
    verrechnet / offen. **Löschen** solange nichts verrechnet ist (Stand ins Protokoll). Feste ID je Formular.
  - **Kontoumsätze:** Zahlungsausgang beim Lieferanten → „Als Vorschuss erfassen“ (Kostenart Nachunternehmer); „wieder
    öffnen“ löscht den Vorschuss mit.
  - **Verrechnen** an der Eingangsrechnung (Karte „Vorschuss“, Betrag vorbelegt) oder vom Reiter aus; älteste Vorschüsse
    zuerst, nie über Vorschuss/Rechnungsbetrag hinaus (DB-Trigger). Zahlungsliste, „als bezahlt festhalten“, SEPA-Lauf
    (Verwendungszweck „abzgl. Vorschuss“) und Kontoumsatz-Erkennung rechnen mit dem Restbetrag. Rücknahme der
    Verrechnung, solange die Rechnung nicht bezahlt ist. Tabellen `subcontractor_advances`, `subcontractor_advance_offsets`
    (Migration `20261117000006`).
  - **DATEV:** Vorschuss = Zahlungsausgang auf den Kreditor (Bar → Hinweis Kasse). **Steuerlich:** Bei § 13b-Leistungen
    entsteht unsere Umsatzsteuer schon mit der Zahlung des Vorschusses (§ 13b Abs. 4 S. 2 UStG) – mit dem Steuerberater
    klären, Hinweis steht im DATEV-Export.
  - Tests: `advances.db.test.ts` (3), e2e nachunternehmer/einkauf/transfer grün.
- 2026-10-09: **Arbeitsschein wieder bearbeiten** (Ahmed): Knopf „Wieder bearbeiten“ am abgeschlossenen Schein (unterschrieben
  oder ohne Unterschrift) → zurück in den Entwurf, ändern, dann neu abschließen bzw. vom Kunden neu unterschreiben lassen
  (mit zugeordneten Mitarbeitenden auch wieder in deren App). Alte Unterschrift/PDF bleiben write-once im Archiv, der alte
  Stand steht im Protokoll (`reopen`); die neue Fassung bekommt eine eigene Datei (`…_Fassung2.pdf`). Gesperrt bei
  storniert oder schon ausgestellter Rechnung (dann erst Rechnung stornieren). Hing der Schein an einem Rechnungsentwurf,
  wird der Anhang entfernt und nach dem neuen Abschluss automatisch wieder angehängt; „Arbeitsschein erforderlich“ sperrt
  das Ausstellen bis zur neuen Unterschrift. DB nur über `app.reopen` (Migration `20261117000007`).
  **Rechtlich:** Die alte Unterschrift deckt den geänderten Inhalt nicht – immer neu unterschreiben lassen.
  Tests: 471 Unit-/DB-Tests, `e2e:auftrag` grün.
- 2026-10-09: **Einzelaufträge beim Kunden** (Ahmed: „neben Objekte, Summe sehen, keine eigene Seite“): Kunde → Reiter
  **„Einzelaufträge“** (nach „Objekte“) mit Offen / Abgerechnet / Alle, Rechnung an, Ort, Termin, Arbeitsschein, Status,
  Netto und **Summe** (ohne stornierte; bei „Alle“ zusätzlich „davon nicht abgerechnet“). Menüpunkt und Seite
  `/auftraege` entfallen (leitet auf Kunden), Knopf „+ Einzelauftrag“ aus der Kundenkarte in den Reiter verschoben.
  Auftrag-Editor: oben **„Rechnung an“** mit Name, Zusatz, z. Hd., Straße, PLZ, Ort – vorbelegt aus Objekt/Gruppe/Kunde,
  direkt änderbar (z. B. andere Gesellschaft von Münchner Wohnen); nur Abweichungen werden gespeichert
  (`orders.bill_address`), später über „Anschrift ändern“ am Auftrag erneut änderbar (nach der Rechnung: „Name / Adresse
  ändern“ an der Rechnung). Anschrift gilt für Auftragsbestätigung und Rechnung. **Leistungsart je Position**
  (z. B. Sonderreinigung) und Leistungszeitraum je Position wie im Rechnungsentwurf, gehen auf die Rechnung über.
  **Mitarbeiter** als Suchfeld „+ Mitarbeiter hinzufügen …“ mit Chips statt Liste aller Häkchen (`data-multi` in
  `client.ts`). Entwürfe → „Aus Einzelleistungen erstellen“: Einzelaufträge stehen jetzt unter demselben Monat des
  Leistungszeitraums und Kunden wie die Einzelleistungen (nicht mehr als eigener Kasten). Migration `20261117000008`.
  Tests: 471 Unit-/DB-Tests, `e2e:auftrag` 30, `e2e:vorfaktura`, `e2e:rechte`, `e2e:leistungen` grün.
- 2026-10-09: **Objekte zusammenführen** (Ahmed: „bei ARGE ist ein Objekt doppelt“; nur Admin): Objekt → Bearbeiten → unten
  „Objekt doppelt? Mit einem anderen Objekt zusammenführen“ → behaltenes Objekt desselben Kunden wählen. Alle Fremdschlüssel
  auf das Objekt (Leistungen, Einsätze, Zeiten, Rechnungen, Raumbuch, Schlüssel, Arbeitsscheine …) sowie Dateien, Notizen
  und Aufgaben werden umgehängt (erst gesamt, sonst Zeile für Zeile); doppelte Mitarbeiter-/Datei-Zuordnungen entfallen;
  danach wird die Dublette gelöscht. Nicht Umhängbares (ausgestellte Rechnungen sind unveränderbar) bleibt → Dublette
  deaktiviert „(zusammengeführt in …)“. Zeiten: Grund im Änderungsprotokoll (§ 17 MiLoG). Fortytools-ID wird übernommen
  bzw. in `app.site_merges` gemerkt – der XML-Import legt das Objekt nicht wieder an. Protokoll `audit_log` (merge).
  Migration `20261118000001`, Test `site-merge.db.test.ts`.
- 2026-10-09: **Kostenstelle folgt der Objektnummer** (Ahmed: „haben andere Objekte dadurch falsche Kostenstellen?“):
  Nachkalkulation, Kostenstellen-Auswertung, Eingangsrechnungs-Aufteilung und Arbeitsschein rechnen über das Objekt
  selbst (site_id) – das war nie betroffen. Nur der Text „Kostenstelle“ an der Leistung (`site_services.cost_center`)
  konnte veralten: Trigger zieht ihn bei Änderung der Objektnummer mit (nur wenn er die alte Nummer war), Zusammenführen
  setzt umgehängte Leistungen auf die Nummer des behaltenen Objekts, Migration `20261118000002` korrigiert Bestand
  (Nummer eines anderen Objekts oder Import-Zwischennummer „…~…“ → eigene Objektnummer; 9000er und freie Texte bleiben).
- 2026-10-09: Ahmed (8 Punkte):
  - **Leistung kopieren:** in jeder Leistung unten „Leistung kopieren in Objekt …“ (dieses oder ein anderes Objekt desselben
    Kunden) → Formular mit allen Werten als neue Leistung (Kostenstelle = Zielobjekt), Original bleibt.
  - **Einstellungen → E-Mail-Versand prüfen** (nur Admin): zeigt SMTP-Server, Benutzer, Absender (Passwort nie), Test- oder
    Echtbetrieb und ob alles an die Testadresse umgeleitet wird; „Test-E-Mail senden“ mit verständlicher Fehlermeldung.
  - **Storno/neu ausstellen von Rechnungen vor der Umstellung** (Fortytools nutzt denselben Nummernkreis – dort stornieren
    würde eine Nummer doppelt vergeben): an der alten Rechnung „Stornorechnung erstellen“ (Entwurf, Kind cancellation,
    `invoices.original_legacy_invoice_id`, Verweis BT-25 auf die alte Nummer, Positionen negativ, Steuersatz aus Netto/Brutto,
    § 13b wenn ohne USt) und „Als neue Rechnung kopieren“ (Entwurf mit den alten Positionen). Ausgestellte Storno-/Korrektur-
    rechnungen mindern den offenen Posten der alten Rechnung (`legacy_open_items`). Höchstens ein Storno je Rechnung
    (DB-Index). Migration `20261118000003`, Test `legacy-cancel.db.test.ts` (KoSIT).
  - **Rechnungseingang → Reiter „Vorschüsse“:** alle Vorschüsse aller Nachunternehmer (offen / alle), verrechnet, offen,
    mit welcher Rechnung, Summen, „seit n Tagen offen“ ab 45 Tagen rot; Zähler offener Vorschüsse im Reiter.
  - **Einzelauftrag:** Titel und „Name / Firma“ mehrzeilig (Name: 1. Zeile = Name, weitere Zeilen = Zusatz/Name 2).
  - Objektordner-Paket unverändert (die App füllt die Lücken beim Herunterladen selbst) – Ahmed lädt es einmal unter
    Einstellungen → Objektordner-Vorlagen hoch.
- 2026-10-09: **Fund „weiße Seite beim Speichern“** (Ahmed):
  1. Beim automatischen Update (alle 10 Min., sobald es Neues gibt) startet die App neu; in dieser Zeit lieferte Caddy eine
     leere Fehlerseite (502). Jetzt wartet Caddy bis 120 s, bis die App wieder da ist (`lb_try_duration`; wiederholt nur, wenn
     die App gar nicht erreichbar war → Speichern kommt genau einmal an), sonst deutsche Hinweisseite „Die App wird gerade
     aktualisiert“. `deploy/update.sh` erstellt Caddy neu, wenn sich das Caddyfile geändert hat (eingebundene Datei).
  2. Formular-Schutz (CSRF) verglich hinter Caddy „http“ mit „https“: Browser ohne Sec-Fetch-Site (ältere iPhone/iPad-
     Safari) bekamen bei jedem Speichern „Forbidden“ auf weißem Grund. Jetzt zählt der Rechnername; fremde Seiten bleiben
     gesperrt. HTTP-Fehler (403 usw.) erscheinen als normale App-Seite mit Hinweis und Rückweg.
- 2026-10-09: Ahmed (4 Punkte + 2 Nachträge):
  - **Objektordner als ein Druck-PDF** (Objekt → Objektordner → „Objektordner als PDF (zum Drucken)“, Word-ZIP bleibt
    daneben): Deckblatt, Inhaltsverzeichnis mit Seitenzahlen, Objektstammblatt mit Kontakten und Notrufnummern,
    Leistungsverzeichnis (ohne Preise), Reinigungsplan (Raumbuch), Revierplan (Einsätze), danach alle Vorlagen aus Ahmeds
    Paket: Word-Dateien werden ausgefüllt und auf Briefpapier gesetzt (eigener Leser `src/pdf/docx-render.ts`: Absätze,
    Tabellen mit Zellfarben, Aufzählungen), fertige PDF-Aushänge angehängt; Word-Quellen der PDF-Aushänge
    (`C_Word-Quellen`) und Muster nicht doppelt; MW-Reinigungspläne nur bei Münchner Wohnen; am Ende leere
    Anwesenheitsliste und Stundennachweis Regie. Probe mit dem echten Paket: 51 Seiten, < 2 s.
    **Fund „Angaben werden nicht ausgefüllt“:** die Lücken wurden nur bei wenigen Beschriftungen erkannt. Jetzt Regeln
    (`canonLabel`) für „Objekt / Liegenschaft“, „Objekt / Adresse“, „Anschrift Objekt“, „Objektleitung Viva-Deluxe“,
    „Ansprechpartner beim Kunden“, „Erstellt am / durch“, „Leistungsbeginn“/„Beginn der Reinigung“ (frühester Beginn der
    Leistungen) …, Name + „Tel.:“ in einer Zelle getrennt gefüllt, Telefon sonst angehängt. Zweiter Fund: gleich
    aussehende leere Zellen wurden verwechselt (Datum landete hinter „Übernahme am“ statt „Beginn der Reinigung“) –
    Zellen werden jetzt an ihrer Position ersetzt. Word-Datumsfelder (zeigten fest „13.08.2026“) → Linie zum Ausfüllen
    (PDF und ZIP). Ereignisbezogene Felder (Reklamation, Begehung am, Sammelplatz …) bleiben bewusst leer.
  - **Leistung kopieren** jetzt in der Übersicht „Leistungen & Preise“ (Symbol rechts je Zeile), nicht mehr in der
    Leistung; in der Kopie oben „Kopie anlegen in Objekt …“ (anderes Objekt desselben Kunden).
  - **Versandweg „kein Versand“** je Rechnungsgruppe (Ahmed: z. B. Landeshauptstadt München will keine Zusendung): mit
    dem Ausstellen automatisch als versendet vermerkt (Versandprotokoll Kanal „keiner“, genau einmal), Mailversand
    gesperrt. Migration `20261118000004`. **Rechtlich:** Eine Rechnung muss dem Empfänger zugehen bzw. zugänglich sein
    (§ 14 UStG). Wenn die Stadt keine Rechnung will, weil sie selbst abrechnet (Gutschriftverfahren/Abrechnung durch den
    Leistungsempfänger), dürfen wir zusätzlich **keine** Rechnung mit USt ausstellen (sonst § 14c UStG) – Ahmed klärt,
    warum die Stadt keinen Versand will.
  - **Server-Gesamtanleitung** `docs/anleitung-server.html/.pdf` (verbinden per IONOS-KVM, Windows, Mac, Handy;
    .env.live, update.sh, Status, Logs, Sicherungen, Benutzer-Passwort, root-Passwort, Notfall, Verbote, Spickzettel).
  - **Nachkalkulation:** Eingangsrechnungen zählen ab „erfasst“ (nicht erst nach Zahlung) nach Kostenstelle und
    **Leistungsmonat**. Neue Spalte **Geräte** (Kostenart „Geräte / Wartung“, z. B. Hebebühne – stand bisher unter
    „Sonstiges“). **Filter** Kunde, Objekt, Objektleitung, „nur Verlust“ (allgemeine Kostenstellen dann ausgeblendet),
    je Objekt **„Kosten im Detail“** = Liste der Eingangsrechnungen mit Leistungsmonat, Kostenart, Status, Anteil.
  - Tests: neu `site-folder.db.test.ts`, erweitert `site-folder.test.ts`, `portal-ranges.db.test.ts`,
    `cost-centers.db.test.ts`.
- 2026-10-09: **Fund „Rechnungen nach Rechnungsnummer nicht zu finden“** (Ahmed): 1) Die Suche unter Rechnungen → Alle
  Rechnungen suchte nur im gewählten Jahr (Rechnung aus 2025 bei Jahr 2026 = kein Treffer). Jetzt sucht sie mit
  Suchbegriff **über alle Jahre** (Hinweis „Treffer aus allen Jahren“, „Suche aufheben“), Nummer auch mit Leerzeichen,
  zusätzlich Kundennr., Objektnr., Bestellnr., Käuferreferenz, Name in der Anschrift. 2) Die globale Suche oben hatte
  die Rechnungen von vor der Umstellung nie durchsucht (Typ war angelegt, Abfrage fehlte) – jetzt in der Gruppe
  „Rechnung“ (Nummer, Kunde, Referenz, Kopf-/Fußtext, Positionen), Link `/rechnungen/<id>`; genau ein Treffer öffnet die
  Rechnung direkt. Test in `invoice-archive.db.test.ts`.
- 2026-10-09: **Erteilte Bestellungen an Nachunternehmer korrigierbar** (Ahmed: „manche sind als monatlich drin, obwohl es
  nicht monatlich ist“): vorher waren nach dem Erteilen nur Ende und Notiz änderbar. Jetzt auch bei „erteilt“/„beendet“:
  Objekt, Leistung, Häufigkeit, Abrechnungsart, max. Stunden, Beginn/Ende, Leistungsumfang. Nachunternehmer und Preis
  bleiben gesperrt (Preisänderung über Preisnachtrag ab Monat), stornierte Bestellungen bleiben unveränderbar. Jede
  Änderung mit altem/neuem Wert im Protokoll (`audit_log.details`). Hinweis im Formular; ist die Bestellung schon
  unterschrieben → neu unterschreiben lassen. Wirkt sofort auf „Rechnung erwartet“/Abrechnungsverfolgung und die
  NU-Schätzung der Nachkalkulation (nur „Pauschale je Monat“ wird geschätzt). Test in `subcontractors.db.test.ts`.
- 2026-10-09: **E-Rechnung herunterladen** (Ahmed: „ZUGFeRD erstellt, wie lade ich die Datei fürs Portal herunter?“): An jeder
  ausgestellten Rechnung oben Kasten „E-Rechnung herunterladen“ mit **ZUGFeRD (PDF)** und **XRechnung (XML)** der aktuellen
  Fassung (nur KoSIT-gültige; bei Format XRechnung zuerst XML). Download mit `?download=1` speichert als Datei (vorher öffnete
  das iPad das PDF nur im Browser). Danach im Portal hochladen und „Im Portal hochgeladen“ klicken.
- 2026-10-09: **Zyklus-Leistungen nach Ausführung** (Ahmed: „halbjährliche oder jährliche Sachen sollen nach Ausführung
  abgerechnet werden“): Leistungen mit 2-monatlich, quartalsweise, halbjährlich, jährlich werden standardmäßig nicht mehr
  im Voraus im Monatslauf abgerechnet, sondern wie „je Ausführung“ über **Leistungen verrichten** (Art `special`, der
  Zyklus zeigt nur die Fälligkeit). Neues Feld in der Leistung „Abrechnung bei 2-monatlich … jährlich“: nach Ausführung
  (Standard) / automatisch im Monatslauf. Fälligkeit = Leistungsbeginn bzw. letzte Ausführung + Zyklus („fällig ab/seit“
  in „Leistungen verrichten“), **Erinnerung** (Bereich „Leistungen“, 14 Tage vorher, entfällt sobald vorgemerkt).
  Umsatz-Vorschau rechnet sie weiter einmal je Zyklus (Schätzung). Bestand per Migration `20261118000005` umgestellt –
  wer weiter automatisch abrechnen will, stellt es in der Leistung um. Monatlich bleibt automatisch.
- 2026-10-09: **NU-Bestellung erteilen erst unter 50 % gesperrt** (Ahmed): Erteilen ist nur gesperrt, wenn weniger als die
  Hälfte der Pflicht-Nachweise gültig ist (Meldung „x von y … – Fehlt: …“). Ab 50 % geht es; fehlende Nachweise werden im
  Protokoll vermerkt (`nachweise_fehlen`), Ampel/Zahlungsliste-Markierung bleiben. **Rechtlich:** Haftung für Mindestlohn und
  SV-Beiträge des Nachunternehmers (§ 13 MiLoG, § 14 AEntG, § 28e Abs. 3a SGB IV) – fehlende Nachweise zeitnah nachfordern.
- 2026-10-09: **E-Mails mit Signatur + Test-Mail wie beim Kunden** (Ahmed): Rechnungs- und Mahnungs-Mails gehen jetzt als
  Text + HTML mit Logo (eingebettet, cid) und Signatur (`src/mail/compose.ts`). Signatur automatisch aus den Firmendaten
  inkl. **Pflichtangaben § 35a GmbHG** (Rechtsform, Sitz, Amtsgericht + HRB, Geschäftsführer, USt-IdNr.) – fehlten bisher in
  den Mails – oder eigener Text unter Einstellungen → E-Mail-Versand (`company.mail_signature`, Migration
  `20261118000006`), dort auch Vorschau. **Test-E-Mail „wie an Kunden“**: zuletzt ausgestellte (oder gewählte) Rechnung mit
  Betreff, Text, Signatur und Anhängen je Rechnungsformat, nur an die eingegebene Adresse, kein Versandeintrag (Rechnung
  gilt nicht als versendet), Hinweis oben mit den echten Empfängern; Protokoll `test_mail`.
- 2026-10-09: **Signatur wie die Outlook-Signatur** (Ahmed, Screenshot; „ohne Namen, allgemein mit buchhaltung@“): oben
  „Buchhaltung“ + buchhaltung@viva-deluxe-reinigung.de, Logo mit Slogan, „Zentrale München“ (aus Firmendaten), „Niederlassung
  Stuttgart“ (Königstr. 5 · 70173 Stuttgart, stuttgart@…), Siegel-Leiste (Meisterbetrieb, ISO 9001/14001, Gebäudereiniger-
  Handwerk, Die Gebäudedienstleister, Umwelt- und Klimapakt Bayern – Bilder aus Ahmeds Signatur, `assets/mail/`),
  Pflichtangaben-Fußzeile, Umwelt- und Vertraulichkeitshinweis (de/en). Felder unter Einstellungen → E-Mail-Versand
  (JSON in `company.mail_signature`), Siegel/Hinweise abschaltbar, Vorschau mit Bildern.
- 2026-10-09: **Rechnung erwartet: mehrere auf einmal erledigen** (Ahmed: „wurden schon alle bezahlt“): Häkchen je Zeitraum,
  je Nachunternehmer und „alle“, oben Vermerk (vorbelegt „bereits bezahlt (vor der Umstellung)“) → „Markierte als erledigt
  vermerken“ (`/rechnungseingang/erwartet/auswahl`, gleiche Speicherung wie „keine Rechnung …“ mit Grund, nichts doppelt).
- 2026-10-09: **NU-Bestellung für mehrere Objekte** (Ahmed): im Entwurf „Weitere Objekte“ (Suchfeld mit Chips). Beim Speichern
  entsteht je weiterem Objekt eine eigene Bestellung mit denselben Angaben (eigene Nummer BE-JJJJ-NNNN, gleicher Preis, im
  Entwurf je Objekt anpassbar; feste ID aus Bestellung + Objekt → nichts doppelt). Bewusst je Objekt eine Bestellung: Kosten
  in Nachkalkulation/Kostenstellen bleiben je Objekt richtig, „Rechnung erwartet“ und Abrechnungsverfolgung funktionieren
  unverändert; eine Eingangsrechnung kann alle Bestellungen abdecken („Eine Rechnung für alle erfassen“).
- 2026-10-09: **Rechnungsverfolgung NU prüft selbst** (Ahmed: „jährlich nicht immer bei erwartet“, „laufende Bestellungen sind nur
  monatliche“, „je Subunternehmer aufklappen“, „ohne unterschriebenen Scan als fehlend“, „Preis doppelt“):
  - **Nur monatliche/wöchentliche Bestellungen sind „laufend“** (`isRecurringOrder`): nur sie erzeugen „Rechnung erwartet“
    und „fortlaufend“ in der Bestellliste. Einmalig/quartalsweise/halbjährlich/jährlich = **nach Ausführung** (Status
    „nach Ausführung“ in der Abrechnungsverfolgung, keine Meldung).
  - **Selbst prüfen:** ein Zeitraum gilt als abgerechnet, wenn eine Eingangsrechnung ihn abdeckt – ausdrücklich verknüpft
    (Zeitraum irgendwo im Abrechnungszeitraum), am Auftrag erfasst oder vom selben NU für dasselbe Objekt ohne Auftrag; Monat
    = Leistungsmonat, sonst Rechnungsdatum (längere Zeiträume bis 2 Monate nach Ende); abgelehnte zählen nicht.
  - „Rechnung erwartet“: je Nachunternehmer **aufklappbar** (zu, mit Anzahl und ≈ Summe), Häkchen bleiben.
  - Bestellungen: erteilte NU-Bestellungen **ohne unterschriebenen Auftrag** (Scan oder Handy-Unterschrift) mit Hinweis
    „unterschriebener Auftrag fehlt“, oben Zähler + Filter `?unterschrift=fehlt`. Spalten der Liste bei schmalem Bildschirm
    schmaler (Lieferant war zusammengequetscht).
  - Bestellschein: bei Pauschalen nur noch eine Zeile „Preis (netto)“ (vorher Preis und Gesamtbetrag gleich); bei Stunden
    weiter Stundensatz + angenommene Std. + Gesamtbetrag.
- 2026-10-09: **„Noch nicht versendete Dokumente“ wie Fortytools** (Ahmed, Screenshot; „Alle Rechnungen soll weg“): Rechnungen →
  „Noch nicht versendet“ (`/rechnungen/versand`, `routes-versand.tsx`) mit Reitern Rechnungen / Rechnungskorrekturen /
  Mahnungen / Versandverlauf (→ Transfer → Dokumentenversand). Versandart wählen (E-Mail / als bereits versendet
  kennzeichnen mit Weg + Bemerkung / im Portal hochgeladen), ankreuzen (alle), „Los (n)“ – jedes Dokument einzeln über die
  bestehenden Funktionen (genau einmal; Fehler je Dokument werden aufgelistet, halten die anderen nicht auf). Spalten Datum,
  Nr., Kunde, Pos, Netto, Brutto, Empfänger (Hinweis „Portal“ / „keine Rechnungs-E-Mail“), Summen. „Alle als PDF
  herunterladen“ (archivierte Belege in einer Datei). Mahnungen: neu „als versendet kennzeichnen“ (`markDunningSent`).
  Die Filter „Alle Rechnungen / Nicht versendet“ auf der Rechnungsliste entfallen (`?filter=unversendet` leitet um).
- 2026-10-09: **Ausgestellte Rechnung wie Fortytools** (Ahmed: „unübersichtlich“, Screenshot Rechnungskorrektur 1038307):
  `IssuedLetter` in `pages-invoice-letter.tsx` – links das Blatt (Anschrift, grauer Balken „Rechnung/Rechnungskorrektur
  Nr.“ mit Datum, Kundennummer, Referenznummer = Original, Leistungsort/Zeitraum/Leitweg-ID/Bestellnr., Positionen je
  Objekt, Summen, Zahlungsbedingung), Stempel **BEZAHLT** (Saldo 0) bzw. **STORNIERT**; rechts Knopfleiste (Name/Adresse
  ändern, Kopieren, Als bezahlt markieren/Zahlung, X-Rechnung, ZUGFeRD, Anzeigen (PDF), Lieferschein, Stornieren,
  Rechnungskorrektur), Anhänge (Upload), Versand (Status, „Jetzt versenden“, „Als versendet markieren …“ bzw. Portal),
  **Zahlungsübersicht** (Rechnung, Storno/Korrektur, Zahlungen, Saldo). Alles Bisherige (Belege/Prüfberichte,
  Versandprotokoll, Zahlungen buchen, berichtigte Fassungen) eingeklappt unter „Weitere Angaben“ (öffnet bei Meldungen
  bzw. Sprungmarken `#adresse`, `#zahlungen`). Entwürfe unverändert (DraftLetter).
- 2026-10-09: Objektliste: „Markierte aktiv/inaktiv setzen“ bleibt auf derselben Seite (Seitenzahl ging beim Rücksprung
  verloren; Filter/Sortierung blieben schon). Fällt die Seite durch den Filter weg, zeigt die Liste die letzte vorhandene.
- 2026-10-09: Objektleitung (Ahmed: „sieht kranke Leute, die nicht bei ihr eingeplant sind“; „Schlüssel, Artikel, Geräte nur
  in ihrem Objekt“):
  - Abwesenheiten (Karte „Abwesend“ Startseite/Zeiterfassung, App-Kennzahl „abwesend“, Team-Status, „Anträge zum
    Genehmigen“) zeigen der Objektleitung nur noch Personen, die **im Abwesenheitszeitraum an einem ihrer Objekte
    eingeplant** sind (Einsatz oder Vertretung, `plannedAtSites` in `absences.ts`) – vorher reichte die (oft alte/importierte)
    Zuordnung Mitarbeiter ↔ Objekt. Bei den Objekten der Person stehen nur noch ihre eigenen.
  - Geräte: Objektleitung öffnet/speichert nur Geräte ihrer Objekte (vorher per Link jedes Gerät), Standort nur eigene
    Objekte, kein „Lager“. Schlüssel: Ausgabe nur an Mitarbeitende ihrer Objekte (zugeordnet oder eingeplant), auch
    serverseitig geprüft; Objekt → Schlüssel ebenso. Artikel/Fahrzeuge sind für die Objektleitung ohnehin gesperrt.
- 2026-10-09: Objektleitung, Benutzer, NU-Stunden (Ahmed):
  - **Aufgaben der Objektleitung:** nur noch die ihr zugeordneten (Zuständig = ihr Name oder Benutzername) bzw. von ihr
    selbst ohne Zuständigkeit angelegten (`taskVisibleTo` in `crm.ts`, `taskViewerOf` in `app.tsx`). Gilt für
    /aufgaben, Objekt → Aufgaben (inkl. Zähler), Suche, Kalender-Abo und „erledigt“. Ausschreibungs-Fristen (ohne
    Zuständigen) und allgemeine Büro-Aufgaben sieht sie nicht mehr.
  - **Benutzer → Objekte der Objektleitung:** inaktive Objekte und Objekte, die schon eine andere Objektleitung haben,
    sind ausgeblendet; Schalter „auch Objekte anderer Objektleitungen (n)“ zum Umhängen. Zugeordnete inaktive Objekte
    bleiben (unsichtbar) zugeordnet.
  - **Stundennachweis bei NU-Bestellungen „je Stunde“** (Bestellung → Karte „Stundennachweis“): je Tag Personen ×
    Stunden je Person (2,5 oder 2:30) + Bemerkung; Betrag = Personen × Std. × Stundensatz des Monats (Preisnachträge),
    je Eintrag kaufmännisch auf Cent; Monatssumme, Warnung über „max. Std./Monat“; löschen mit Protokoll; feste ID je
    Formular. Nachkalkulation/Ø Stundensätze: fehlt die NU-Rechnung im Monat, zählen die erfassten Stunden × Satz
    (wie die Monatspauschale). Tabelle `app.subcontract_hours` (Migration `20261119000001`).
  - Tests: neu `runde34.db.test.ts`; e2e rechte/uebergabe schalten „andere Objektleitungen“ ein.
- 2026-10-10: **Gesamtprüfung** (Ahmed: „jede Seite, jede Position, Zeilen, Design, Vorlagen prüfen“):
  - Neues Prüfskript `npm run check:seiten` (`e2e/seiten-check.mjs`): öffnet alle erreichbaren Seiten (je Seitentyp 2
    Beispiele, 657 Seiten) am PC (1366 px) und Handy (390 px), meldet Fehlerseiten, JS-Fehler, „undefined/NaN/null“,
    Querscrollen, abgeschnittene Knöpfe, kaputte Bilder, Felder ohne Beschriftung; Bericht `var/seiten-check/bericht.json`.
    Ergebnis nach Korrektur: keine Fehlerseite, kein JS-Fehler, kein „undefined/NaN“.
  - **Behoben (Seiten):** Reiter bei Kunde/Objekt/Mitarbeiter liefen bei 1366 px rechts aus der Seite („Offene Posten“,
    „Mehr“ unsichtbar) → umbrechen; App-Rahmen am PC (nach /qm) zeigte Büro-Seiten zu schmal mit abgeschnittenen Tabellen
    → einspaltig, Tabellen scrollen; Alle Rechnungen: Belege-Spalte abgeschnitten → untereinander; Wochenplanung am Handy
    unlesbar schmal → Tagesspalten mind. 110 px, seitlich scrollen; Rechnungsansicht am Handy: Positionstabelle scrollt;
    Kennzahl-Kacheln am Handy 2-spaltig/nicht abgeschnitten; QM-Audit: unsichtbare Auswahlfelder verursachten 700 px
    Querscrollen; QR-Aushang-Knopf ragte aus der Karte; Verwaltungs-App „Unterweisun-gen“ silbengetrennt statt zerhackt;
    Monatsauswahl mit Monatsnamen statt Zahlen; toter Link Planung → Mitarbeiter-Kalender (404) und Objektordner →
    „Telefon der Objektleitung“ (404); Tiefgaragen-Aushang ohne Termine sprang auf die Startseite; „−0,00 €“ im
    Kassenbuch; Einzahl/Mehrzahl statt „Rechnung(en)/Objekt(e)/Datei(en)/neue(r)“ (Helfer `anz()` in `layout.tsx`);
    Datum überall zweistellig (09.10.2026 statt 9.10.2026); fehlende Beschriftungen an Filterfeldern ergänzt.
  - **Behoben (PDF-Vorlagen):** GiroCode-Text lag auf dem Code; NU-Bestellschein „Status: Offen“ → „Erteilt“; Arbeitsschein
    „München, 9.10.2026“ → 09.10.2026; Lieferschein Menge „1,0“ wie Rechnung + Beschriftung „Datum, Name, Unterschrift“;
    Listen-PDFs (Fehlende Unterlagen, Objektordner) brechen lange Texte um statt „…“, Spaltenköpfe werden kleiner statt
    abgeschnitten („Persona…“); Objektstammblatt-Beschriftung lief in den Wert; QK-/Übergabe-PDF: Objektname nicht mehr
    mitten in der Klammer abgeschnitten (eigene Zeile Objekt-Nr.).
  - Browser-Test runde10 nahm „heute + 14 Tage“ als Urlaubstag – an Samstagen falsch → nächster Werktag.
- 2026-10-10: **Bedientest wie ein Bediener** (Ahmed: „macht es Sinn, wo die Buttons sind“) – drei Prüfdurchgänge (Apps/
  Navigation, Einkauf/Buchhaltung + Rechnungswesen, Personal/Zeit), Funde umgesetzt:
  - **Fund: `data-confirm` wurde nirgends ausgewertet** – rund 20 Lösch-/Sammelknöpfe (Stelle/Bewerber löschen, Kassen-
    buchung stornieren, „Alle n nicht zuordnen“, „sichere Vorschläge zuordnen“, Ältere Umsätze abhaken, Bank trennen …)
    liefen ohne Rückfrage. Jetzt zentral in `client.ts` (Klick in der Capture-Phase).
  - Apps: Passwort ändern führt in der App zurück zur App; „Meine Zeit“ nur mit verknüpftem Mitarbeiter; Abmelden in der
    Verwaltung; „Arbeit beenden“ fragt nach (vor Plan-Ende deutlich); Urlaubsantrag zurückziehen; Sprache als Globus-Knopf;
    „Zeiten heute“ sortiert nach „nicht gestempelt“ zuerst; Zahnrad = direkt Einstellungen; Offene Posten „x T. überfällig“
    statt Minuszahlen; falsche „neuerer Stand“-Box beim Zurückkommen ohne Änderung entfällt.
  - Einkauf: Freigeben fragt nach, wenn kein Beleg hochgeladen ist oder USt 0 € ohne § 13b; USt wird mit 19 % vom Netto
    vorbelegt, Brutto wird angezeigt; Zahlungsliste „Skonto abziehen“ nur angehakt, wenn Skonto möglich; Kontoumsätze:
    Schild „noch nicht freigegeben“ am Vorschlag (wird beim Zuordnen mit freigegeben); NU-Zeilen im Rechnungseingang am
    Handy ohne Querscrollen.
  - Rechnungen: „Fertigstellen“ nennt das Rechnungsdatum und **warnt beim Zurückdatieren** (älter als die zuletzt
    ausgestellte Rechnung); neuer Kunde mit Feld „Rechnungs-E-Mail(s)“ (→ Gruppe „Standard“); Versand: „Los“ auch oben und
    mit Rückfrage; ausgestellte Rechnung: „Jetzt versenden“ oben, nach Storno Kasten „Als neue Rechnung kopieren“ (der
    Monatslauf rechnet stornierte Leistungsmonate bewusst nicht noch einmal ab).
  - Personal/Zeit: Tariflohn-Auswahl blieb nach Prüffehler unsichtbar (Wiederherstellen löst jetzt `change` aus);
    Offene Urlaubsanträge volle Breite/als Karten am Handy; **Krank im Urlaub** (§ 9 BUrlG): Häkchen „Urlaub an diesen Tagen
    durch Krank ersetzen“ kürzt/teilt/storniert den Urlaub (Protokoll, Stunden neu), ohne Häkchen klare Meldung;
    rückwirkend angelegte Serie und Einsatz vor Eintritt → Hinweis; „Nur diesen Tag umplanen“: Rücksprung zur Herkunft,
    geplante Zeiten in der Beschriftung, Abbrechen, keine Vorauswahl; Nachtrag freigeben bleibt auf der Seite;
    Zeit-Detail: „Endgültig löschen“ eingeklappt unten, nur mit Eintippen von LÖSCHEN; Kalender-Knopf „Serie dieses
    Wochentags löschen“; Unterweisung „an alle“ vorausgewählt + Rückfrage mit Anzahl; Fehlende Unterlagen: Schilder
    verlinkt, Namenssuche, Schlüssel-Text korrigiert; Plan als Ist mit § 17 MiLoG-Hinweis; Startseite „n Nachträge zur
    Freigabe“; Planung „Umplanen“ → „Vertretungen“, Knopf „Mo–Fr“.
  - Neuer Seiten-Rundgang `npm run check:seiten` (alle Seiten PC/Handy, Bericht `var/seiten-check/bericht.json`).
  - **Noch offen (Vorschläge an Ahmed):** Arbeitszeitkonto Soll bis heute + Filter „nur Abweichungen“; „Vertragssoll“ vs.
    „Plan“ einheitlich benennen; CSV Lohnprogramm als bewusster Export mit Rückfrage; Serie „gilt ab Datum“ ändern;
    Mitarbeiter-Kopf aufräumen (Handy-Zugang/Übergaben sichtbar, Zeiten + Kalender zusammen); Staatsangehörigkeit als
    Länderliste; Monatsabschluss auch unter Personal; Entwurf-Knopfreihenfolge, Korrektur zeigt Originalpositionen.
- 2026-10-10: Runde 35 (Ahmed, Antworten auf die Vorschlagslisten):
  - **Staatsangehörigkeit als Länderliste** (Mitarbeiter-Formular, suchbar): Gruppen „EU / EWR / Schweiz – kein
    Aufenthaltstitel nötig“ und „Andere Staaten – Aufenthaltstitel mit Arbeitserlaubnis nötig“ (`src/domain/hr/lists.ts`).
    Alte Freitexte („rumänisch“, „Türkei“ …) werden erkannt und vorausgewählt; nicht erkennbare bleiben als „(bisher)“
    stehen. Die Prüfung „Aufenthaltstitel fehlt“ (Fehlende Unterlagen, Erinnerungen) nutzt die Liste.
  - **Arbeitszeitkonto:** Vertragssoll im laufenden Monat nur bis heute (vorher stand mitten im Monat jeder im Minus);
    Filter Abweichungen (Standard, ab 30 Min.) / über 50 % / ohne Zeiten / alle mit Anzahl; Buchung und Startmonat
    eingeklappt oben.
  - **Begriffe einheitlich:** „Vertragssoll“ = Wochenstunden × 4,33 (Arbeitszeitkonto, Stundenkontrolle, Dispo-Box),
    „Plan“ = Summe der eingeplanten Einsätze (Kalender, Stundenliste, Objekt). Soll/Haben in den Offenen Posten bleibt.
  - **CSV Lohnprogramm** fragt nach (laufender Monat: „Vorab-Abrechnung, Korrektur im Folgemonat“); Monatsabschluss zeigt
    „CSV exportiert am …“ statt einer offenen Handarbeit.
  - **Terminserie ab Datum ändern:** Feld „Änderung gilt ab“ (Standard heute): alte Einsätze enden am Vortag, ab dem Datum
    gilt die neue Fassung (eigene IDs, Zeiten der Vergangenheit bleiben am alten Einsatz; doppelt speichern ändert nichts
    doppelt). Datum ≤ Serienbeginn = ganze Serie wie bisher (`changeShiftSeriesFrom`).
  - **Mitarbeiter-Kopf aufgeräumt:** Reiter Übersicht · Kalender & Zeiten (Zeiten und Einsatzkalender zusammen, alte
    Adresse `/zeiten` leitet um) · Einsätze · Stundenliste · Urlaub & Krank · Dokumente · Übergaben · Handy-Zugang;
    Notizen/Aufgaben unter „Mehr“. Handy-Zugang: Hinweis „ohne eigene PIN“ nur, wenn keine gesetzt ist.
  - **Angebot:** Enthält es monatliche und einmalige Positionen, stehen im PDF und in der Briefansicht zwei Summenblöcke
    („Monatlich netto/brutto“, „Einmalig netto/brutto“) statt einer gemischten Gesamtsumme. Ansprechpartner mit Telefon
    und E-Mail (Profil, sonst Mitarbeiter gleichen Namens) unter den Bedingungen und in der Briefansicht.
  - **Beschriftungen:** Browser verknüpft `<label>` ohne `for` mit dem Feld darunter, Felder in Tabellen bekommen die
    Spaltenüberschrift als Beschriftung (Mahnstufen, Bestell-/Rechnungs-/Angebotspositionen, Nachweise …).
  - **Prüfskript `npm run check:alles`** (`scripts/check-alles.sh`): Format, Lint, Typen, Unit-/DB-Tests (KoSIT muss
    laufen), Seiten-Rundgang PC + Handy (App muss laufen). Rundgang endet rot bei Serverfehlern, JS-Fehlern,
    „undefined/NaN“ im Text oder kaputten PDFs. **Vor jedem größeren Update laufen lassen.**
  - Nicht gemacht (Ahmed: „unnötig“): Monatsabschluss zusätzlich unter Personal.
- 2026-10-10: Runde 36 (Ahmed: Anmeldemaske, Mitarbeiterübersicht, Lieferanten/NU getrennt, Rechnungs-/Angebotsdesign):
  - **Anmeldung neu** (`src/web/login-page.tsx`, für `/anmelden` und `/app`): links Bordeaux-Fläche mit hellem Logo,
    Leitsatz, Siegeln; rechts Formular mit Symbolen, Passwort-Auge, „Wie melde ich mich an?“. Am Handy Bordeaux-Kopf und
    Formular als Karte. Feld-IDs unverändert (Browser-Tests, Passwort-Manager).
  - **Mitarbeiter-Übersicht neu:** Kopf mit Initialen, Status, Tags, Schnellaktionen (Anrufen, WhatsApp, E-Mail,
    Bearbeiten) und Kennzahlenleiste (im Betrieb seit + Dauer, Wochenstunden ≈ Monat, Vergütung, Urlaub, Objekte);
    darunter Beschäftigung | Kontakt, rechts Objekte, Vertraulich (Aufenthaltstitel/Arbeitserlaubnis mit „noch n Tage“ /
    „abgelaufen“), Plan/Ist.
  - **Nachunternehmer und Lieferanten getrennt:** Menü „Einkauf & Nachunternehmer“ → Nachunternehmer (`/nachunternehmer`,
    Ampel-Kacheln, kompakte Tabelle mit Nachweis-Balken, Fehlt/Läuft ab, Status) und Lieferanten (`/lieferanten`, einfache
    Liste mit Ort, Telefon, E-Mail, offene Bestellungen). „+ … anlegen“ setzt die Art vor. Alte Links
    `/lieferanten?art=nachunternehmer` leiten um.
  - **Gestaltungsvorschläge Rechnung/Angebot** (`src/pdf/invoice-design.ts`, Beispiele: `npx tsx scripts/design-proposals.ts
    <Ordner>`): Varianten „klar“, „akzent“, „kompakt“ auf dem Briefpapier; Rechnung jeweils auf **einer Seite** (Zahlung mit
    Bankverbindung und GiroCode im Kasten), Angebot mit Summen monatlich/einmalig, Ansprechpartner und Feld
    „Auftragserteilung“. **Noch nicht aktiv** – Ahmed wählt, dann wird die gewählte Variante für Rechnung, Storno,
    Korrektur, Angebot, AB eingebaut (PDF/A-3 + KoSIT erneut prüfen).
- 2026-10-10: Runde 37 (Ahmed: grüne „Live“-Zeile weg, Siegel aus dem Briefkopf, Design einheitlich/professionell):
  - Umgebungs-Schild (unten links bzw. Kopf der Anmeldung) erscheint nur noch in Test/Lokal, nie im Echtbetrieb.
  - Anmeldung: Siegel aus dem Briefkopf hell direkt auf der Bordeaux-Fläche (`assets/web/siegel-hell.png`, aus
    `siegel.png` erzeugt: weiß, Hintergrund durchsichtig, Schrift ausgespart), Überschrift „Zertifiziert & Mitglied“.
  - **Design 4** (letzter CSS-Block in `layout.tsx`, gilt überall): Grundfläche neutral grau (#f4f4f5), heller
    Bordeaux-Ton nur als Schimmer oben hinter den ersten Karten (PC und App, kein vollflächiges Hellrot mehr); einheitliche
    Überschriften (24/17/15 px), Karten (weiß, Linie, Radius 12), Knöpfe (Bordeaux / weiß mit Rand / Geister / Gefahr,
    Höhe 36 bzw. 30), Felder (38 px, Bordeaux-Fokusring statt Gold), Schilder, Tabellenköpfe; schlichte Aufklapp-Elemente
    (details/summary) mit einheitlichem Pfeil. Gelbe Hervorhebungen (Gesamtbetrag, Summen) → Bordeaux-hell. Rechnung:
    Aktionen als ruhige Liste statt Bordeaux-Block. Zeiterfassung: Seitenkästen weiß mit Bordeaux-Kante statt vollflächig.
    App-Kacheln: lange Wörter brechen um. Auswahlfelder zeigen den vollen Text beim Darüberfahren (gekürzt mit „…“).
- 2026-10-10: Mitarbeiter (Ahmed: „bei Objekte nur aktuelle“): Übersicht „Aktuelle Objekte“ und Mitarbeiterliste zeigen nur
  aktive Objekte mit laufendem oder künftigem Einsatz der Person (`shift_plans` gültig bis heute oder offen), nicht mehr
  die alte Zuordnung Mitarbeiter ↔ Objekt (die bleibt für Stempelrecht/Filter unverändert).
- 2026-10-10: Gestaltungsvorschläge Runde 2 (Ahmed: „gut, aber nicht perfekt“): `src/pdf/invoice-design2.ts` mit Schrift
  **Inter** (SIL OFL, `assets/fonts/inter/`, vollständig eingebettet; kontextabhängige Formen aus, sonst falsche Abstände
  neben Klammern/Strichen), Kapitälchen-Beschriftungen, Haarlinien, Zahlungsleiste Fälligkeit · Bankverbindung · GiroCode.
  Varianten **edel** (Kopfblock mit großer Nummer, Betreff, Betrag mit Bordeaux-Kante), **modern** (Bordeaux-Karte
  „Betrag + fällig am“ oben rechts), **groß** (großer Titel, starke Linien). Rechnung je auf einer Seite; Angebot mit
  Wert-Kacheln monatlich/einmalig, Ansprechpartner-Karte, Auftragserteilung. Beispiele: `npx tsx
  scripts/design-proposals.ts <Ordner>` (Dateien 4–6). **Noch nicht aktiv – Ahmed wählt.**
- 2026-10-10: Runde 38 (Ahmed, 3 Punkte):
  - **Zahnrad (Einstellungen) wieder sichtbar** – war weiß auf der weißen Kopfzeile (alte Regel `.top .right a{color:#fff}`).
  - **Einsatzkalender mit wenigen Farben:** geplant (weiß, grauer Rand), Zeit bestätigt (Bordeaux, auch „ohne Einsatz
    gearbeitet“), keine Zeit erfasst (rot gestrichelt), Urlaub (hellgrün), Krank/Kind krank (hellgelb); läuft/Nachtrag
    offen nur mit Bordeaux-Kante, sonstige Abwesenheit/Ausfall grau durchgestrichen, Feiertage grau statt Gold. Tage mit
    Urlaub/Krank in der Farbe schraffiert. Objekt-Kalender gleich: geplant / Zeit bestätigt / abwesend – Vertretung nötig
    (gestrichelt) / Feiertag-Ausfall (grau).
  - **Word-Vorlagen werden nicht mehr in der Akte abgelegt:** „Word-Dokument herunterladen“ liefert die ausgefüllte
    .docx direkt (`fillWordTemplate`, Protokoll `word_template` ohne Datei); in die Akte kommt der Scan der
    unterschriebenen Fassung. Früher erzeugte Entwürfe (Kategorie „Entwurf (aus Vorlage)“ bzw. laut Protokoll aus
    einer Vorlage erzeugt) werden in den Dokument-Listen ausgeblendet (`listFiles`), bleiben aber write-once im Archiv.
- 2026-10-10: Vorschlag **„edel“ überarbeitet** (Ahmed: „die erste ist sehr schön“): Bankverbindung unten entfernt (steht in
  der Fußzeile des Briefpapiers), Zahlungsblock dafür über die ganze Breite neben dem GiroCode (ohne Verwendungszweck – Ahmed),
  Betreffzeile entfernt, Leistungsort/Objekt jetzt im Kopfblock rechts unter der Nummer (Angebot: „Objekt“).
  Noch nicht aktiv – nach Ahmeds Freigabe für Rechnung, Storno, Korrektur, Angebot, AB einbauen (PDF/A + KoSIT prüfen).
- 2026-10-10: „edel“: Beschriftung „Objekt“ statt „Leistungsort“; drei Positionen zur Auswahl (`objPos`): Kopfblock rechts,
  links unter der Anschrift, schmales Band über der Anrede (Beispiele `4-rechnung-edel-objekt-*.pdf`). Ahmed wählt.
- 2026-10-10: **Gestaltung „edel“ ist aktiv** (Ahmed: „Los“) für Rechnung, Abschlag, Schlussrechnung, Storno,
  Rechnungskorrektur, Angebot, Auftragsbestätigung, Entwurfs-Vorschau und PDFs der Rechnungen vor der Umstellung:
  `src/pdf/invoice-pdf.ts` → `renderInvoiceDesign2` (Variante edel, Objekt als Band über der Anrede). Schrift Inter,
  Kopfblock rechts (Art, große Nummer, Angaben, Seite), Bankverbindung nur in der Fußzeile, Zahlungsbedingung + GiroCode.
  Übernommen aus der alten Gestaltung: Sammelrechnung (kein Band, Objekt-Überschrift + Zwischensumme je Objekt),
  abweichende Leistungszeiträume je Position, mehrere Steuersätze, § 13b-Hinweis, Abschläge mit Datum/USt, Lastschrift
  (ohne GiroCode), Wasserzeichen ENTWURF, feste PDF-Zeitstempel (gleiche Rechnung → gleiche Datei). Neu: Storno/Korrektur
  mit „Zu Rechnung … vom …“ im Kopf; Angebot mit Ansprechpartner-Karte und Feld „Auftragserteilung“ (statt Ansprechpartner
  im Text). Alte Gestaltung bleibt als `renderInvoicePdfClassic` (unbenutzt). **Bereits ausgestellte Rechnungen bleiben
  unverändert (write-once).** KoSIT/ZUGFeRD-Tests grün; **PDF/A-3b mit veraPDF (`npm run check:pdfa`) auf einem Rechner mit
  Docker wiederholen** (hier kein Docker). 491 Unit-/DB-Tests, e2e angebot/auftrag/vorfaktura/mahnung grün.
- 2026-10-10: **Briefe ebenfalls im Stil „edel“** (`renderLetterEdel`, gleiche Signatur wie bisher, `renderLetterPdf` jetzt aus
  `src/pdf/invoice-pdf.ts`): Mahnung, Lieferschein, Material-Bestellung, NU-Kündigung/Nachweisübersicht, Preisanpassungs-
  Anschreiben, Serienbriefe, freie Briefe, Übergabe-/QK-Protokolle, Eigen-Compliance-Vorlagen, Word-Vorlagen als PDF.
  Kopfblock rechts (Art + Nummer groß, sonst nur Angaben und der Titel als fetter Betreff links), Tabelle mit Haarlinien,
  Summe mit Bordeaux-Kante, Unterschrift, GiroCode. Bereits archivierte Briefe bleiben unverändert. Alte Gestaltung als
  `renderLetterPdfClassic` (unbenutzt). 491 Tests, e2e uebergabe/einkauf/nachunternehmer/mahnung/kasse/objekt grün
  (uebergabe einmal 1 Fehler, in drei weiteren Läufen nicht wiederholbar).
- Zur Frage „egal, weil XRechnung?“: Behörden (XRechnung = reines XML) sehen unser Layout nicht; ZUGFeRD-Kunden, Privatkunden,
  Angebote, AB, Mahnungen und Briefe dagegen schon.
- 2026-10-10: **Word-Vorlagen im Stil „edel“** (Ahmed: „Word-Vorlagen auch in diese Stilrichtung“): `scripts/word-restyle.py`
  (`python3 -I scripts/word-restyle.py <Ordner> <Ziel> [--rename]`) stellt nur Gestaltung um: Schrift Inter (Regular +
  SemiBold in jede .docx eingebettet, ~+600 KB je Datei), Text dunkel #1A171A, Abschnitte Bordeaux #7D1435, Titel dunkel,
  Fließtext ~5 % kleiner, Haarlinien hellgrau statt schwarzer Gitter, hellgraue statt gelber Felder, Abstände etwas enger.
  Inhalt, Platzhalter, Kästchen unverändert (geprüft: 41 + 24 Dateien, 0 Abweichungen; Seitenzahl gleich oder weniger).
  Ergebnis an Ahmed: `Viva-Deluxe_Vorlagen-Platzhalter-V4.zip` (Codes -V4 → alte Fassungen werden beim Hochladen
  deaktiviert) und neues Objektordner-Paket. **Ahmed: unter Einstellungen → Word-Vorlagen bzw. Objektordner-Vorlagen
  hochladen.** Word für Mac nutzt eingebettete Schriften ggf. nicht (dann Ersatzschrift) – Inter dort installieren.
  Echte Vorlagen nicht im Repo.
- 2026-10-10: **Objekt auf Mahnung, Zahlungserinnerung, Lieferschein und Bestellung** (Ahmed): gleiches Objekt-Band wie auf der
  Rechnung (`objekt` in `LetterPdfInput`, lange Adresse in zweiter Zeile). Mahnung: betreffen alle Rechnungen dasselbe
  Objekt → Band; sonst Spalte „Objekt“ je Rechnung (Name, Nr., Adresse; Sammelrechnung bis 3 Objekte, sonst „n Objekte“),
  auch für Rechnungen vor der Umstellung (Objekt aus den Positionen). Helfer `invoiceSites()` in `invoices.ts`.
  Lieferschein: ein Objekt → Band, Sammelrechnung → Spalte „Objekt“ je Position. Material-Bestellung: Band mit dem
  Lieferobjekt. Briefe: linksbündige Tabellenspalten brechen jetzt um statt abgeschnitten zu werden (Positionstexte nicht
  mehr gekürzt). **Bereits erstellte Mahnungen bleiben wie archiviert (write-once)** – nur neue zeigen die Objekte.
- 2026-10-10: **Alle übrigen PDFs im Stil „edel“** (Ahmed: „pass auch Bestellungen und alles an“): NU-Bestellschein, Arbeitsschein,
  Objektordner-PDF (Stammblatt, Leistungsverzeichnis, Reinigungs-/Revierplan, eingesetzte Word-Seiten), Listen-PDFs
  (Fehlende Unterlagen, Stundenliste …), Kassenbuch, Tiefgaragen-Aushang, Nachweisblatt digitale Unterschrift: Schrift Inter
  (`src/pdf/fonts.ts`, `embedUiFonts`), dunkle Titel, Kapitälchen-Beschriftungen, Haarlinien, graue Flächen mit Bordeaux-Kante
  (`src/pdf/form-doc.ts`). Word-Seiten im Objektordner-PDF: Farben auf edel abgebildet (Bordeaux, dunkles Grau, Haarlinien).
  ☐/☒/✔ fehlen in Inter → □/■/✓ (`uiText`; DejaVu lässt sich mit fontkit nicht als Teilmenge einbetten). Archivierte PDFs
  bleiben unverändert. 491 Tests grün.
- 2026-10-10: **Inhaltliche Prüfung der Word-Vorlagen** (Ahmed: „Text ändern, löschen?“): 40 Punkte (A rechtlich riskant –
  u. a. eAU statt AU-Vorlage, Vertragsstrafen, Einwilligung § 51 BDSG falsch, Schwerbehinderung/Gesundheit, Zugangsfiktion,
  doppelte Schriftform, Ruhen in Schulferien, Taschenkontrollen, AÜG-Erlaubnis leer, § 34a GewO in Akquise, Mietvertrag
  HeizkostenV; B veraltet – feste Adresse Würmtalstr. 10 in 17 Vorlagen, „Fortytools“ in 12, § 17 UWG, NachwG-Angaben;
  C doppelt – Anwesenheitslisten, FB-06/45/WD, Revierplan-Muster mit Kundendaten; D Tippfehler). Liste an Ahmed; Änderungen
  erst nach seiner Freigabe, Punkte A mit Anwalt.
- 2026-10-10: **Word-Vorlagen V5 – Inhalte überarbeitet** (Ahmed: „pass alles an“, mit Vorgaben): Schulferien = Arbeits-
  verhältnis ruht (neuer Paragraf + Anlage 3; Urlaub in die Ferien, Urlaubsanspruch nur für Tage mit Arbeitspflicht
  = Jahresurlaub × Arbeitstage ÷ 260; > 1 Monat ohne Entgelt → SV-Abmeldung § 7 Abs. 3 SGB IV), Schwerbehinderung bleibt
  (freiwillig), Taschenkontrollen raus, Datenschutz-Anlage 5 neu (Art. 13 + freiwillige Einwilligungen), eAU,
  Vertragsstrafe nur Nichtantritt (≤ ½ Monat), Textform, Fortytools → Viva-Deluxe-App, Befristungen raus (VB, ANS-BV
  gelöscht), Adresse Würmtalstr. bleibt (Ahmed), alle übrigen Prüfpunkte und Tippfehler. Neuer Platzhalter
  `${Mitarbeiter.Briefanrede}`. Beim Hochladen eines V5-Pakets werden VB/ANS-BV/ANW-2026/ANW-2027 deaktiviert
  (`RETIRED_CODES`). Objektordner: Revierplan/LV/Raumbuch aus den Scans (Objekt → Dokumente), **Anwesenheitsliste aus der
  App** (A4 quer, zwei Monate je Seite, `src/pdf/attendance.ts`, `/objekte/:id/anwesenheit.pdf`). Werkzeug
  `scripts/docx-edit.py`. **Ahmed: beide V5-ZIPs hochladen; Arbeitsverträge vom Fachanwalt gegenlesen lassen;
  Datenschutzbeauftragten und Firmenname (Handelsregister) klären.**
- 2026-10-10: Ahmed (5 Punkte):
  - **Automatische Anrede überall** (`src/domain/letter/greeting.ts`): Person mit Anrede → „Sehr geehrte Frau X,“ /
    „Sehr geehrter Herr X,“ (divers/ohne Anrede „Guten Tag Vorname Nachname,“); Ansprechpartner als Text („Frau Dr. Anna
    Müller“, „z. Hd. Herrn Schmidt“) wird gelesen, sonst über die Kontakte des Kunden (Name → Anrede), sonst „Sehr
    geehrte Damen und Herren,“. Gilt für Rechnung/Storno/Korrektur/Angebot/AB (PDF, Briefansicht, Entwurf), Mahnung
    (PDF + Mail), Rechnungs-Mail, freie Briefe (Feld vorbelegt), Serienbriefe (Anrede aus der Vorlage wird ersetzt),
    Mitarbeiter-Briefvorlagen, NU-Nachforderung, alle Briefe ohne eigene Anrede. Word: neuer Platzhalter
    `${Kunde.Briefanrede}` (Akquise-Anschreiben). Bereits ausgestellte/archivierte PDFs bleiben unverändert.
  - **Firmenname laut Handelsregister: „Viva-Deluxe Gebäudereinigung GmbH“** – stand schon so in Firmendaten, Rechnungen,
    Briefen; nur Bild-Alternativtexte/Kommentare korrigiert. Logo-Bild mit „Gebäudedienstleister“ bleibt (Bildmarke).
    D-U-N-S-Hinweis „Gebäudeservice“ damit erledigt.
  - **Erlaubnis Arbeitnehmerüberlassung** (Einstellungen → Firmendaten: erteilt am, Aktenzeichen, Behörde, gültig bis /
    unbefristet; Migration `20261119000002`): füllt `${Firma.AÜ_Erlaubnis_Datum/_Aktenzeichen/_Behörde/_gültig_bis}` in
    den AÜ-Vorlagen; Erinnerung 100 Tage vor Ablauf (rot ab 3 Monaten – Verlängerung spätestens 3 Monate vorher,
    § 2 Abs. 4 AÜG). Vorlagen V6 (AÜ-Vertrag, ZV-AÜ ohne Satz „ohne Erlaubnis nicht verwenden“, Akquise-Anschreiben),
    ZIP `Viva-Deluxe_Vorlagen-Platzhalter-V6.zip` (übrige Dateien V5, nichts doppelt beim Hochladen).
  - Datenschutzbeauftragter: noch keiner – Pflicht ab 20 Personen, die ständig automatisiert personenbezogene Daten
    verarbeiten (§ 38 BDSG; Reinigungskräfte, die nur selbst stempeln, zählen in der Regel nicht, Objektleitungen mit der App schon). Anlage 5 enthält keine DSB-Zeile.
- 2026-10-10: **Objektordner fertig ausgefüllt, ohne Unterschriften** (Ahmed: „alles bereits ausgefüllt, Unterschriften
  und sowas weg“):
  - Neue Angaben je Objekt (Objekt → Objektordner, gruppiert): Hausmeister/Haustechnik, nächstes Krankenhaus,
    Sammelplatz, Feuerlöscher, Verbandkasten, Notausgang, Hauptabsperrung Wasser, Hauptschalter Strom,
    Brandmelderzentrale, Müll-Sammelplatz, Abfuhrtage. Firmenweit unter Einstellungen → Objektordner-Vorlagen:
    Betriebsarzt, Hautschutz-/Reinigungs-/Pflegeprodukt, Reinigungsmittel mit Dosierung (Tabelle, bis 8 Zeilen;
    Tabelle `app.site_folder_defaults`, Migration `20261119000003`). „Letzte Überprüfung“ = Erstellungsdatum,
    Word-Datumsfelder = heute.
  - Bereinigung (`cleanFolderXml`, gilt für PDF und ZIP): Unterschriftsblöcke („Datum, Objektleitung“ …),
    Kenntnisnahme-Listen und -Überschriften, Abhak-Spalten (☐/„Erledigt“) entfernt; Zeilen/Absätze, die nach dem
    Ausfüllen noch eine Lücke hätten, fallen weg (fehlende Angaben zeigt die Objektseite). Aushänge (Betriebsanweisungen,
    Putzraum) jetzt aus den Word-Quellen statt aus dem fertigen PDF mit Unterschriftszeilen.
  - Nicht mehr im Ordner (Leerformulare, laufen über die App): Reklamationsmeldung (Tickets), Objektübernahmeprotokoll
    (Anlaufplan), Abfallkonzept (mit dem Kunden abzustimmen), Arbeitszeit-/Stundennachweis (Zeiterfassung,
    Arbeitsscheine), statische Prüfliste. Bleibt: Anwesenheitsliste.
  - Anwesenheitsliste: Spalte „Uhrzeit Ausführung“ statt „von – bis“; Seitenkennung auf Querseiten am rechten Rand
    (stand mitten im Blatt).
- 2026-10-10: **Lohn in Word-Vorlagen** (Ahmed: „Gehalt bzw. Stundenlohn wird nicht übernommen“): Vorlagen waren richtig;
  leer blieb es bei Mitarbeitenden ohne hinterlegte Vergütung (aus Fortytools übernommen, `pay_model` leer). Jetzt je
  Vergütungsart: Tarif → Tariflohn der Lohngruppe, individuell → eigener Stundenlohn, Festgehalt → Gehalt (Stundenlohn
  umgerechnet Gehalt × 3 ÷ 13 ÷ Wochenstunden); ohne Vergütung → niedrigster aktiver Tariflohn mit gelbem Hinweis auf
  „Angaben prüfen“ (Stammdaten aufgeklappt, Link zum Nachtragen). `Mitarbeiter.Gehalt` ist nur noch ein Monatsbetrag
  (bei Stundenlohn × Wochenstunden × 4,33) – vorher stand der Stundenlohn als „monatliches Bruttogehalt“ im OL-Vertrag.
  **Ahmed: Vergütung bei allen Mitarbeitenden nachtragen (Liste „Vergütung fehlt“).**
- 2026-10-10: **Mitarbeiter-Vorlagen passend zur Person** (Ahmed: „Arbeitnehmer/Arbeitnehmerin unterscheiden, leichte
  Schattierung über der Unterschrift Arbeitnehmer“), `src/services/word-gender.ts`, wirkt beim Erzeugen jeder
  Mitarbeiter-Vorlage (kein neues Hochladen nötig): Bei Anrede Frau/Herr werden Doppelformen aufgelöst – „Der/die
  Arbeitnehmer/in“ → „Die Arbeitnehmerin“/„Der Arbeitnehmer“, dem/der, den/die, des/der (+ Genitiv „des Arbeitnehmers“),
  er/sie, ihm/ihr, seiner/ihrer, Neue/r, erste/r, Beauftragte/r, Mitarbeiter/Vorarbeiter/Objektleiter/Stelleninhaber/
  Ansprechpartner/in; nicht verändert: Mehrzahl „…/innen“, andere Personen (Bereichsleiter/in), „des/der ${…}“. Ohne
  Anrede (divers/leer) bleibt die Doppelform. Unterschriftsfeld der Person hellgrau (#EEEBED) in Unterschriftshöhe – für
  alle drei Bauarten der Vorlagen (Linie unter leerem Absatz, Zellenlinie, Absatzlinie über der Beschriftung); Linien in
  derselben Zeile auf gleicher Höhe. Geprüft an allen 26 Mitarbeiter-Vorlagen des Pakets.
- 2026-10-10: Unterschriftsfeld heller (#F6F4F5). **Festgehalt im Arbeitsvertrag:** Satz „erhält den Tariflohn von derzeit
  … EUR brutto pro Stunde“ wird bei Vergütungsart Festgehalt automatisch zu „erhält ein festes monatliches Bruttogehalt in
  Höhe von … EUR“ (`salaryClause`). **Umrechnung Festgehalt → Stundensatz jetzt Gehalt ÷ 4,33 ÷ Wochenstunden** (Ahmed;
  vorher × 3 ÷ 13 = ÷ 4,333…, Unterschied < 0,1 %) – Vorlagen, Nachkalkulation, Mindestlohn-Prüfung
  (`app.effective_wage_cents`, Migration `20261119000004`). **Mindestlohn:** Gehalt ÷ 4,33 ÷ Wochenstunden muss mindestens
  den Branchen-Mindestlohn erreichen; Mehrarbeit ist nicht automatisch abgegolten (Zuschläge nach RTV bleiben).
- 2026-10-10: **PDF/A-3b für die Gestaltung „edel“ bestanden** (Rechnung, Storno, Schlussrechnung, Lastschrift; veraPDF 1.30.3,
  Inter vollständig eingebettet). `npm run check:pdfa` läuft jetzt auch ohne Docker (veraPDF-CLI über Maven, Cache
  `~/.cache/verapdf`, Java + mvn nötig).
- 2026-10-10: **Systemwächter / Ausfallmeldung** (Ahmed: „Meldung, wenn der Server ausfällt“): Die App prüft alle 5 Min.
  Datenbank, KoSIT, Speicherplatz (rot < 5 GB/5 %, gelb < 15 GB/15 %), tägliche Sicherung (älter als 26 Std. oder verdächtig
  klein = Störung) und im Echtbetrieb den Mailzugang (`src/services/watchdog.ts`, Zustand `app.system_checks`, Migration
  `20261120000001`). Störung → E-Mail an `ALERT_EMAIL` bzw. Erinnerungs-Empfänger (sonst Firmen-E-Mail), höchstens einmal
  je Störung und Tag, Entwarnung bei Behebung; Mail fehlgeschlagen → nächster Durchlauf versucht es erneut. Störungen stehen
  unter Erinnerungen (Bereich „System“) und auf **Einstellungen → Systemzustand & Ausfallmeldung** („Jetzt prüfen“).
  `/health/voll` (ohne Anmeldung) antwortet „ok“ oder 503 „STOERUNG: <Prüfungen>“ – für den externen Wächter, denn ein
  ausgefallener Server kann sich nicht selbst melden. Sicherung: `backup.sh` schreibt `status/letzte-sicherung.txt`, nur
  dieser Ordner ist schreibgeschützt in den Container eingebunden (`BACKUP_DIR=/sicherung`), optional Ping an
  `BACKUP_PING_URL` (healthchecks.io). Anleitung `docs/anleitung-ueberwachung.html/.pdf`.
- 2026-10-10: **Revisionssicheres Archiv (S3 Object Lock)**: `src/archive/s3.ts` (eigene Signatur V4 ohne SDK, gegen
  AWS-Beispielwerte getestet; PUT mit `x-amz-object-lock-mode: COMPLIANCE`, Content-MD5, Prüfung per HEAD),
  `src/services/archive-replica.ts`: alle 10 Min. werden alle Dateien unter ARCHIVE_DIR und aus FILES_DIR nur
  Buchungsbelege (Dateien an Eingangsrechnungen/Rechnungen, eingelesene E-Rechnungen, Lohnabrechnungen) kopiert,
  Sperre bis 31.12. des 10. Folgejahres; Stand je Datei in `app.archive_replicas` (Migration `20261120000002`), Fehler
  nach 30 Min. erneut, je Lauf bis 300 Dateien/2 GB, nichts doppelt. Ohne eingeschaltetes Object Lock im Bucket wird
  nichts kopiert. Personalakte/Fotos/Ausschreibungen bewusst nicht gesperrt (DSGVO-Löschpflichten). Einstellungen →
  Revisionssicheres Archiv (Stand, Fehler, „Jetzt sichern“), Systemwächter-Prüfung (Speicher weg / Object Lock aus /
  Dateien > 24 Std. ohne Kopie = Störung; nicht eingerichtet = gelber Hinweis). Getestet gegen moto (S3-Nachbau,
  `moto_server -p 5055`, Test wird ohne übersprungen). Anleitung `docs/anleitung-archiv.html/.pdf`.
- 2026-10-10: **Zahlungsbedingung als Auswahl** (Ahmed: „nicht hinschreiben, sondern auswählen“): Rechnungsgruppe und „Neuer
  Kunde“ mit Liste (`src/domain/invoice/payment-terms.ts`, Feld `PaymentTermsField`): **Standard 10 Tage netto ohne
  Skonto**, sofort, 7/14/20/30/45/60 Tage netto, 14 Tage/2 % in 7, **20 Tage/3 % in 7**, 30 Tage/2 % in 10, 30 Tage/3 % in
  10, 30 Tage/3 % in 14, 60 Tage/3 % in 14; „andere …“ blendet Tage/Skonto-Felder ein (z. B. übernommene Sonderfälle,
  Anzeige „bisher: …“). Neue Kunden ohne Angabe = 10 Tage. Bestehende Kunden/Gruppen unverändert. Rechnungsentwurf:
  Auswahl um 20 Tage ergänzt. Allgemein neu: `<select data-reveal="#…">` zeigt Felder nur bei „andere“.
- 2026-10-10: **Fund Archiv „Object Lock nicht eingeschaltet“** (Ahmed nach Einrichtung bei IONOS): Jede 404-Antwort galt als
  „nicht eingeschaltet“ – auch falscher Bucket-Name/Endpunkt; Abweichungen der Anbieter-Antwort wurden nicht erkannt. Jetzt:
  Bucket nicht gefunden / Zugang abgelehnt (Schlüssel, Region) mit eigener Meldung; meldet der Bucket keine Sperre, prüft
  die App mit einer Probedatei (`_pruefung/object-lock-<Datum>.txt`, Compliance-Sperre 2 Tage) und nimmt das Ergebnis
  (6 Std. gemerkt). Die Seite zeigt den genauen Grund (`S3Client.lockStatus`).
- 2026-10-10: **Ausgaben vor Juli fehlen** (Ahmed): Der Bankabruf holt beim ersten Mal nur 90 Tage (ab ~Mitte Juli). Neu unter
  Einstellungen → Bankabruf: **„Ältere Umsätze nachladen ab <Datum>“** (Standard 01.01.), nichts doppelt. Viele Banken geben
  > 90 Tage nur kurz nach einer neuen TAN-Freigabe heraus (PSD2) – sonst Kontoauszug als CAMT/CSV einlesen.
- 2026-10-11: **Anleitung IONOS Cloud Backup** (`docs/anleitung-cloud-backup.html/.pdf`): Agent (1,2 GB) direkt auf dem Server
  laden (wget) bzw. per scp, Installation mit Token, Schutzplan „Viva täglich“ 04:00 (nach der App-Sicherung 02:30) mit
  `/opt/viva-sicherung` (ohne `dateien_*.tar.gz` – täglich komplett neu, würde den Speicher füllen), Docker-Speicher
  `deploy_daten/_data` (inkrementell) und `.env.live`, verschlüsselt, 30 Tage; Test-Wiederherstellung mit `pg_restore --list`,
  Ernstfall-Ablauf, Störungen.
- 2026-10-11: Ahmed: AVV IONOS und GitHub-Token erledigt; autoaid-API nicht nötig; Behörden-Abfrage (Portal/Leitweg) gestrichen;
  Landeshauptstadt München zahlt nach eigenem Zahlungsplan und will keine Rechnung zugeschickt (Ahmed bestätigt: keine Abrechnung durch die Stadt) → Versandweg „kein Versand“ passt, Rechnung wird trotzdem ausgestellt und archiviert; kein § 14c-Risiko.
- 2026-10-11: **Ausfallzeiten für die Kalkulation** (Ahmed: Krankheit/Urlaub, Durchschnitt, PDF/Excel, Namen schwärzbar):
  Auswertungen → **Ausfallzeiten (Kalkulation)** (`/auswertungen/ausfallzeiten`, Admin/Personal/Buchhaltung): je Jahr und
  Mitarbeiter Tage Mo–Fr im Beschäftigungszeitraum, Feiertage, Urlaub, Krank (inkl. Kind krank, Fälle), anwesend; Durchschnitt
  je Beschäftigungsart und gesamt: Ø Urlaub/Krank je Vollzeit-Jahr (Teiljahre anteilig), Kranken-/Urlaubsquote,
  **Ausfallquote** = (Feiertage + Urlaub + Krank) ÷ Tage Mo–Fr, **Ausfallzuschlag** = (Feiertage + Urlaub + Krank) ÷
  Anwesenheitstage (Aufschlag auf die gearbeitete Stunde). Halbe Tage 0,5; laufendes Jahr bis heute; übernommene
  Fortytools-Stände zählen bis zum Stichtag, App-Abwesenheiten danach. Export **PDF** und **Excel (.xlsx)** mit Häkchen
  „Namen schwärzen“ (Mitarbeiter/in 001 …) – auch auf Urlaubskonten und Krankheitstage. Eigener xlsx-Schreiber
  `src/domain/sheet/xlsx-write.ts` (Texte nie als Formel). Teilzeit mit < 5 Tagen/Woche = Näherung.
  **Datenschutz:** Krankheitstage sind Gesundheitsdaten (Art. 9 DSGVO) – zum Weitergeben (Steuerberater, Kalkulation,
  Ausschreibung) die geschwärzte Fassung nutzen. Tests `absence-stats.db.test.ts`, `xlsx-write.test.ts`.
- 2026-10-11: **Urlaub ohne Anspruch + Warnung** (Ahmed): Urlaub über den Rest hinaus wird im Büro/in der App der
  Objektleitung nicht mehr abgelehnt, sondern nachgefragt („Wirklich Urlaub eintragen?“ → „Ja, trotzdem eintragen“ sendet
  dasselbe Formular mit `urlaub_ohne_anspruch=1`; gilt für Erfassen, Ändern, Genehmigen; Vermerk im Protokoll). Die
  Mitarbeiter-App (`/m`) lehnt weiter ab (Antrag ohne Anspruch). **Warnung „kein Resturlaub“**: aktive Mitarbeitende mit
  Rest ≤ 0 im laufenden Jahr bzw. < 0 im Folgejahr – unter Erinnerungen, oben in Auswertungen → Urlaubskonten und beim
  Mitarbeiter (Urlaub & Krank); „als erledigt markieren“ (einzeln/alle, `app.leave_warning_acks`); sinkt der Rest danach
  weiter, kommt die Warnung wieder (`src/services/leave-warnings.ts`, 10 Min. zwischengespeichert, bei Änderung verworfen).
- 2026-10-11: **Schulen: Schulferien automatisch** (Ahmed): Objekt → Übersicht → „Als Schule markieren“
  (`sites.school_closure`, nur Admin/Personal) → „Vorschau & eintragen“ (`/objekte/:id/schulferien`). Für alle, die künftig
  an Schul-Objekten eingeplant sind, je Ferienzeitraum (Schulferien Bayern + Buß- und Bettag, `schoolFreePeriods`):
  Resturlaub des Jahres anteilig auf die Ferien verteilt (Übertrag aus dem Vorjahr nur bis 31.03.), Urlaub jeweils in der
  Mitte des Zeitraums, Rest „Unbezahlt frei“ (`absences.auto_school`, feste IDs). Übersprungen mit Grund: Person arbeitet
  im Zeitraum auch an einem Nicht-Schul-Objekt, oder es gibt schon eine Abwesenheit. Jahre mit unvollständigen
  Ferienterminen (2027 nur bis Sommer): Urlaub nur anteilig (bekannte ÷ Ferientage des letzten vollständigen Jahres).
  Server prüft alle 6 Std. automatisch (neue Mitarbeitende/Einsätze). Hinweis bei > 1 Monat unbezahlt am Stück
  (§ 7 Abs. 3 SGB IV, SV-Abmeldung). **Rechtlich:** unbezahlt nur mit Ruhens-Klausel im Vertrag (Vorlagen V5); Urlaubs-
  anspruch dann nur für Tage mit Arbeitspflicht (Jahresurlaub je Mitarbeiter so hinterlegen). **Schulferien nach Sommer
  2027 in `src/domain/time/school-holidays.ts` ergänzen.** Migration `20261121000001`, Test `school-leave.db.test.ts`.
- 2026-10-11: **Cloud Backup läuft** (Acronis-Agent über Benutzername/Passwort angemeldet – Token-Anmeldung an eu2-cloud
  scheiterte mit 401; erste Sicherung komplette Maschine erfolgreich). Standard-Plan war Mo–Fr und unverschlüsselt →
  Anleitung `docs/anleitung-naechste-schritte.html/.pdf`: eigener Plan „Viva täglich“ (Mo–So 04:00, verschlüsselt),
  alten widerrufen, root-Passwort (`passwd`), SMTP/ALERT_EMAIL, UptimeRobot, healthchecks.io, Probe-Wiederherstellung.
- 2026-10-11: **Tariflohn 1 vorbelegt** (Ahmed: „bei allen Tariflohn 1, ich ändere die Handvoll ab“): Migration
  `20261122000001` setzt bei allen Mitarbeitenden ohne Vergütung (kein individueller Lohn, kein Festgehalt, keine
  Lohngruppe) Vergütung = Tarif, Lohngruppe „Tariflohn 1“. Geänderte IDs im Protokoll (`audit_log` action
  `tariflohn1_vorbelegt`) – rücknehmbar. Abweichungen ändert Ahmed je Mitarbeiter (Stammdaten bearbeiten → Vergütung).
- 2026-10-11: Ahmed (Punkte 8–10 + alte Vorlagen):
  - **Objektliste zeigt standardmäßig nur aktive Objekte** („Alle“ = `status=alle`), wie schon Kunden (`kunde`) und
    Mitarbeiter (`aktiv`).
  - **Abgemeldet beim Speichern:** Ohne gültige Sitzung gab ein abgeschicktes Formular nur „Anmeldung erforderlich“ (401,
    leere Seite) – Neuladen nötig. Jetzt geht jedes Formular (Seitenwechsel) zur Anmeldung mit Hinweis und danach zurück auf
    die Formularseite; die Eingaben stellt der Browser wieder her (sessionStorage), einmal neu speichern. Abgelaufene
    Sitzung beim Seitenaufruf → Hinweis „Sitzung abgelaufen“. fetch()-Aufrufe (Uploads, Suche) bekommen weiter 401.
    **„Angemeldet bleiben“** (Häkchen, Standard an) auf `/anmelden` und `/app`: Sitzung 30 Tage statt 12 Std. – auf
    fremden/gemeinsamen Rechnern abwählen.
  - **Benutzername änderbar** (Einstellungen → Benutzer → Person): Regeln wie beim Anlegen, nicht nur Ziffern (App-Anmeldung
    unterscheidet daran Personalnummer/Benutzer), eindeutig; Aufgaben (Zuständig/angelegt von) ziehen mit, Passwort und
    Sitzung bleiben, Protokoll `rename`.
  - **Alte Word-Vorlagen gelöscht** (Ahmed: „komplett löschen“): Migration `20261122000002` löscht alle deaktivierten
    Vorlagen (lokal 82 von 118) samt Verknüpfung; Dateien bleiben write-once im Archiv. Hochladen einer neuen Fassung
    löscht die alte künftig gleich mit (statt deaktivieren).
- 2026-10-11: **Liquiditätsvorschau** (Startseiten-Karte, 8 Wochen, nur wer Kontoumsätze sieht; `src/services/liquidity.ts`):
  Kontostand heute (Bankabruf) + offene Ausgangsrechnungen nach Fälligkeit (überfällige in Woche 1) + erwartete
  Monatsrechnungen noch nicht abgerechneter Monate (Umsatz-Vorschau × 1,19, Eingang ~20.) − offene Eingangsrechnungen
  (abzüglich Vorschüsse) − laufende Ausgaben ohne Eingangsrechnung (Ø der letzten 3 Monate aus den Kontoumsätzen, Lohn,
  Steuern …). Schätzung, Engpass-Woche wird markiert.
- 2026-10-11: **Push-Nachrichten** (Ahmed: „wichtig“) über Web Push – ohne Firebase. Knopf „Benachrichtigungen einschalten“ in
  der Mitarbeiter-App (`/m`) und der Verwaltungs-App (`/qm`); Android immer, **iPhone ab iOS 16.4 nur, wenn die App über
  „Zum Home-Bildschirm“ installiert ist**. VAPID-Schlüssel einmalig erzeugt (privater Teil verschlüsselt, `app.push_config`),
  Abos `app.push_subscriptions` (ungültige werden gelöscht), jede Nachricht genau einmal (`app.push_sent`). Server prüft
  jede Minute: neues Dokument zum Unterschreiben, Einsatzplan geändert, Vertretung, Antrag genehmigt/abgelehnt
  (→ Mitarbeitende); neuer Urlaubsantrag, Nachtrag zur Freigabe (→ Admin/Personal + Objektleitung des Objekts);
  Pausen-Erinnerung nach ~6 Std. Inhalte knapp, keine Gesundheitsdaten/Beträge (Sperrbildschirm). Migration
  `20261122000003`. Neue Abhängigkeit `web-push` 3.6.7.
- 2026-10-11: **Lohnabrechnungen aus Lexware Financial Office Pro** (Ahmeds ZIP: je Person ein Ordner,
  `Lohnabrechnung_2025_August_1234_Name.pdf`): Personalnummer und Monat aus dem Dateinamen; **Monat wird je Datei erkannt**
  (Lexware-Dateiname, sonst „Abrechnungsmonat …“ im Text) → gemischte ZIP mit mehreren Monaten geht, die Monatsauswahl gilt
  nur noch für Dateien ohne erkennbaren Monat. Dateiname in der Personalakte jetzt „Lohnabrechnung 2025-08 August 2025 –
  Name (1234).pdf“ (ältere Dateien sind unveränderbar, werden aber genauso angezeigt). Probe mit der echten ZIP: 74 von 75
  zugeordnet (eine Personalnummer gibt es in der App nicht – wird gemeldet).
- 2026-10-11: **Qualitätskontrolle: Auswertungsbericht, Statistik, Löschen** (Ahmed, Vorlage Neumann & Neumann):
  - **Auswertungsbericht (PDF)** an jeder Kontrolle (`/qualitaet/<id>/auswertung.pdf`, Stil „edel“, `src/services/qm-report.ts`):
    Kunde/Objekt/Prüfer/Prüfdatum, Kacheln Ergebnis / geprüfte Einheiten / Mängel / Änderung zum letzten Audit, Kommentar,
    **Ampel** (Einheiten unter Schwellwert / bis Ziel / im Ziel), **Qualitätsverlauf** des Objekts (Linie mit Schwellwert und
    Zielbereich), **Leistungsgruppen** (= Nutzungsarten) und **Leistungsbereiche** (neu am Kontrollgegenstand: Obenarbeiten,
    Sanitär und Nassbereiche, Bodenreinigung …) je mit Einheiten, Mängeln, Qualität, Änderung + Balken, **Top 10
    Verbesserungspotentiale** (Kontrollgegenstand, Tätigkeit = neue Beschreibung, Bewertungen, Qualität), durchgeführte
    Prüfungen, geprüfte Einheiten mit Uhrzeit, **Mängelliste** je Raum mit Fotos (JPG/PNG), Unterschrift. Mangel = Bewertung
    unter dem Schwellwert. Ältere Kontrollen ohne Noten: in Ordnung = 100 %, Mangel = 0 %. Das bisherige Prüfprotokoll
    (archiviert) bleibt daneben.
  - **Statistik** (`/qualitaet/statistik`, Knopf in der Liste der Qualitätskontrollen): Zeitraum, Kunde, Objekt; Ø Ergebnis,
    Audits, Einheiten, Mängel, Verlauf je Monat, Leistungsbereiche/-gruppen, Top 10, Objekte mit Trend; als PDF.
    Objektleitung nur eigene Objekte.
  - **Einstellungen → Kontrollgegenstände:** Leistungsbereich und Tätigkeit/Beschreibung je Gegenstand (Standardgegenstände
    vorbelegt), **Schwellwerte** (Standard 80 % / Zielbereich ab 88 % wie N&N, `app.qm_settings`).
  - **Löschen** (unten an der Kontrolle): Entwurf jeder mit Zugriff aufs Objekt; abgeschlossene nur Admin – Stand ins
    Protokoll, offene Nachbesserungs-Aufgaben entfallen, Prüfbericht/Fotos bleiben write-once im Archiv, Tickets bleiben.
    Migration `20261122000004`. Test `qm-report.db.test.ts`.
- 2026-10-11: **Gewichtung der Kontrollgegenstände** (Ahmed, wie Neumann & Neumann: „Boden nicht gereinigt ist schlimmer als
  Steckdose vergessen“): Einstellungen → Kontrollgegenstände → Gewichtung 1 gering / 2 normal / 3 wichtig / 4 sehr wichtig /
  5 kritisch (vorbelegt: WC 5, Boden/Waschbecken/Verbrauchsmaterial 4, Abfall/Küche 3, Türen/Heizkörper/Fensterbänke/Glas/
  Spinnweben 1, Rest 2). Raumergebnis = gewichteter Durchschnitt (QM-App, Abschluss, Bericht, Statistik); Top 10
  Verbesserungspotentiale nach (100 % − Qualität) × Gewicht × Anzahl. Gewicht wird je Bewertung festgehalten
  (`quality_check_ratings.weight`) – spätere Änderungen verändern alte Audits nicht. Migration `20261122000005`.
- 2026-10-11: **Lexware ASCII-Import** (Ahmed: „ASCII also ANSI-Import“): Stundenliste & Lohnarten → Knopf „Lexware (ASCII)“
  (`/zeiterfassung/lohnarten-lexware.txt`): Windows-1252, Semikolon, Dezimalkomma, CRLF, ohne Kopfzeile, je Zeile
  Personalnummer;Lohnart-Nr.;Stunden;Betrag (Betrag nur bei Zuschlägen), Korrekturzeilen Vormonat mit Stunden-Differenz,
  nur Lohnarten mit Nummer, nie „Unbezahlt“. Export wird festgehalten wie die CSV. **Ahmed: in Lexware einmal die
  ASCII-Importvorlage mit diesen 4 Feldern anlegen und die Lohnart-Nummern unter Einstellungen → Zuschläge & Lohnarten
  eintragen; ersten Import gemeinsam prüfen.**
- 2026-10-11: **Arbeitstage pro Woche mit Verlauf + Resturlaub** (Ahmed: „ab 01.11. weniger Tage, dadurch weniger Urlaub“):
  Mitarbeiter-Formular „Arbeitstage/Woche“ (0,5–7, halbe Tage) mit „Stunden/Tage gültig ab“ → `employee_hours.days_per_week`
  (nur anhängen), `employees.days_per_week` = heute gültiger Wert (Stichtag in der Zukunft übernimmt der Server). Der
  Urlaubsanspruch in den Stammdaten gilt für die 5-Tage-Woche; **je Beschäftigungsmonat anteilig nach den dann gültigen
  Arbeitstagen** (Monat mit Wechsel tageweise gewichtet, auf halbe Tage gerundet) – z. B. 30 Tage, ab 01.11. 3 Tage →
  2026: 28 Tage, 2027: 18 Tage. **Urlaubstage zählen nur an Arbeitstagen der Person** (`leaveDaysOf`: bei < 5 Tagen die
  eingeplanten Wochentage, ohne Planung Mo–Fr × Tage ÷ 5) – eine Urlaubswoche kostet bei 3-Tage-Woche 3 Tage. Gilt für
  Urlaubskonto, Anspruchsprüfung, Warnung. Leer (Import) = unverändert. Übersicht: Kachel **Resturlaub** des laufenden
  Jahres (darunter Anspruch), Stammdaten zeigen Arbeitstage/Woche. **Rechtlich:** Vor der Reduzierung erworbener Urlaub
  wird nicht gekürzt (EuGH C-486/08, BAG 9 AZR 53/14) – das erfüllt die monatsweise Rechnung. Migration `20261122000006`,
  Test `days-per-week.db.test.ts`.
- 2026-10-11: **Raumbuch-Import Fortytools-Format + Raumbuch-PDF** (Ahmed: „Raumbuch geht immer noch nicht“, Datei Grundschule
  Neubiberg): **Fund:** Die Fläche heißt im Fortytools-Raumexport „Größe in m²“ – unbekannt → „Spalte Fläche fehlt“; außerdem
  belegten „Gebäudeteil“ und „Etage“ dasselbe Feld (Etage ging verloren). Jetzt: „Größe (in m²)“ als Fläche, eigenes Feld
  Gebäudeteil (zusammen mit der Etage „A · UG“), „Beschreibung“ → Hinweise; „Kundennummer“, „für dieses Objekt“, „Revier“
  werden ignoriert, Intervall fehlt dort → Auswahl „täglich“ wie bisher. 0 m² (Kriechkeller) wird mit klarer Meldung
  übersprungen. Probe mit der echten Datei: 234 von 235 Räumen. **Raumbuch als PDF** (Stil „edel“, Logo/Briefpapier;
  Übersicht je Nutzungsart mit Anteil, Räume je Gebäudeteil/Etage mit Summen, Hinweise; `src/services/room-pdf.ts`): wird
  nach jedem Import automatisch unter Objekt → Dokumente (Kategorie „Raumbuch“) abgelegt, ältere App-Fassung ins Archiv;
  Knöpfe „PDF“ und „PDF in Dokumente ablegen“ am Raumbuch. Test `room-import-ft.db.test.ts`.
- 2026-10-11: **Raumbuch-PDF und QK-Auswertungsbericht schlank** (Ahmed: „kürzer, fetten Briefkopf brauchen wir nicht, Angaben
  unten weg, nur Logo oben“): `FormDoc.create({ plain: true })` – kein Briefpapier (kein Briefkopf, keine Fußzeile mit
  Bank/Siegeln), nur Logo oben links, Inhaltsbereich 74–806 pt statt 128–702 (Raumbuch Neubiberg 9 → 7 Seiten). Gilt für
  Raumbuch-PDF, Auswertungsbericht und Qualitätsstatistik; Rechnungen, Briefe, Bestellscheine bleiben auf dem Briefpapier.
- 2026-10-11: Lexware-Export „enthält nichts“ (Ahmed): Lohnarten ohne Lohnart-Nummer werden nicht exportiert – auf dem Server
  waren keine Nummern eingetragen → leere Datei. Jetzt keine leere Datei mehr, sondern Meldung mit den fehlenden Lohnarten
  (bzw. „keine Stunden im Monat“), Export wird dann nicht festgehalten; gelber Hinweis in der Ansicht Lohnarten mit Link
  zu Einstellungen → Zuschläge & Lohnarten. **Ahmed: Lohnart-Nummern aus Lexware (Normalstunden, Urlaub, Krank, Feiertag,
  Zuschläge) dort eintragen.**
- 2026-10-11: Export für Lexware buchhaltung wieder entfernt (Ahmed: „brauche ich nicht“) – Buchhaltung bleibt beim
  Steuerberater (DATEV-Export). Lohn-Export „Lexware (ASCII)“ bleibt.
- 2026-10-11: **Lexware Lohn ASCII-Import neu** (Ahmed: Felder „Jahr, Monat, Personalnummer, Lohnartnummer, Wert“): je Zeile
  `Jahr;Monat;Personalnummer;Lohnartnummer;Wert` (Windows-1252, Semikolon, Dezimalkomma, ohne Kopfzeile, Monat ohne
  führende Null). Wert = Stunden bei Normalstunden/Aushilfslohn/Urlaub/Krank/Feiertag, Euro-Betrag bei Zuschlägen (unsere
  Sätze) und Gehältern; Korrekturen des Vormonats im Exportmonat. Lohnarten „Sonstige bezahlte Abwesenheit“ (zählt jetzt
  als Normalstunden) und „Unbezahlt“ (keine Lohnart mehr) entfernt; neu **Aushilfslohn (Minijob)** (Minijob mit
  Stundenlohn statt Normalstunden), **Gehalt**, **Aushilfsgehalt (Minijob)**, **Geschäftsführergehalt
  GmbH-Gesellschafter** (Vergütung Festgehalt; Geschäftsführer über Tag „Geschäftsführer“; anteilig nach Kalendertagen
  bei Ein-/Austritt; bei Festgehalt keine Grundlohn-Stunden im Export). Hinweis fehlender Nummern nur für Lohnarten, die
  im Monat vorkommen. Ältere Vorab-Exporte werden für die Korrektur umgerechnet. Test `payroll-lexware.test.ts`.
- 2026-10-11: **Raumbuch aus Ausschreibungs-Kalkulation** (Ahmed: „egal wie die Kalkulation aussieht ein Raumbuch erstellen“,
  Kalkulationstabelle Neubiberg mit 16 Blättern): Der Import liest jetzt alle Blätter einer Excel-Datei und nimmt das mit der
  besten Kopfzeile (`readSheets`). Neu erkannt: Reinigungstage/Jahr (gehen vor dem Turnus – Schule W5 = 216 statt 260),
  Turnus-Kürzel W1–W7 / M1–M4 / Q1 / J1–J12 / 0 = keine Reinigung (Räume ohne Reinigung bleiben im Raumbuch,
  `rooms.visits_per_year` ab 0, Kürzel in `rooms.turnus`, Migration `20261122000007`), Leistung m²/h
  (→ `performance_override`), Stunden/Jahr, Tageskraft (→ Hinweis). Raumart ohne eigene Spalte „Raum“ = Raumname; Nutzungsart
  über Stichwörter (WC → Sanitär / WC, Kabine/Dusche → Umkleide, Treppe → Flur …, `guessRoomType`), Unbekanntes → „Sonstiges“
  statt vieler neuer Nutzungsarten. „keine NR“ = ohne Nummer, gleiche Räume werden durchgezählt („WC (2)“). Optional
  **Stundenvorgabe je Jahr aus der Datei** (Summe Stunden/Jahr, ohne Tageskraft-Räume). Probe mit der echten Datei: 435 von 436
  Räumen (Kriechkeller 0 m²), 11.983,6 Std./Jahr = Kalkulation. **Leere Vorlage** `/raumbuch-vorlage.xlsx` (Knopf beim Import,
  Blatt „Erklärung“ mit Turnus-Kürzeln und Nutzungsarten). Keine externe KI (Daten blieben sonst nicht auf dem Server) –
  Kopfzeilen-Erkennung über Spaltennamen. Test `room-import-kalk.db.test.ts`.
- 2026-10-11: Raumbuch-Import (Ahmed: „Stundenvorgabe löschen, nicht ewig nach unten scrollen“, „das Objekt wird nicht
  unterschieden?“): Option „Stundenvorgabe aus der Datei“ wieder entfernt; Knopf „übernehmen“ steht oben (mitlaufend) statt
  unter hunderten Zeilen. **Mehrere Gebäude in einer Datei** (Spalte „Gebäude“, z. B. Grundschule Neubiberg / Unterbiberg /
  Sportzentrum): Vorschau fragt je Gebäude das Objekt desselben Kunden ab (Vorschlag über den Objektnamen, jedes Objekt nur
  einmal vorgeschlagen, sonst „nicht übernehmen“); je Objekt werden nur dessen Räume übernommen, Etage ohne Gebäudenamen,
  Raumbuch-PDF je Objekt. Fehlt ein Objekt, vorher beim Kunden anlegen. `suggestBuildingSites`, `analyzeRooms(…, { building })`.
- 2026-10-12: **Arbeitsschein kopieren** (Ahmed: „für ein anderes oder selbes Objekt“): Knopf „Kopieren“ am Arbeitsschein
  (Entwurf und abgeschlossen) → Objekt (vorbelegt: dasselbe) + Datum → neuer Entwurf mit eigener Nummer AS-JJJJ-NNNN, Zeiten,
  Mitarbeitenden, Arbeiten, Material, Bemerkungen und Positionen; mehrtägige Scheine und Stundenzeilen-Daten werden mit
  verschoben. Am selben Objekt bleiben Katalog-Leistungen (Preis) und Auftrag verknüpft, an einem anderen Objekt werden sie
  zu freiem Text ohne Preis. Unterschrift, Fotos, Abrechnung/Erledigt werden nicht übernommen. Feste ID je Formular,
  Protokoll `copy`. `copyWorkReport` in `orders.ts`, Test in `orders.db.test.ts`.
- 2026-10-12: **NU-Bestellung als erledigt markieren** (Ahmed: „unter Bestellungen komplett erledigt, außer wenn Unterschrift
  fehlt“): In der Bestellliste bei erteilten NU-Bestellungen Knopf „✓ erledigt“ (Rückfrage, bleibt auf der Liste mit
  gleichem Filter), in der Bestellung „✓ Als erledigt markieren“ (bisher „Beenden“). Status → beendet, Ende = heute, falls
  keins eingetragen. **Nur mit unterschriebenem Auftrag** (Scan oder Handy-Unterschrift, `signed_file_path`) – sonst kein
  Knopf, Hinweis „unterschriebener Auftrag fehlt“, und der Server lehnt ab (`setSubcontractStatus`). Kündigung des
  Nachunternehmers ist davon nicht betroffen. Test in `subcontractors.db.test.ts`.
- 2026-10-12: **Meine Zeiten: Einsatz umplanen** (Ahmed): Klick auf einen eigenen Einsatz zeigt neben „Zeit ändern/eintragen“
  auch „Nur diesen Tag umplanen“ (Umplanen / Vertretung / Ausfall) und „Serie bearbeiten“; danach zurück zu Meine Zeiten.
  Nur für Rollen mit Zugriff auf die Einsatzplanung (Admin, Personal, Objektleitung – diese nur an eigenen Objekten).
- 2026-10-12: **Dokumente auf- und zuklappen** (Ahmed): Kategorien der Dokumente bei Mitarbeiter, Objekt und Kunde sind
  aufklappbar (Zähler im Kopf, beim Mitarbeiter „+ n im Archiv“), oben „Alle aufklappen / Alle zuklappen“. Offen sind
  Kategorien mit 1–5 Dateien, lange Listen und leere sind zu (am Objekt bleiben fehlende Pflichtdokumente offen).
  Sprungmarken (#kat-…, #hochladen) klappen das Ziel automatisch auf (`client.ts`).
- 2026-10-12: **Aufenthaltstitel nur bei Bedarf + Nummern prüfen** (Ahmed: „wenn jemand Deutsch ist, keine Angaben zu
  Aufenthaltstitel“, „Bank, Steuer- und SV-Nummer immer prüfen lassen“):
  - Staatsangehörigkeit EU/EWR/Schweiz (`permitNeeded` in `hr-required-docs.ts`): Felder Aufenthaltstitel/Arbeitserlaubnis
    und der Fristen-Hinweis verschwinden im Formular (sofort beim Auswählen), in Übersicht und Liste; beim Speichern werden
    alte Angaben dazu geleert; keine Ablauf-Warnungen (Startseite, Erinnerungen). Ohne Staatsangehörigkeit bleiben sie.
  - **Prüfung beim Speichern** (Mitarbeiterformular und Personalbogen in der App): Steuer-ID (11 Ziffern, Ziffernregel,
    Prüfziffer ISO 7064 – § 139b AO), SV-Nummer (Aufbau 12 TTMMJJ A 123 + Prüfziffer), IBAN (Prüfziffer, wie bisher);
    Leerzeichen werden entfernt, verständliche Meldung (`src/domain/hr/ids.ts`). Bereits gespeicherte falsche Nummern (z. B.
    aus dem Import) erscheinen unter Personal → Fehlende Unterlagen als „Ungültig: …“. **Grenze:** geprüft wird nur Aufbau
    und Prüfziffer – ob die Nummer der Person gehört, zeigt erst ELStAM-Abruf bzw. DEÜV-Meldung im Lohnprogramm.
  - Tests: `ids.test.ts`, `phase2.db.test.ts`.
- 2026-10-12: **Personalakte hochladen, Unterweisung, Löschen** (Ahmed, Screenshot):
  - „Hochladen als“ wechselt die Kategorie ohne Neuladen (Seite sprang nach oben); Adresse merkt sich die Kategorie für das
    Neuladen nach dem Upload (`#hochladen`). Auswahl kürzer: „Häufig“ (Arbeitsvertrag, Vertragsänderung, Personalunterlagen,
    Unterweisung, Aufenthalts-/Arbeitserlaubnis, Bescheinigung, Sonstiges) und „Weitere“, „Entwurf (aus Vorlage)“ nicht mehr
    wählbar. Uploader liest die Kategorie beim Hochladen (`box.dataset.category`).
  - **Alle Klapplisten mit Suche** passen sich dem Platz im Fenster an: unten zu eng → öffnen nach oben, sonst eigene
    Scrollleiste (`client.ts`, `.cbx-pop.up`).
  - **Unterweisung je Mitarbeiter abwählbar** wie Schlüssel/Kleidung (Migration `20261123000002`) und zählt als vorhanden,
    sobald eine Unterweisung digital in der App unterschrieben ist. **Rechtlich:** Unterweisung bleibt Pflicht des
    Arbeitgebers (§ 12 ArbSchG, jährlich) – „nicht nötig“ nur, wenn der Nachweis anders geführt wird.
  - **Dokument löschen** in der Personalakte (Admin/Personal, auch im Archiv, mit Rückfrage): entfernt nur die Verknüpfung,
    Stand im Protokoll (`file_unlink`); die Datei bleibt write-once gespeichert (Belege auch im S3-Archiv).
- 2026-10-12: **Fehlende Unterlagen: Aufenthaltstitel** (Ahmed: „obwohl Aufenthalt in den Stammdaten eingetragen ist“): Bisher
  kam „Aufenthaltstitel/Arbeitserlaubnis“, sobald keine Datei in der Kategorie „Aufenthalts-/Arbeitserlaubnis“ lag – auch mit
  gültigem Datum in den Stammdaten. Jetzt getrennt: Datum fehlt / abgelaufen (→ Stammdaten) und „Aufenthaltstitel: Kopie
  fehlt in der Akte“ (→ Hochladen mit vorgewählter Kategorie). **Rechtlich:** Die Kopie muss für die Dauer der Beschäftigung
  in der Personalakte liegen (§ 4a Abs. 5 S. 3 Nr. 3 AufenthG) – das Datum allein reicht nicht.
- 2026-10-12: Fund Mitarbeiterformular (Ahmed, Screenshot): Die Hülle um die Aufenthaltstitel-Felder (zum Ausblenden) war ein
  eigenes Rasterfeld und verschob die vertraulichen Daten (Felder gequetscht, Aufenthaltstitel quer). Jetzt hat jedes der vier
  Felder selbst die Klasse `aufenthalt-feld` (`Field` mit `wrapClass`/`hidden`); per Screenshot geprüft (mit/ohne EU-Land).
- 2026-10-12: **Terminserie: einzelne Tage mit anderer Zeit** (Ahmed): In „Termin oder Terminserie planen“ (wöchentlich)
  aufklappbar „Einzelne Tage mit anderer Zeit“ – je gewähltem Wochentag Beginn/Ende und optional Pause (leer = wie oben).
  Gespeichert je Wochentag im Einsatz (`saveShiftSeries` mit `dayTimes`, Prüfung HH:MM/Ende nach Beginn je Tag);
  beim Bearbeiten gilt die häufigste Zeit als Serienzeit, abweichende Tage werden vorbelegt. Hinweis zu rückwirkend
  angelegten Serien korrigiert (Tage erscheinen als „keine Zeit erfasst“ → nachtragen bzw. „Plan als Ist“).
- 2026-10-12: Personalakte: „Arbeitskleidung“ in der häufigen Hochlade-Auswahl. **Aufenthaltstitel** (Ahmed: Kopie liegt
  meist in den Personalunterlagen): Fehlende Unterlagen melden nur noch „gültig bis fehlt“ bzw. „abgelaufen“ aus den
  Stammdaten, keine fehlende Kopie mehr.
- 2026-10-12: **Urlaubsanspruch bei Eintritt/Austritt** (Ahmed: „muss auf Eintritt gekürzt werden“): wurde im Urlaubskonto
  schon anteilig gerechnet (volle Beschäftigungsmonate ÷ 12), stand aber in den Stammdaten nur als Jahreswert – jetzt dort
  zusätzlich „2026: x Tage (anteilig ab Eintritt …)“. **Rechtlich neu eingebaut (§ 5 BUrlG):** gekürzt wird nur, wenn die
  Wartezeit (6 Monate) im Jahr nicht erfüllt ist (Eintritt nach dem 30.06.) oder bei Austritt in der ersten Jahreshälfte.
  Sonst bleibt mindestens der gesetzliche Mindesturlaub (4 Wochen = 20 Tage bei 5-Tage-Woche); nur der Mehrurlaub wird
  anteilig gekürzt (setzt eine entsprechende Vertragsklausel voraus). Beispiele: Eintritt 01.10. → 7,5 von 30; Eintritt
  15.03. mit 24 Tagen → 20 statt 18; Eintritt 01.07. → 20 statt 15. Urlaub beim Vorarbeitgeber (§ 6 BUrlG,
  Urlaubsbescheinigung) wird nicht automatisch abgezogen. Test in `days-per-week.db.test.ts`.
- 2026-10-12: Dokumente (Mitarbeiter, Kunde, Objekt) starten **immer zugeklappt** (Ahmed); Sprungmarken/Upload-Rücksprung
  öffnen weiter die Zielkategorie. **Mitarbeiter → Kalender & Zeiten: „Alle Zeiten dieses Zeitraums löschen (n)“** im Kasten
  „Erfasst“ (Admin/Personal): löscht alle erfassten Zeiten des angezeigten Monats/der Woche/des Tages (mit und ohne
  Einsatz) über das bestehende Löschen mit Löschprotokoll, Grund freiwillig, Rückfrage mit Anzahl; Einsätze bleiben.
  **Rechtlich:** nur für falsche Importe/Testdaten – echte Arbeitszeiten 2 Jahre aufbewahren (§ 17 MiLoG).
- 2026-10-12: **Urlaub automatisch** (Ahmed: „Tage sollen nicht drinstehen, automatisch berechnen, damit keine Fehler
  entstehen; laut Rahmentarifvertrag 30 Tage bei 5-Tage-Woche“): Feld „Urlaubsanspruch“ im Mitarbeiterformular entfällt;
  Anspruch = 30 × Arbeitstage ÷ 5 (`LEAVE_DAYS_5DAY` in `src/domain/time/leave.ts`), je Monat anteilig, Ein-/Austritt nach
  § 5 BUrlG. **Arbeitstage/Woche**: „automatisch aus der Einsatzplanung“ (Standard; `employees.days_auto`) = Wochentage mit
  eigenem Einsatz je Monat (alle 2 Wochen = ½, monatlich ≈ ¼, höchstens 6; Monat ohne Einsatz = 5; **Vollzeit immer 5**,
  damit eine unvollständige Planung den Urlaub nicht kürzt) oder „fest eintragen …“ (mit „gültig ab“ wie bisher).
  `leaveDaysPeriods`/`plannedDaysPerWeek` in `employee-hours.ts`; gilt für Anspruch und für die Tage, die ein Urlaub kostet.
  Fortytools-Urlaubsstände: Anspruch wird jetzt immer selbst gerechnet (übernommene genommene/verfallene Tage bleiben).
  Word-Platzhalter `Mitarbeiter.Urlaubstage` = 30 × Arbeitstage ÷ 5. Migration `20261124000001` (alle auf 30; wer bisher
  andere Arbeitstage als 5 eingetragen hatte, bleibt „fest“). **Rechtlich:** 30 Tage stammen von Ahmed (RTV) – bei
  Tarifänderung Wert in `leave.ts` anpassen; Mindesturlaub nach BUrlG wird nie unterschritten.

- 2026-10-12: **Fund „Kunde fehlt“ beim Objekt anlegen** (Ahmed, Objekt „Sonderreinigung“ beim Kunden „Viva-Deluxe intern“):
  Die Formularprüfung (zod 4, `z.uuid()`) verlangt RFC-UUIDs; feste IDs aus `md5(...)::uuid` (interner Kunde, Büro,
  Gruppen, Importe) wurden abgelehnt. Alle Prüfungen jetzt `z.guid()` (allgemeines UUID-Format), Test `fixed-ids.test.ts`.
  **Interne Kostenstelle „Sonderreinigung“** (`INT-SONDER`, Migration `20261124000002`) beim internen Kunden angelegt:
  Sonderreiniger mit wechselnden Einmal-Einsätzen werden dort geplant, Zeiten/Kosten laufen darauf; keine Rechnungen.
  Erlöse der Sonderreinigungen stehen weiter an den jeweiligen Kunden-Objekten.
- 2026-10-12: **Nachkalkulation „Sonderreinigung“** (Ahmed: „ja kannst du machen“): Einstellungen → Leistungsarten, Spalte
  „Sonderreinigung“ (`service_types.special_cleaning`, Migration `20261124000003`; vorbelegt Sonderreinigung,
  Grundreinigung, Bauendreinigung). Umsatz dieser Leistungsarten (eigene Rechnungen über die Leistungsart der Position bzw.
  der Leistung, Rechnungen vor der Umstellung über den Namen der Leistungsart) zählt in der Nachkalkulation beim internen
  Objekt „Sonderreinigung“ (`SPECIAL_SITE_ID` in `costing.ts`) statt beim Kunden-Objekt – dort stehen auch Zeiten und
  Kosten der Sonderreiniger, so ergibt sich ein eigener Deckungsbeitrag. Rechnungen selbst bleiben unverändert.
  Test in `cost-centers.db.test.ts`.
- 2026-10-12: **Word-Vorlagen: leere Felder ausfüllen** (Ahmed: „Personalstammblatt muss ausgefüllt werden“, „RV-Befreiung
  beim Minijob unten mit Datum“, „alle Vorlagen prüfen“): Viele Vorlagen haben statt Platzhaltern leere Tabellenzellen neben
  einer Beschriftung bzw. „Ort, Datum:“ ohne Inhalt. Neu in `word-form.ts`: Feldart `cell` (leere Zelle rechts neben einer
  Beschriftung; laufende Nummern, Preise, Kästchen, Unterschrift/Stempel zählen nicht) und Zeilen „Ort, Datum:“.
  Vorbelegung `defaultCells` aus den Stammdaten (Name, Vorname, Geburtsdatum/-ort, Staatsangehörigkeit, Familienstand,
  Anschrift, Telefon, E-Mail, SV-Nr., Steuer-ID, Krankenkasse, IBAN, Kontoinhaber, Eintritt, Tätigkeit aus Tags,
  Einsatzgebiet, Objektleitung, Resturlaub, Kunde/Auftraggeber/Entleiher, Objekt/Nr./Adresse, Ort + Datum); RV-Befreiung:
  Eingang beim Arbeitgeber / Meldung / Entgeltunterlagen = Unterschriftsdatum, Beginn der Befreiung = Monat des Eingangs,
  frühestens Eintritt (§ 6 Abs. 4 SGB VI). Ausfüll-Seite zeigt „Felder im Dokument“ zum Prüfen/Ergänzen (z. B. Kennzeichen,
  Urlaubszeitraum, weitere Beschäftigungen); leer bleibt zum Ausfüllen von Hand. Wirkt ohne neues Hochladen. Durchsicht
  aller 37 Vorlagen (V6): offen bleiben nur Angaben, die die App nicht kennt (Geburtsname, Steuerklasse, Fahrzeug-/
  Tankkartendaten, Rückgabe-/Abnahmefelder). Unterschriftsfeld der Person dunkler (#E4E0E2, beim Drucken sichtbar).
  Tests in `word-form.test.ts`.
- 2026-10-12: **Fund „duplicate key … absence_hours_uq“** (Ahmed): Beim Löschen von Einsätzen wurden die daran hängenden
  Abwesenheitsstunden (Urlaub/Krank je Einsatz) nur von der Verknüpfung gelöst. Hatte die Abwesenheit am selben Tag zwei
  gelöschte Einsätze oder schon Stunden ohne Einsatz, entstanden zwei Zeilen „ohne Einsatz“ → Fehler, nichts gelöscht.
  Jetzt werden sie je Tag zu einer Zeile zusammengefasst (Minuten addiert, höchstens 16 Std.; `detachAbsenceHours` in
  `time.ts`). Test in `runde20.db.test.ts`.
- 2026-10-12: **Ruhe und Stabilität** (Ahmed: „Design beruhigen, Seiten leerer/aufgeräumter für neue Mitarbeiter, stabiler“):
  - **CSS bereinigt:** 494 Angaben, die durch eine spätere Regel mit gleichem Selektor/gleichem @media sicher überschrieben
    wurden, und 108 leere Regeln entfernt (Werkzeug: postcss, Rückfall-Werte wie `dvh`/`env()` und `:has()` ausgenommen).
    Bildvergleich vorher/nachher an 22 Seiten × PC/Handy: pixelgleich. Neue Gestaltung nur noch im Block „Ruhe“ am Ende
    des Stylesheets (`layout.tsx`) – keine weitere Schicht.
  - **Objekt → Übersicht:** Leistungen als kurze Liste, Reinigungskräfte in Spalten (erste 12, „alle n anzeigen“),
    „Schule / Schulferien“ zugeklappt am Ende (vorher oben, Objekt-Seite 4.700 → 1.100 px).
  - **Kunde → Übersicht:** Offene Posten eine Zeile je Rechnung (Betrag, bezahlt – Zahlungen im Tooltip –, offen, fällig
    „in n T.“/„n T. überfällig“), erste 8 sichtbar, Summe im Titel; offene Angebote erste 6 + „alle“. Am Handy erst Reiter
    und Inhalt, Seitenkästen (Adresse, Karte, Bankkonten, Gruppen) danach; „Neu anlegen“-Auswahl am Handy wieder lesbar.
  - **Ausgestellte Rechnung:** sichtbar nur Jetzt versenden, PDF, Zahlung, X-Rechnung/ZUGFeRD; Name/Adresse ändern,
    Kopieren, Lieferschein, Stornieren, Rechnungskorrektur unter „Weitere Aktionen“; doppelter Versand-Knopf entfernt.
  - **Entwürfe:** feste Spaltenbreiten (Empfänger hatte nur 145 px → Zeilen halb so hoch), Knopf „Entwürfe erstellen“
    in voller Höhe. **Startseite:** Listen kürzer (Aufgaben 5, Wiedervorlagen 3, Hinweise 5), Summen-Schilder der
    Offenen Posten als ruhige farbige Zahlen statt grün/rot/gelber Flächen.
  - **Fund:** DB-Test `invoices.db.test.ts` zählte seit dem internen Objekt „Sonderreinigung“ 4 statt 5 Objekte → angepasst.
  - **Entwürfe → Aus Einzelleistungen:** Einzelaufträge mit Arbeitsschein im Entwurf (ohne Pflicht) sind nicht mehr
    ankreuzbar („Arbeitsschein erst abschließen“) – vorher scheiterte „Entwürfe erstellen“ für den ganzen Kunden.
  - **Browser-Tests repariert** (scheiterten schon vor dieser Runde, geprüft am alten Stand): Zeit-Test klickte den
    Status-Link statt die Zeit, Import-Test klappte den per Sprungmarke schon offenen Bereich wieder zu, Raumbuch-Test
    erwartete eine neue Raumart, die inzwischen per Stichwort zugeordnet wird, Vorfaktura-Test sucht jetzt im Monat von
    heute. Alle 25 Browser-Suiten grün, 551 Unit-/DB-Tests grün. **Fund Testumgebung:** Platte voll (300-MB-Upload-Test) →
    temporäre Testordner (`/tmp/viva-*`) gelöscht.
  - Seiten-Rundgang (`npm run check:seiten`): 685 Seiten PC + Handy, keine Fehlerseite, kein JS-Fehler; die 8 Meldungen
    waren Downloads (ZIP/xlsx) und gewollte Umleitungen mit Hinweis – Prüfskript überspringt bzw. akzeptiert sie jetzt.
  - Vergleichsbilder: `e2e/_ruhe-shots.mjs` (`OUT=<ordner> node e2e/_ruhe-shots.mjs`, 22 Seiten PC + Handy).
- 2026-10-12: **Menü oben oder links wählbar** (Ahmed): Benutzermenü (Name oben rechts) → „Menü oben anzeigen“ / „Menü links
  anzeigen“, ebenso unter Mein Konto → Menü. Gemerkt je Browser (Cookie `vd_menu`, 1 Jahr). Oben: Bordeaux-Leiste mit Logo
  und den Hauptpunkten, Untermenüs klappen als Liste auf (immer nur eins offen, Klick daneben/Esc schließt), bleibt beim
  Scrollen oben; bei schmalen Fenstern bricht die Leiste um, unter 1025 px gilt wie bisher die Schublade (☰). Browser-Test
  `npm run e2e:menu` (11 Prüfungen); navigation/login/rechte grün.
- 2026-10-12: **Menü-Position je Benutzerkonto** (Ahmed: „oben besser, für das Benutzerkonto, nicht Browser“): gespeichert in
  `app.user_prefs.menu_pos` (Migration `20261124000004`), gilt auf allen Geräten; **Standard jetzt oben**, „links“ nur bei
  ausdrücklicher Wahl (Benutzermenü bzw. Mein Konto → Menü). Cookie `vd_menu` entfällt. „Startseite zurücksetzen“ löscht
  nur noch die Startseiten-Einstellung (vorher die ganze Zeile). `e2e:menu` 14 Prüfungen (auch: zweiter Browser sieht dieselbe Wahl).
- 2026-10-12: **Menü oben/links je Benutzerkonto** (Ahmed: „oben besser, für das Konto, nicht den Browser“): Standard oben,
  umstellbar unter Mein Konto bzw. im Benutzermenü (`app.user_prefs.menu_pos`, Migration `20261124000004`, gilt auf allen
  Geräten). **Aktionsknöpfe wie Fortytools** (Ahmed: „solche Buttons sind hässlich“): Angebot, Rechnung (Entwurf und
  ausgestellt), Arbeitsschein und Einzelauftrag haben rechts oben einen Bordeaux-Block mit untereinander stehenden,
  vollbreiten Aktionen (`.actstack` in `layout.tsx`; Stornieren/Zurückziehen heller), statt einer Reihe einzelner Knöpfe
  unter dem Titel bzw. unter dem Brief. Knöpfe allgemein flacher (ohne Schatten, Radius 6 px, Text bricht um).
  `e2e:menu` (14 Prüfungen) neu.
- 2026-10-12: **Fund Entwürfe am Handy** (Ahmed, Screenshot): Durch die festen Spaltenbreiten blieb für „Empfänger“ am
  Handy nur ein Buchstabe Platz (Name lief senkrecht). Entwurfsliste ist unter 760 px jetzt eine Kartenliste je Entwurf
  (Häkchen, Datum, PDF/Löschen oben, Empfänger + Objekt + Leistungszeitraum, netto/brutto unten), PC unverändert.
- 2026-10-12: **Konzern-Design** (Ahmed: „bedienerfreundlicher, einfacher, unkomplizierter, professioneller wie bei einem
  Konzern“): Kopf wie in Konzern-Anwendungen – oben weiße Kopfzeile mit farbigem Logo, Suche, Meine Zeiten, Einstellungen,
  Benutzer; darunter die Bordeaux-Menüleiste (bleibt beim Scrollen stehen, aktiver Bereich hervorgehoben). Grundfläche
  ruhig grau ohne Rosa-Schimmer, Mitarbeiterkopf weiß. Startseite ohne doppeltes Logo (steht im Kopf; am Handy bleibt es).
  **„Neu anlegen“** statt Auswahlliste + „Anlegen“: ein Hauptknopf „+ Objekt/Kunde/Rechnung … anlegen“ und „Weitere ▾“;
  wo es keine eindeutige Hauptaktion gibt (Kunde, Objekt), ein Knopf „+ Neu ▾“ (`NewMenu` in `layout.tsx`, Links auf
  `/neu?typ=…`). Objektliste: CSV, QR-Aushänge, Objektleitungen zuordnen unter „Weitere Aktionen ▾“; „Markierte
  aktiv/inaktiv setzen“ erscheint erst, wenn etwas markiert ist (`.bulkbar`).
- 2026-10-12: Hintergrund (Ahmed: „hellen leichten Bordeaux-Ton lieber dort, wo jetzt grau ist“): Seitenfläche gleichmäßig
  hell-bordeaux `#f7f0f2` (`--bg`), Karten bleiben weiß, Kopfzeile weiß, Menüleiste Bordeaux.
- 2026-10-13: **Hintergrund Variante D** (Ahmed: „ok mach das so“): oben unter der Menüleiste heller Bordeaux-Schimmer
  wie früher, nach unten ruhiges Grau; Tabellenköpfe, Kartenköpfe der Seitenkästen, Hinweiskästen („Derzeit keine …“) und
  Summenzeilen hell-bordeaux (`--tint-2` #f8eff2); Tabellen, Formulare, Beträge weiß. Schrift: App und Rechnungen nutzen
  beide schon Inter.
- 2026-10-13: **Mehrzahl bei Einheiten** (Ahmed: Arbeitsschein „26 Tag“): `unitLabel(code, menge)` in
  `src/domain/invoice/types.ts` – „Tage“/„Monate“, wenn die Menge ≠ 1 vor der Einheit steht (Arbeitsschein-PDF und
  -Seite, Auftrag, Entwürfe, Leistungen, Mitarbeiter-App). Die Einheiten-Spalte der Rechnung bleibt „Tag“. Bereits
  archivierte PDFs bleiben unverändert (write-once). **Suche:** Die Vorschau unter dem Suchfeld lag hinter der
  Bordeaux-Menüleiste – Kopfzeile jetzt darüber (`z-index`).
- 2026-10-13: **Zahlungsliste: Nachunternehmer mit fehlenden Nachweisen bezahlen** (Ahmed): Eine Sperre im Server gab es
  nie, aber solche Rechnungen waren nie vorausgewählt, und der Hinweis „Zahlung zurückhalten?“ klang wie ein Verbot. Jetzt
  werden sie wie alle anderen vorausgewählt (fällig in 7 Tagen bzw. Skonto), der Hinweis lautet „Nachweise fehlen – Zahlung
  trotzdem möglich · nachfordern“. Vor „Als bezahlt festhalten“ und „SEPA-Datei erstellen“ kommt eine Rückfrage mit den
  betroffenen Firmen. **Rechtlich:** Wir haften als Auftraggeber für Mindestlohn und SV-Beiträge des Nachunternehmers
  (§ 13 MiLoG, § 14 AEntG, § 28e Abs. 3a SGB IV), egal ob wir zahlen oder nicht – die Nachweise nachfordern.
- 2026-10-13: **Fund Rechnungsentwurf** (Ahmed: „andere Rechnungsadresse – Felder kommen erst nach Neuladen“): Das Häkchen
  „Rechnungsadresse nur für diese Rechnung ändern“ verwies auf `bill-fields` statt `#bill-fields` – die Felder klappten
  nicht auf. Behoben (einzige solche Stelle), im Browser geprüft.
- 2026-10-13: **Einmalige Leistungen direkt in „Aus Einzelleistungen erstellen“** (Ahmed): Leistungen mit Zyklus „einmalig“,
  die noch nie verrichtet wurden, stehen dort automatisch (Monat = Ende bzw. Beginn der Leistung, Kennzeichen „einmalig“),
  ohne vorher „Leistungen verrichten“. Beim Erstellen wird die Ausführung mit fester ID angelegt (Datum = Gültigkeit der
  Leistung, Menge/Preis der Leistung) → doppelt absenden legt nichts doppelt an (`pendingOnceServices`,
  `resolveExecutionIds` in `executions.ts`). **Einzelauftrag: „Storno zurücknehmen“** (stornierter, nicht abgerechneter
  Auftrag → wieder offen, Protokoll). Aufträge selbst lassen sich nicht löschen; ein gelöschter Rechnungsentwurf gibt
  Aufträge/Ausführungen wieder frei. Zurückgenommene Ausführungen („zurücknehmen“) sind ohne Inhalt protokolliert –
  wiederherstellbar nur aus der Sicherung (pg_dump 14 Tage, Cloud Backup).
- 2026-10-13: Ahmed: „Rechnungsentwurf gelöscht, dann war der Einzelauftrag weg“ – geprüft (Test + Klick im Testsystem):
  Entwurf löschen setzt den Auftrag auf „erledigt“, er steht wieder unter Entwürfe → „Aus Einzelleistungen erstellen“ im
  Monat seines Termins/Leistungszeitraums und beim Kunden → Einzelaufträge → Offen. Monate mit Einzelaufträgen sind dort
  jetzt immer aufgeklappt (vorher nur der neueste Monat → ältere Aufträge wirkten verschwunden). Test in `runde33.db.test.ts`.
- 2026-10-14: Runde 40 (Ahmed, 11 Punkte – Objektleitung, Qualitätskontrolle, Objektordner):
  - **QK-Fotos nur mit der Kamera** (`capture="environment"`, keine Galerie im App-Ablauf) und mit Standort-Kennzeichen:
    je Foto Aufnahmezeit, Bewertung am Objekt / entfernt / ungenau / kein Standort, Entfernung, Koordinaten
    (`app.qm_photo_tags`, Migration `20261125000001`); im Auswertungsbericht unter jedem Mangelfoto. **Grenze:** Ein
    Browser kann die Galerie nicht völlig sperren (Android bietet teils trotzdem „Dateien“) – Zeitpunkt + Standort zeigen
    aber, wann und wo das Foto hochgeladen wurde.
  - **QK nur am Handy/Tablet** (Erkennung über Gerät bzw. Touch-Cookie `vd_touch`): am PC nur ansehen, Berichte,
    löschen; Starten/Bewerten/Abschließen am PC wird abgelehnt mit Hinweis auf die App.
  - **Objektleitung:** eigene Startseite `/` (statt Zeiterfassung): Aufenthaltstitel/Arbeitserlaubnis der an ihren
    Objekten eingeplanten Leute, die in 6 Wochen ablaufen oder fehlen (nur außerhalb EU/EWR/CH, keine weiteren
    vertraulichen Daten; `permitWarningsForSites`), Abwesend heute/7/14 Tage, eigene Aufgaben, Schnellwege.
    **Urlaub & Abwesenheiten** für ihre eingeplanten Leute (Kalender, Anträge, eintragen; Löschen/Stunden nur Büro).
    **Kunde & Ansprechpartner** in der Objektübersicht (Name, Telefon, E-Mail – keine Rechnungen/Preise).
    **Offene Stellen** nur lesen mit Plakat (`/stellen`, ohne Bewerber). **Personalbogen** auch am PC (Menü Personal;
    schaltet den PC nicht in den App-Rahmen). **Auswertungen** aus dem Menü (Dienste-Liste bleibt über Planung).
    **Anwesenheitsliste** und Aushänge druckbar (Rechte-Fund: war gesperrt).
  - **Rechte-Rundgang als Objektleitung** (400 Seiten): Links auf gesperrte Seiten (Personalakte, Benutzer, Objekt/Kunde
    anlegen) werden für die Rolle zentral entfernt bzw. als Text gezeigt (`stripForbiddenLinks`); danach keine 403 mehr.
  - **Objektordner:** raus Hauptabsperrung Wasser, Hauptschalter Strom, Brandmelderzentrale, Abfuhrtage, Feuerlöscher,
    Verbandkasten (alte Werte werden nicht mehr gedruckt). **Ersthelfer freiwillig** mit Hinweis § 26 DGUV Vorschrift 1
    (ab 2 gleichzeitig Anwesenden mind. 1, bis 20 Personen 1, darüber 10 % bzw. Verwaltung 5 %) und Zahl der eingeplanten
    Reinigungskräfte. **Nächstes Krankenhaus automatisch** (`src/services/hospital.ts`): Standort des Objekts bzw. Adresse/
    PLZ (OpenStreetMap Nominatim) → Krankenhäuser im Umkreis 30 km (Overpass), Notaufnahme bevorzugt, ohne Tages-/Reha-/
    Psychiatrie-Kliniken; beim Drucken automatisch, wenn leer, sonst Knopf „Neu ermitteln“; änderbar. Ohne Internet bleibt
    das Feld leer. **Bitte einmal je Objekt prüfen** (OSM-Daten können lückenhaft sein).
  - **Aushänge einzeln** (Objekt → Objektordner): Notfall & Kontakte (112/110/Giftnotruf 089 19240, Objektadresse für den
    Notruf, Objekt-/Bereichsleitung, Ersthelfer, Krankenhaus, Sammelplatz, Notausgang, Hausmeister, Kunde, Betriebsarzt),
    Hautschutzplan (Produkte aus Einstellungen), Dosierung Reinigungsmittel – je eine A4-Seite mit großer Schrift.
  - **Offen (Ahmed):** mstore-Produkte (Unterhaltsreiniger, Sanitärreiniger) – genaue Produktnamen und Produkt-/
    Sicherheitsdatenblätter schicken, dann trage ich Dosierung und Hautschutz-Hinweise ein (keine Dosierung geraten).
  - Tests: 559 Unit-/DB-Tests (neu `hospital.test.ts`, `permissions.test.ts`), e2e rechte 35, objekt 31, login 34,
    zeit 26, planung 27, objektseiten 40 grün.
- 2026-10-14: **Sicherheitsdatenblätter** (Ahmed: „füg die Sicherheitsdatenblätter auch hinzu“): Einstellungen →
  Objektordner-Vorlagen → Abschnitt „Sicherheitsdatenblätter“: je Produkt PDF + Hersteller + Fassung vom hochladen
  (`app.safety_data_sheets`, Migration `20261125000002`, PDF write-once im Archiv; gleicher Produktname = neue Fassung
  ersetzt die alte, die alte bleibt erhalten; „Entfernen“ nur deaktivieren, Protokoll). Hinweis bei Fassung älter als
  3 Jahre. Liegen automatisch im Objektordner-PDF (eigener Abschnitt mit Inhaltsverzeichnis) und im ZIP
  (`07_Sicherheitsdatenblaetter/`), als Sammel-PDF unter Objekt → Objektordner („Sicherheitsdatenblätter (n)“, auch für die
  Objektleitung, `/sicherheitsdatenblaetter.pdf`). Fehlen sie, steht es in den fehlenden Angaben des Objektordners.
  **Rechtlich:** § 14 GefStoffV – Beschäftigte müssen Zugang zu den SDB haben; zusätzlich braucht es Betriebsanweisungen
  und die Unterweisung (liegen im Objektordner-Paket bzw. unter Unterweisungen). Tests: `safety-sheets.db.test.ts`,
  `e2e:rechte` 36.
- 2026-10-14: **Aushänge Putzraum mit Piktogrammen, Objektordner schöner** (Ahmed: „alle Aushänge in einen Button …
  Wagen, Waschmaschine, mit Piktogrammen, schön machen“; „wo man den Text ändern, Sachen löschen oder hinzufügen kann“):
  - Objekt → Objektordner: ein Knopf **„Aushänge Putzraum (PDF)“** (`/objekte/:id/aushang/alle.pdf`), einzelne
    Aushänge eingeklappt. 7 Aushänge, je eine A4-Seite (`src/pdf/posters.ts`, Vektor-Piktogramme `src/pdf/pictos.ts`):
    Notfall & Kontakte, Farbsystem & Dosierung (rot/gelb/blau/grün + Dosiertabelle), Hautschutzplan, **Sanitärräume
    richtig reinigen**, **Reinigungswagen sauber halten**, **Mopps & Tücher waschen** (Waschmaschine), Ordnung im
    Putzraum. Bordeaux-Kopfband, nummerierte Schritt-Karten mit Symbol, Kästen „So ist es richtig“ / „Niemals“;
    Schrift passt sich an, damit alles auf eine Seite passt. Keine festen Dosierungen/Temperaturen ohne Herstellerangabe.
  - **Texte änderbar:** Einstellungen → Objektordner-Vorlagen → **Aushänge für den Putzraum**
    (`/einstellungen/objektordner/aushaenge`): Titel, Symbol, Einleitung, Schritte (ändern, löschen = Überschrift leeren,
    3 freie Zeilen zum Hinzufügen), „richtig“/„niemals“, Hinweis, an/aus, Vorschau-PDF, auf Standard zurücksetzen,
    **eigene Aushänge** anlegen/löschen. Platzhalter `{objektleitung}`, `{putzraum}`, `{hautschutz}` … (leer → Zeile
    entfällt). Gespeichert in `site_folder_defaults.data.aushaenge` (nur Änderungen; neue Standard-Aushänge erscheinen
    automatisch).
  - **Objektordner-PDF:** Deckblatt neu (Bordeaux-Fläche mit hellem Logo, Name groß, Kontakte, Notrufnummern, „In diesem
    Ordner“), Inhalt mit Register-Nummern, **Registerlaschen am rechten Rand** je Abschnitt (1 Objekt, 2 Aushänge, 3 …).
    Die neuen Aushänge stehen vorne im Abschnitt „Aushänge im Putzraum“; die gleichnamigen Aushänge aus Ahmeds Paket
    (Farbsystem/Dosierung, Notruf/Meldekette, Notfallplan, Hautschutz, Ordnung im Putzraum) werden nicht mehr doppelt
    gedruckt (PDF und ZIP); Abfalltrennung, Kontaktkarten, Betriebsanweisungen bleiben. ZIP enthält
    `01_Aushaenge_Putzraum/Aushaenge_Putzraum.pdf`. `FormDoc.newPage({ plain: true })` für Seiten ohne Briefpapier.
  - Tests: `posters.db.test.ts`, `site-folder.db.test.ts` angepasst; e2e objekt 31, rechte 36 grün.
- 2026-10-14: **Aushänge mit Skizzen** (Ahmed: Arbeitsanweisungen Waschmaschine + Reinigungswagen als Word mit Skizze,
  „mach auch Skizzen, füg die Sachen hinzu, Einzel-Download übersichtlicher“): Ahmeds 10 Punkte und Skizzen
  (`assets/aushaenge/skizze-*.png`, Nummern = Schritte) als Aushänge **„Reinigungswagen pflegen und bestücken“** und
  **„Waschmaschine bedienen und pflegen“** (neu); „Mopps & Tücher waschen“ bleibt (ohne Maschinenpflege). Mit Skizze
  werden die Schritte kompakte Karten ohne Symbol; Skizze wählbar je Aushang (auch eigene). Neue Piktogramme Rad, Ein/Aus,
  Wasserhahn. Objekt → Objektordner: Kasten „Aushänge für den Putzraum“ mit **„Alle Aushänge (n Seiten)“** und Kacheln je
  Aushang (Symbol, Schritte, „mit Skizze“). Gespeichert werden nur Abweichungen vom Standardtext (sonst kämen spätere
  Verbesserungen nie an); bis 14 Schritte je Aushang.
- 2026-10-14: Rückmeldung Aushänge (Ahmed, 6 Punkte):
  - **Skizzen statt Piktogramme:** jede Aushang-Seite (außer Notfall) hat eine nummerierte Skizze im Stil von Ahmeds
    Vorlagen; die Schritt-Karten haben keine Symbole mehr. Skizzen werden mit `node scripts/aushaenge-skizzen.mjs`
    aus SVG erzeugt (Chromium) → `assets/aushaenge/skizze-<name>.png` (Web-Vorschau) + `.jpg` (PDF, schnell
    einzubetten): Farbsystem, Hautschutz, Sanitärraum, Bodenreinigung, Scheuersaugmaschine, Mopps & Tücher, Putzraum;
    Reinigungswagen/Waschmaschine von Ahmed. Nummern in der Skizze = Schritte – bei Textänderungen Reihenfolge beibehalten.
  - **Neu:** „Böden richtig wischen“ (6 Schritte, Raum von oben) und „Scheuersaugmaschine bedienen und pflegen“
    (8 Schritte; Reiniger/Akku nach Herstellerangabe). Jetzt 10 Aushänge. Kacheln am Objekt zeigen die Skizze.
  - **Kontaktkarten** aus dem Paket werden nicht mehr in den Objektordner übernommen (PDF und ZIP). Seiten „Noch nicht
    hinterlegt“ (Revierplan/LV/Raumbuch) bleiben (Ahmed).
  - **Sicherheitsdatenblätter im Objektordner:** aus Einstellungen → Objektordner-Vorlagen und zusätzlich PDFs aus dem
    Paket (Ordner `04_…` oder Dateiname mit „Sicherheitsdatenblatt“/„SDB“), gemeinsam im Abschnitt
    „Sicherheitsdatenblätter“.
  - **Fund Mahnungen „keine E-Mail beim Kunden“:** Empfänger kamen nur aus eigenen Rechnungen bzw. den (leeren)
    Rechnungs-E-Mails am Kunden – bei übernommenen Fortytools-Rechnungen fehlte die Rechnungsgruppe. Jetzt
    `dunningRecipients()`: Mahn-/Rechnungs-E-Mails der Gruppe je Rechnung, bei übernommenen Rechnungen über die Objekte
    der Positionen, sonst die Gruppen des Kunden („Standard“ zuerst), zuletzt der Kunde. Gilt für Anzeige und Versand.
  - Aushänge-PDF schneller (Textbreiten je Wort zwischengespeichert, Einpassen per Halbierung): 10 Seiten ~1 s.
- 2026-10-14: Mahnungen weiter „keine E-Mail beim Kunden“ (Ahmed): Der Text stammt aus dem alten Stand – der Server hatte das
  Update zu dem Zeitpunkt noch nicht (neuer Text wäre „keine E-Mail (Rechnungsgruppe)“). Neu: **App-Stand** (Commit +
  Datum) unter Einstellungen und Einstellungen → Systemzustand sowie `/health/version`; `deploy/update.sh` schreibt dafür
  `version.txt` (nicht im Repo). Versandliste „Noch nicht versendet“: „Los (n)“ zählte vom Browser wiederhergestellte
  Häkchen nicht (Safari/Zurück) → Zähler auch bei Klick, `pageshow` und kurz nach dem Laden.
- 2026-10-14: **Raumbuch aus PDF und aus Dokumente** (Ahmed: „Raumbuch liegt als PDF unter Dokumente → Raumbuch, kann er
  das nicht selber übernehmen?“): Raumbuch-Import liest jetzt auch **PDF mit Textebene** (aus Excel/Fortytools gedruckt;
  Scans ohne Text → klare Meldung, keine Texterkennung). Eigener Leser `src/domain/sheet/pdf-table.ts`: Spalten über die
  x-Positionen (in vielen Zeilen belegte Bereiche), leere Spalten bleiben an ihrer Stelle, zusammengezogene Kopfzeilen
  („Objektnummer * Raumname *“) werden wortweise verteilt, je Seite wiederholte Kopfzeilen nur einmal. Objekt → Raumbuch:
  Knopf **„Aus Dokumente übernehmen (n)“** = Dateien unter Dokumente → Raumbuch (PDF/Excel/CSV, nicht die von der App
  erzeugte Raumbuch-PDF) → „Räume übernehmen …“ → gleiche Vorschau wie beim Hochladen. Probe mit der echten
  Neubiberg-PDF: 234 von 235 Räumen (Kriechkeller 0 m²), wie beim Excel. **Fund:** „Gebäudeteil“ (A, B, C … einer
  Schule) wurde wie „Gebäude“ behandelt → die Vorschau wollte jeden Gebäudeteil einem eigenen Objekt zuordnen. Jetzt
  bleiben Gebäudeteil/Bauteil/Trakt in einem Objekt (nur in der Etage „A · UG“); nur Spalte „Gebäude/Haus“ teilt auf.
  **Fund:** Die App-Raumbuch-PDF archivierte beim Ablegen auch hochgeladene Dateien, deren Name mit „Raumbuch_“
  beginnt (z. B. Ahmeds „Raumbuch_Grundschule_Neubiberg.pdf“) – jetzt nur noch eigene („Raumbuch_<Nr.>_JJJJ-MM-TT.pdf“).
  „Nebenraum“ → Nutzungsart Lager / Technik. Tests `pdf-table.test.ts`, `room-import-ft.db.test.ts`.
- 2026-10-14: **Räume löschen** (Ahmed: „alle Räume auch löschen können“): Objekt → Raumbuch: Häkchen je Raum, „alle markieren“,
  „Markierte löschen“, „Alle Räume löschen (n)“ (Rückfrage); im Raum „Raum löschen“. Räume aus Qualitätskontrollen/Tickets
  bleiben als Nachweis und werden nur inaktiv gesetzt (`deleteRooms` in `facility.ts`, Protokoll `rooms_delete` mit Stand).
- 2026-10-14: **Raumbuch aus Revierplan** (Ahmed: „Raumbuch aus Revierplan auch übernehmen, das vollständigere vorschlagen“):
  „Aus Dokumente übernehmen“ nimmt Dateien der Kategorien Raumbuch **und Revierplan**, liest jede kurz aus und zeigt je Datei
  Anzahl Räume + erkannte/fehlende Angaben; die vollständigste (meiste Räume, dann meiste Angaben) steht oben als
  „empfohlen“. PDF-Leser: Seiten mit eigener Skalierung werden über die wiederkehrende Kopfzeile ausgerichtet, Titel/
  Fußzeilen/Legenden zählen nicht als Spalten, zentrierte Spaltenköpfe werden der Datenspalte zugeordnet; im PDF zählen nur
  Zeilen mit Zahl in der Fläche (Zwischenüberschriften „Geschoss EG“, Fußzeile fallen weg). Spalte „Wie oft“ = Intervall;
  ohne Spalte Raumart wird die Nutzungsart aus dem Raumnamen erraten. Probe Neubiberg: Raumbuch 234 Räume (ohne Intervall),
  Revierplan 184 Räume (mit Intervall, 0 Fehlzeilen) → Raumbuch empfohlen.
- 2026-10-14: **Android-Projekt angelegt** (Ahmed: „hab jetzt Android Studio“): `mobile-app/android` (Capacitor 7, Paket
  `de.vivadeluxe.app`, Icons/Startbild Bordeaux, Kamera-Berechtigung). Anleitung `docs/anleitung-android.html/.pdf`:
  Node installieren → ZIP vom Branch → `npm install` + `npx cap sync android` → Android Studio öffnen → signiertes .aab
  (Upload-Schlüssel sicher aufbewahren) → Play Console interner Test → App-Inhalte (Datenschutzerklärung-URL fehlt noch,
  Test-Zugang für Google, Datensicherheit). Push in der Store-App braucht später Firebase.
- 2026-10-15: Ahmed (4 Punkte):
  - **Angebote „aufgehoben“** (Vergabe/Anfrage vom Auftraggeber aufgehoben; Migration `20261126000001`): aus Entwurf oder
    versendet; zählt nicht in der Zuschlagsquote, eigene Zeile in der Statistik, Reiter „Aufgehoben“. In der Liste je
    offenem Angebot Schnellknöpfe **Zusage / Absage / Aufgehoben** (Rückfrage, bleibt in der Liste), entschiedene Zeilen
    mit Farbkante (grün/rot/gelb). Korrektur am Angebot: Absage ↔ aufgehoben, doch Zusage, Entscheidung zurücknehmen
    (wieder „versendet“). Eine Zusage lässt sich nicht zurücknehmen (Übernahme ins Objekt/Rechnung).
  - **Logo größer** auf allen Aushängen (230 pt ≈ 8 cm, `POSTER_LOGO_W`) und auf dem Objektordner-Deckblatt (260 pt);
    `FormDoc.newPage({ plain, logoWidth })`. Raumbuch/QK-Bericht unverändert.
  - **Bewerber: interne Einschätzung** Gut/Mittel/Schlecht (Farbpunkt + Kante in der Liste, Filter-Chips) und
    **Kontaktverlauf** (Datum, Anruf/WhatsApp/E-Mail/SMS/Gespräch/Notiz, Ergebnis, Notiz; feste ID je Formular). Ergebnis
    „hat etwas anderes gefunden“ setzt den neuen Status **„Hat etwas gefunden“** (nicht mehr im Matching, nach 6 Monaten
    Löschvorschlag wie Abgelehnte). Liste zeigt „Zuletzt: Anruf 15.10.2026 · nicht erreicht“. Kontakte werden mit dem
    Bewerber gelöscht (DSGVO). Migration `20261126000002`. **Hinweis:** Einschätzung sachlich halten – Auskunftsrecht Art. 15 DSGVO.
  - **Rechnung erneut versenden / an andere Adresse** (Rechnung → Versand → „Erneut senden / an andere Adresse …“): Adressen
    frei (mehrere mit Komma), vorbelegt mit der Rechnungsgruppe; optional „dauerhaft speichern“ (Rechnungsgruppe der
    Rechnung, sonst Kunde; Protokoll). Eigener Versandeintrag je Formular (`…:erneut-<id>`) → doppelt absenden schickt
    nichts doppelt. Betreff „Erneute Zusendung: …“, Text „dieselbe Rechnung, keine neue Forderung – bitte nicht doppelt
    buchen“. Geht auch bei Portal/„kein Versand“-Kunden, nicht bei stornierten Rechnungen.
  - Android: minSdk 24, targetSdk 36 (Play-Vorgabe), Status-/Navigationsleiste mit Rand (`MainActivity`), versionCode 3.
- 2026-10-15: Einzelauftrag ohne „Titel“ und „Uhrzeit“ (Ahmed: unnötig). Titel wird automatisch aus der ersten Position
  gebildet (bestehende Aufträge behalten ihren Titel), Uhrzeiten bleiben bei alten Aufträgen erhalten, werden aber nicht
  mehr abgefragt. „Leistungsort (ohne eigenes Objekt)“ heißt jetzt „Objektadresse (wenn kein Objekt angelegt ist)“,
  in der Rechnungseinleitung „Objekt …“.
- 2026-10-15: Rückmeldung Android-App (Ahmed, 13 Punkte):
  - **Einzelauftrag → „Rechnung als PDF-Vorschau“**: derselbe Weg wie „Rechnung erstellen“, aber in einer Transaktion, die
    zurückgerollt wird (`previewOrderInvoicePdf`) – kein Entwurf, Auftrag bleibt offen.
  - **Leiste unten immer sichtbar** (Mitarbeiter-App, QM-App, App-Rahmen): Seite als Spalte, nur der Inhalt scrollt
    (`body.shellbar`), Leiste nicht mehr `position:fixed`.
  - **Zeit anpassen** beim Bestätigen: „Zeit anpassen“ an jedem Einsatz (Beginn/Ende/Pause) → geht als Nachtrag zur
    Freigabe an die Objektleitung. **„Nachtragen“ in der App entfernt** (nur noch Objektleitung/Büro).
  - **Stundenliste unterschreiben** nur am letzten Tag des Monats bzw. bis zum 7. des Folgemonats; dann öffnet die App
    zuerst die Stundenliste im Vollbild (ohne Leiste). „Später (nur heute)“ bleibt, damit Stempeln nie blockiert ist.
  - **Kein „Objekt wählen“** mehr: Stempeln am heutigen Einsatz bzw. einzigen Objekt; nur ohne Einsatz und mit mehreren
    Objekten kommt die Frage „wo arbeitest du?“.
  - **Art der Zeiterfassung je Mitarbeiter** (Zeiterfassung → Einstellungen; `employees.time_mode`, Migration
    `20261126000003`): Alle Wege / Nur Einsatz bestätigen / Stoppuhr / Stoppuhr mit QR-Code. Stoppuhr zeigt Sekunden.
    QR-Modus: Start öffnet die Kamera, nach dem Scan startet die Zeit am Objekt (Server prüft den QR-Code).
  - **QM-App:** Audit zurück ohne bewerteten Raum → wird verworfen, man landet in „Qualität“; Bewertung per
    **Schieberegler** (Wert erst gesetzt, wenn bewegt); „Speichern & zur Raumübersicht“ und **„Speichern & Audit
    beenden“**; Leiste unten Audits / Objekte / Tickets, oben keine Schnellknöpfe mehr; „+“-Menü nicht mehr abgeschnitten.
    PC: **Qualitätskontrollen in der Liste löschen** (Entwurf jeder, abgeschlossene nur Admin).
  - **PC-Ansicht → „← Zurück zur App“** (Knopf unten auf Handy/Tablet/App).
  - **Personalbogen Schritt für Schritt** (5 Schritte, Weiter prüft Pflichtfelder, Absenden im letzten Schritt;
    `WIZARD_JS` für weitere Formulare nutzbar).
- 2026-10-15: Runde 41 (Ahmed, 8 Punkte):
  - **Angebot: Leistungsart je Position** (`offer_lines.service_type_id`, Migration `20261126000004`), geht bei Übernahme
    ins Objekt, Auftrag und Rechnung mit; Kopie behält sie. **Auswahllisten schweben** (`cbx-pop` `position:fixed`) –
    wurden in Tabellen/Karten abgeschnitten. **Ehemalige Kunden** sind bei „Angebot für den Kunden“ und in der
    Kundensuche wählbar (eigene Gruppe „Ehemalige Kunden“).
  - **Kürzung ausbuchen** (Offene Posten → Zahlung erfassen → „Rest als Kürzung ausbuchen“ + Grund Pflicht): Kunde zahlt
    weniger (Mängelabzug o. ä.) → Rest wird intern ausgebucht (Zahlart `kuerzung`, Migration `20261126000005`), kein
    Beleg an den Kunden, kein „Gutschrift“-Dokument. DATEV-Hinweisliste nennt jede Kürzung. **Steuerlich:** Die USt
    mindert sich erst, wenn die Kürzung endgültig ist (§ 17 UStG) – bei strittigen Abzügen Forderung offen lassen bzw.
    mit dem Steuerberater klären.
  - **Mitarbeiter-App: Stoppuhr wie Fortytools** oben auf der Startseite: runde Uhr (läuft sekundengenau, Objekt +
    Beginn), runder Knopf Start/Stopp (statt „Arbeit beginnen/beenden“); QR-Modus: Start öffnet den Scanner. Knopf „QR
    scannen“ in der Schnellleiste entfernt, Liste „Meine Zeiten (letzte 7 Tage)“ auf der Startseite entfernt (steht unter
    „Zeiten“).
  - **Pause laut Einsatzplan in der Mitte** (`plannedBreak` in `time.ts`): Hat der heutige Einsatz eine Pause, wird sie
    beim Einstempeln vorgemerkt – mittig in der Planzeit (auf 5 Min. gerundet), mindestens gesetzlich für die Planzeit
    (§ 4 ArbZG). Mitarbeitende können sie verschieben/kürzen („Pause ändern“) oder ablehnen („Pause ablehnen“). Beim
    Ausstempeln gilt sie, wenn bis nach ihrem Ende gearbeitet wurde (sonst gesetzliche Pause); abgelehnt = 0, Büro sieht
    den § 4-Hinweis. Ohne geplante Pause wie bisher (nach 4 Std.).
- 2026-10-15: Runde 42 (Ahmed, 5 Punkte):
  - **Leistungsart statt Freitext** überall, wo Positionen erfasst werden (Rechnung, Rechnungskorrektur, Angebot,
    Einzelauftrag, Direktbearbeitung im Rechnungsbrief, Leistung am Objekt): nur noch eine Auswahl „Leistungsart“, der
    Rechnungstext ist ihr Name (`TypeSelect` in `pages-invoices.tsx`, verstecktes Feld `desc`/`description`). Bisherige
    Texte ohne passende Leistungsart bleiben als eigene Auswahl stehen (Wert `text` → keine Leistungsart). Beschreibung
    bleibt als Zusatztext.
  - **Kürzungsbeleg**: „Rest als Kürzung ausbuchen“ erzeugt einen internen Buchungsbeleg KB-JJJJ-NNNN als PDF
    (`reduction-vouchers.ts`, Tabelle `app.reduction_vouchers`, Migration `20261127000001`, nur anhängen): Kunde,
    Rechnung, Betrag brutto/netto/USt (im Verhältnis der Rechnung), Grund, Hinweis § 17 UStG, Unterschriftsfeld
    „geprüft/freigegeben“. Ablage write-once in der Kundenakte („Rechnungen & Belege“), revisionssicher kopiert (S3),
    Liste **Rechnungen → Kürzungsbelege** (`/rechnungen/kuerzungen`, Knopf auf Offene Posten) mit CSV für den
    Steuerberater; DATEV-Hinweisliste nennt die Belegnummer. Geht nie an den Kunden.
  - **Stoppuhr als runder Bordeaux-Knopf unten rechts** (Symbol wie „Einsätze erledigt“); Antippen öffnet ein Fenster
    von unten mit Start bzw. laufender Zeit, Pause und Stopp. Läuft die Zeit, zeigt der Knopf die Uhrzeit. QR-Modus:
    Knopf öffnet direkt den Scanner.
  - **QM-App:** jede Audit-Zeile (Übersicht, Objekt) hat ein Menü „⋮“: Öffnen/Weiter bewerten, Auswertungsbericht,
    Löschen (Entwurf jeder, abgeschlossene nur Admin).
  - **Mitarbeiter-App kompakter wie Fortytools:** Begrüßung einzeilig, Schnellknöpfe 3 je Zeile, Einsatzkarten weiß mit
    Objektnummer, Adresse und Symbol (Uhr offen / Haken erledigt), kleinere Abstände und Knöpfe.
- 2026-10-15: Runde 43 (Ahmed, 13 Punkte):
  - **Angebot:** Betreff-Feld entfällt (Titel intern = erste Position), „PDF herunterladen“ ohne „versendet“ und ohne
    ENTWURF-Wasserzeichen.
  - **NU-Auftrag anfragen (App):** Leistung als Auswahl; jede Anfrage legt fürs Büro die Aufgabe „NU-Auftrag freigeben:
    …“ an (Startseite/Aufgaben, feste ID), sie wird beim Erteilen/Stornieren erledigt.
  - **NU-Bestellung unterschreiben** aufgeräumt (Karte mit Nummer, Firma, Objekt, Leistung, Turnus, Beginn, PDF; große
    Unterschriftsfläche). **Objektleitung** darf es jetzt auch – nur für Bestellungen ihrer Objekte, ohne Preis auf der
    Seite (Rechte + Objektprüfung). **Hinweis:** Der Bestellschein (PDF) enthält den Preis – den sieht die Objektleitung
    beim Öffnen des PDF.
  - **Zurück = alte Stelle:** Scrollposition je Seite wird gemerkt und bei Zurück/Vor wiederhergestellt (PC und Apps).
  - **Arbeitsscheine am Handy:** Karten statt breiter Tabelle, ohne untere Leiste; ebenso keine Leiste während einer
    Qualitätskontrolle und im Personalbogen. Posteingang aus der App entfernt.
  - **Personalbogen** in 8 kleinen Schritten (Name → Geburt → Adresse → Kontakt → Bank → Aufenthalt → Fotos →
    Abschluss) mit Fortschrittsbalken, 7 Sprachen. **Fotos** (Ausweis Vorder-/Rückseite, Krankenkassenkarte, Bankkarte,
    Aufenthaltstitel, SV-Ausweis, Sonstiges) mit der Kamera; im Browser auf 1600 px verkleinert, auf dem Server zu einem
    PDF (je Foto eine Seite) zusammengefügt. Das PDF sieht nur Personal/Admin (Personalbögen → „Fotos der Unterlagen“);
    beim „Als Mitarbeiter anlegen“ landet es automatisch in der Personalakte (Personalunterlagen), Bogen = übernommen.
    Migration `20261127000002`. **Datenschutz:** Ausweiskopien nur, soweit für das Arbeitsverhältnis nötig (z. B.
    Aufenthaltstitel § 4a AufenthG); nicht benötigte Kopien nicht aufbewahren.
  - **Unterweisungen als Textvorlagen** (Einstellungen → Unterweisungen, `app.instruction_templates`, Migration
    `20261127000003`): 9 vorbereitete Texte (Arbeitsschutz allgemein, Gefahrstoffe, Hautschutz, Leitern, Rutschgefahr,
    Brandschutz, Verschwiegenheit, Schlüssel, Zeiterfassung) + Objekteinweisung NU, änderbar, eigene anlegen. Freigabe
    am PC (Inhalt: Vorlage / Word / PDF) oder **am Handy** (Verwaltung → Unterweisungen: Vorlage → an alle / Objekt /
    Auswahl → Frist). Der Text wird eingefroren (`sign_documents.body`), als PDF archiviert und in der Mitarbeiter-App
    **direkt angezeigt** und unterschrieben. **Texte mit Fachkraft für Arbeitssicherheit/Betriebsarzt abstimmen.**
  - **Nachunternehmer bei festen Aufträgen:** In der erteilten Bestellung Kasten „Schlüssel, Kleidung & Einweisung“ →
    Übergabe an den NU (Schlüssel, Arbeitskleidung, Objekteinweisung aus Vorlage) mit Unterschrift. Schlüssel liegen im
    Schlüsselbuch jetzt auch beim Nachunternehmer (`keys.holder_supplier_id`, `key_log.supplier_id`, Migration
    `20261127000004`), Rückgabe nur vom NU.
  - Tests: `handovers.db.test.ts` (Schlüssel an NU), e2e `app` 20, `login` 39 (Personalbogen mit Foto).
- 2026-10-15: **Kürzung / Verrechnung zu Rechnungen, auch von vor der Umstellung** (Ahmed: „Gutschrift oder so zur
  Verrechnung, intern, mit der Rechnung verbunden, buchhalterisch richtig“ → „lieber nur ein Weg: interne Kürzung mit
  eigenem Beleg wie Rechnung, den die Buchhaltung auch bekommt“): An jeder offenen Rechnung (eigene und übernommene)
  „Kürzung / Verrechnung“ → `/rechnungen/:id/verrechnung`: Betrag brutto, Datum, Grund → `writeOffPart` (feste ID →
  nichts doppelt; bei übernommenen Rechnungen zählt sie wie eine Teilzahlung) + **Kürzungsbeleg KB-JJJJ-NNNN im
  Rechnungslayout „edel“** (Briefpapier, Kopfblock mit Nummer, Kunde, „Zu Rechnung … vom …“, Position netto/USt/brutto
  negativ, Grund, „Interner Buchungsbeleg – wird dem Kunden nicht zugesandt“, Freigabe-Linie; `createReductionVoucher`).
  Buchhaltung bekommt ihn: Kundenakte, Rechnungen → Kürzungsbelege (PDF je Beleg, **ZIP aller PDFs**, CSV) und im
  **DATEV-Export als Buchung** (Haben Debitor gegen Erlöskonto 19/7 % mit Automatik-USt, Belegfeld 1 = KB-Nr.,
  Belegfeld 2 = Rechnungsnr.; ohne USt/§ 13b → Hinweis zum manuellen Buchen). Bisherige Kürzungen aus „Rest als Kürzung
  ausbuchen“ (Offene Posten) laufen genauso. Kein zweiter Weg (Rechnungskorrektur an der eigenen Rechnung bleibt
  unverändert). „Gutschrift“ steht auf keinem Beleg (§ 14 Abs. 2 S. 2 UStG). **Steuerlich:** USt-Minderung, sobald die
  Kürzung endgültig ist (§ 17 UStG); DATEV-Konten mit dem Steuerberater abstimmen (ggf. eigenes Erlösschmälerungskonto).
  Test in `legacy-cancel.db.test.ts`.
- 2026-10-15: **Korrektur (Ahmed: „mach doch lieber die Rechnungskorrektur und dort minus den Betrag“)** – ersetzt den
  internen Kürzungsbeleg an der Rechnung: An jeder offenen Rechnung (eigene und von vor der Umstellung) „Betrag mindern
  (Rechnungskorrektur)“ → `/rechnungen/:id/verrechnung`: Minderung **brutto** + Grund → Entwurf einer Rechnungskorrektur
  (`createReductionCorrection` in `invoices.ts`; eigene Nummer, Belegart 384, Verweis BT-25, eine Position „Minderung zur
  Rechnung …“ mit Grund, Menge −1, netto = brutto ÷ (1 + Steuersatz der Rechnung) kaufmännisch gerundet, § 13b wie
  Rechnung; feste ID je Formular → nichts doppelt; nie mehr als der noch nicht korrigierte Nettobetrag). Danach wie jede
  Rechnung fertigstellen (KoSIT), versenden bzw. „als versendet markieren“; nach dem Ausstellen mindert sie den offenen
  Posten und steht im DATEV-Export als Ausgangsbeleg. Liste der bisherigen Korrekturen auf derselben Seite.
  `writeOffPart` entfernt. Bleibt: „Rest als Kürzung ausbuchen“ in den Offenen Posten mit KB-Beleg (DATEV-Buchung, ZIP).
  **Steuerlich:** Die Korrektur sollte dem Kunden zugehen, damit er seine Vorsteuer berichtigt (§ 17 Abs. 1 UStG).
  Test in `legacy-cancel.db.test.ts`.
- 2026-10-15: App (Ahmed, 5 Punkte + 2 Nachträge):
  - **Zeit bestätigen in zwei Schritten:** „Zeiten bestätigen“ öffnet die Rückfrage „Stimmt die Zeit?“ (Tag, von–bis,
    Objekt) mit „Ja, stimmt – bestätigen“ oder „Nein, Zeit bearbeiten“ (Beginn/Ende/Pause → Nachtrag an die
    Objektleitung). Separater Link „Zeit anpassen“ entfällt.
  - **Schnellknöpfe oben weg** (Urlaub/Krank, Dokumente); Leiste unten jetzt Übersicht · Kalender · Zeiten · Urlaub ·
    Dokumente.
  - **Büro-Menü statt Umschalter-Leiste:** Knopf „Büro ▾“ (bzw. „Verwaltung ▾“/„Qualität ▾“) oben rechts mit Meine Zeit /
    Qualität / Verwaltung. Verwaltung und Qualität haben jetzt dieselbe Kopfzeile mit Logo wie die Mitarbeiter-App
    (nicht während Audit/Personalbogen).
  - **PDFs in der Android-App** (QK-Auswertungsbericht, Prüfprotokoll, Rechnungen, Arbeitsscheine …): Die WebView
    kann PDFs nicht anzeigen → beim Antippen passierte nichts. `MainActivity` lädt sie jetzt mit der Anmeldung der App
    (DownloadManager, App-eigener Ordner, keine Speicher-Berechtigung) und öffnet sie im PDF-Programm. **Braucht den
    neuen App-Build (versionCode 4).** Im Browser/iPhone öffnen sie wie bisher.
  - **App-Icon mit Firmenlogo** (Globus mit „VD“ aus dem Briefpapier, weiß hinterlegt): `python3 -I scripts/app-icons.py`
    erzeugt PWA-Icons, `assets/web/app-icon-1024.png` / `mobile-app/resources/icon.png` (App Store, ohne Transparenz) und
    die Android-Startsymbole (adaptiv, ohne Inset). Ersetzt `scripts/app-icons.mjs`.
- 2026-10-15: **Profil in den Apps wie Fortytools** (Ahmed, Screenshots): Initialen oben rechts → Profil (Name, E-Mail,
  Firma, ggf. Personalnummer) mit **App-Tour** (startet beim ersten Öffnen, danach über das Profil; Mitarbeiter-App
  7 Sprachen, Verwaltung Deutsch), **App-Berechtigungen** (Mitteilungen, Kamera, Standort: Status + „Erlauben“),
  Sprache bzw. Passwort ändern, **Über die App** (Datenschutz, Lizenzen, Version) und Abmelden – „Abmelden“ oben
  entfällt. „Nachrichten“ bewusst nicht (Ahmed). `src/web/m/profile.tsx`, Routen `/m/profil…`, `/qm/profil…`.
  **Datenschutzhinweise öffentlich unter `/m/datenschutz`** (Art. 13 DSGVO, Daten aus Firmendaten) – Adresse für
  Google Play/App Store; **vor dem Einreichen von Datenschutzberater/Anwalt prüfen lassen.**
  Anleitung `docs/anleitung-stores.html/.pdf` (Google Play Schritt für Schritt, App Store: Mac/Xcode nötig, iOS-Projekt
  noch anzulegen, Risiko Apple 4.2 → Unlisted/Custom App).
- 2026-10-15: **iPhone-App auf dem Mac** (Ahmed: „wo Node.js für Mac, Anleitung genauer“): `docs/anleitung-iphone-mac.html/.pdf`
  (Node.js LTS als .pkg von nodejs.org, Xcode aus dem App Store + `xcode-select`, Homebrew + CocoaPods, ZIP vom Branch,
  Team/Signing, Archive → App Store Connect, TestFlight, Angaben, Fehlerliste) und Skript `mobile-app/ios-einrichten.sh`:
  prüft Werkzeuge, `npm install`, `cap add ios` (CocoaPods), Mindest-iOS 15.5 (Google ML Kit 7), App-Name, Logo als
  App-Symbol, Bordeaux-Startbild, Texte für Kamera/Standort/Fotos, `ITSAppUsesNonExemptEncryption=false`, `cap sync`,
  öffnet Xcode; darf mehrfach laufen. Hier nicht ausführbar (kein macOS) – erster Lauf auf Ahmeds Mac.
- 2026-10-15: iPhone-App auf Ahmeds Mac (Xcode mit iOS-SDK 26): 1) Pods meldeten „deployment target 14.0“ → Skript
  setzt im Podfile (post_install) alle Pods auf 15.5. 2) App startete schwarz („UIScene life cycle is required for apps
  built with this SDK“) → Skript ergänzt `UIApplicationSceneManifest` (Storyboard Main, `App.SceneDelegate`) und eine
  minimale `SceneDelegate`-Klasse in `AppDelegate.swift` (Capacitor 7 nutzt noch den alten Lebenszyklus). Beides
  idempotent; hier nicht testbar (kein macOS).
- 2026-10-15: iPhone-App (Ahmed testet auf dem iPhone): Logo oben angeschnitten, Leiste unten nicht ganz unten,
  Stoppuhr-Fenster unten abgeschnitten → `ios.contentInset` von „always“ auf „never“ (das Einrücken machte iOS zusätzlich
  zu unseren `env(safe-area-inset-*)`-Abständen, die Seite wurde höher als der Bildschirm). Audit/Personalbogen (ohne
  Kopfzeile) beginnen unter der Statusleiste (`main.nohead`). **PDF ohne Zurück:** Skript setzt in Main.storyboard
  `VivaViewController` (in `AppDelegate.swift`): bei PDFs (Pfad .pdf oder `document.contentType`) Knopf „‹ Zurück“ oben
  links, dazu Wischen vom linken Rand. Wirksam nach erneutem `bash ios-einrichten.sh` (nicht auf macOS getestet).
- 2026-10-15: App am iPhone (Ahmed, Screenshots): Fenster von unten (Stoppuhr, „Was möchten Sie als nächstes erledigen?“)
  lagen unter der Leiste unten → Leiste ausgeblendet, solange ein solches Fenster offen ist (`body:has(details.msheet[open])`).
  Häkchen/Auswahlknöpfe waren in der App 100 % breit (Namen rutschten nach rechts) → feste Größe; `[hidden]` gilt jetzt
  auch in den Apps (Feld „Objekt“ erschien bei „einzelne auswählen“). Unterweisung freigeben ohne Leiste unten,
  Zurück/Weiter bleiben unten stehen. „75 %“ bricht nicht mehr um. **iPhone-PDF:** neben „‹ Zurück“ Knopf
  „Teilen / Drucken“ (lädt das PDF mit der App-Anmeldung, iOS-Teilen: Drucken, In Dateien sichern, Mail, WhatsApp) –
  `VivaViewController` Fassung 2 im Skript (ersetzt Fassung 1); wirkt nach `bash ios-einrichten.sh` + neuem Build.
- 2026-10-15: **Automatischer iPhone-Build** (Ahmed: „jedes Mal Build ist super viel Aufwand“): GitHub Actions
  `.github/workflows/ios-testflight.yml` (macOS-Runner, neuestes Xcode) läuft bei Änderungen unter `mobile-app/`
  (ohne android) oder per „Run workflow“: `ios-einrichten.sh` (mit `CI=1` ohne Xcode-Fenster) → Archive mit
  automatischer Signierung über den App-Store-Connect-API-Schlüssel → Upload zu TestFlight. Build-Nummer = 100 + Lauf-Nr.
  (immer höher als die Hand-Builds). Secrets nur in GitHub: `APPSTORE_KEY_ID`, `APPSTORE_ISSUER_ID`, `APPSTORE_KEY_P8`
  (Inhalt der .p8), `APPLE_TEAM_ID`. **Schlüssel braucht Rolle „Admin“** (Zertifikate in der Cloud anlegen). Ohne
  Secrets bricht der Lauf mit Hinweis ab. Server-Änderungen brauchen weiterhin keinen Build. Android folgt (Dienstkonto).
- 2026-10-15: **Automatischer Android-Build** (wie iPhone): GitHub Actions `.github/workflows/android-play.yml` (Ubuntu,
  Java 21, Node 22) bei Änderungen unter `mobile-app/` oder per „Run workflow“: `npm ci` + `cap sync android` →
  `./gradlew bundleRelease` (signiert mit dem Upload-Schlüssel aus den Secrets; `build.gradle` liest ihn nur aus
  Umgebungsvariablen, Android Studio baut ohne sie wie bisher) → Upload in den Track „Interner Test“
  (`r0adkll/upload-google-play`, Status completed oder per Knopf draft). Versionscode = 100 + Lauf-Nr. Secrets:
  `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`,
  `PLAY_SERVICE_ACCOUNT_JSON` (Dienstkonto mit Release-Rechten für die App). **Voraussetzung:** erstes .aab einmal von
  Hand in der Play Console hochgeladen (Google verlangt das). Hier nicht testbar (kein Android-SDK).
- 2026-10-15: iPhone-App **nur für iPhone** (`TARGETED_DEVICE_FAMILY = 1` im Skript), sonst verlangt Apple iPad-
  Bildschirmfotos. iOS-Build: .ipa lokal exportieren, Upload mit `xcrun altool` (Export mit „upload“ scheiterte an
  „Cannot verify client's JWT headers“). Store-Angaben: Datenschutz-URL `/m/datenschutz`, Testzugang Personalnr. 9999.
- 2026-10-16: **Eine Anmeldemaske für alle** (Ahmed: „nur eine Eingabeform“): `/app`, `/anmelden` (PC) und `/m` ohne
  Anmeldung zeigen dieselbe Maske „Personalnummer oder Benutzername“ + „PIN oder Passwort“ (`unifiedLoginHtml` in
  `routes-start-app.tsx`, Feld-IDs `k`/`p`, Ziel `/app/anmelden` mit `from` = app/pc und `next`). Nur Ziffern →
  Personalnummer + PIN → Mitarbeiter-Ansicht, sonst Benutzer + Passwort (am PC → Startseite der Rolle bzw. `next`, in
  der App → `/app`). Die alte Mitarbeiter-Maske in `/m` (mit Link „Objektleitung & Büro: hier anmelden“) ist weg;
  Abmelden in der App führt zurück auf `/app`. Sprache der Mitarbeiter-App folgt nach der Anmeldung den Stammdaten.
  (Kurzadresse mobile.… wieder verworfen – Ahmed: bleibt bei app.viva-deluxe-reinigung.de.)
  Android/iPhone vorerst als Web-App (Chrome „App installieren“, Safari „Zum Home-Bildschirm“); Google Play: privates
  Entwicklerkonto → geschlossener Test mit 12 Testern über 14 Tage nötig, oder Organisationskonto der GmbH.
- 2026-10-16: **Anleitungen für Objektleitungen** (mit Bildern aus der Demo-App, nur Beispieldaten):
  `docs/anleitung-app-installieren.html/.pdf` (iPhone Safari „Zum Home-Bildschirm“, Android Chrome „App installieren“,
  QR-Code zur Adresse, Anmeldung mit der einen Maske, Benachrichtigungen) und `docs/anleitung-zeiterfassung-app.html/.pdf`
  (Startseite, Stoppuhr Start/Stopp, Pause, Zeit bestätigen „Stimmt die Zeit?“, Zeit bearbeiten = Nachtrag, Stundenliste,
  Verwaltung → Zeiten heute: Nachträge freigeben, „nicht gestempelt“). Bilder in `docs/bilder/anleitung-app/`.
- 2026-10-16: App-Rückmeldung (Ahmed, 10 Punkte, iPhone als Home-Bildschirm-App):
  - **Stoppuhr** zeigte direkt nach dem Start bis zu 59 s (Zeit wird auf die Minute gespeichert) → Anzeige ab dem Antippen
    (`sinceOf`: recorded_at, wenn < 60 s nach start_at). **Pause** lag direkt am Beginn, wenn deutlich anders als geplant
    gestempelt wurde → wandert mit (gleicher Abstand zum Beginn wie im Plan, ab 30 Min. Abweichung; Test in `time.db.test.ts`).
  - **Einsatzkarte** zeigt die erfasste Zeit („▶ Eingestempelt seit …“ bzw. „✓ 20:56–21:30 · erfasst“), Haken erst nach Ende.
  - **Benachrichtigungen automatisch:** schon erlaubt → still abonnieren, kein Knopf; noch nicht gefragt → Fenster mit
    „Benachrichtigungen einschalten“ / „Später (nur heute)“ erscheint von selbst (iPhone braucht einen Fingertipp).
  - **Fund „Qualität/Übergaben sehen aus wie Website mit X“:** Die Home-Bildschirm-App galt nur für `/m` (Manifest-scope),
    alles unter `/qm` und die Büro-Seiten öffneten im Browserfenster. Jetzt scope `/` (beide Manifeste, id `/m`).
    **Wer die App schon installiert hat: Symbol entfernen und neu „Zum Home-Bildschirm“** (iOS merkt sich den Bereich).
  - **PDFs** (Lohnabrechnung, Dokumente) öffnen in der Home-Bildschirm-App in eigenem Fenster mit „Fertig“ und Teilen
    (`PDF_JS`, nicht in der Store-App).
  - „Zur PC-Ansicht wechseln“ aus der Verwaltung entfernt. **Büro-Seiten im App-Rahmen** (`APPMODE_JS` + CSS): Reiter als
    wischbare Pillen in einer Zeile („Mehr“ aufgelöst), Tabellen bis 10 Spalten als Karten mit Beschriftung (Klasse `keep`
    = Tabelle bleibt). Kopf der Mitarbeiter-App etwas tiefer unter der Statusleiste.
  - GPS beim Stempeln nur, wenn unter Zeiterfassung → Einstellungen „Stempeln mit Standort“ eingeschaltet (Standard aus);
    gespeichert wird nur am Objekt / nicht am Objekt + Entfernung, keine Koordinaten.
- 2026-10-16: **PDFs in der Home-Bildschirm-App** (Ahmed: „6. fehlt immer noch“ – Lohnabrechnung ohne Drucken/Teilen/Zurück):
  Mit Scope `/` öffnet iOS auch `target=_blank`-Links in der App ohne Leiste. Jetzt leitet `PDF_JS` (nur installierte
  Web-App, nicht Store-App) PDF-Links (`.pdf`, `/m/lohn/`, `/dateien/`) auf die eigene Ansicht **`/m/pdf?u=<Pfad>`**:
  Kopfzeile „‹ Zurück“ + **„Teilen / Drucken“** (iOS-Teilenmenü: Drucken, In Dateien sichern, Mail, WhatsApp), darunter
  alle Seiten als Bilder (pdf.js aus `unpdf`, `/static/vendor/pdfjs.mjs`, iOS zeigt PDFs im Rahmen nur unvollständig;
  Rückfall Rahmen), Bilder direkt. Nur eigene Pfade; Rechte prüft die PDF-Adresse selbst.

- 2026-10-16: **Standort beim Stempeln immer an** (Ahmed: „GPS immer beim Stempeln an“): Schalter unter Zeiterfassung →
  Einstellungen entfällt (`geoCheckEnabled` immer true, Spalte `time_settings.geo_check` ungenutzt). Weiter nur Bewertung
  am Objekt / nicht am Objekt / ungenau / kein Standort + Entfernung, keine Koordinaten; Stempeln wird nie verweigert.
  Prüfung braucht einen Standort je Objekt (Objekt → QR-Aushang & Standort). **Datenschutz:** Mitarbeitende vorher
  informieren (Art. 13 DSGVO), Betriebsrat beteiligen falls vorhanden, Verzeichnis der Verarbeitungstätigkeiten.
- 2026-10-16: **PDF-Ansicht „leicht abgeschnitten“** (Ahmed, Lohnabrechnung Lexware): Lexware bettet Standardschriften nicht
  ein; ohne Schriftdaten nimmt pdf.js am iPhone eine Ersatzschrift mit anderen Breiten → Zahlen laufen über Zellränder.
  Jetzt liefert der Server die Standardschriften/CMaps von pdf.js mit (`pdfjs-dist` 6.1.200, gleiche Version wie in
  `unpdf`; `/static/vendor/pdfjs/standard_fonts|cmaps/…`, `useSystemFonts:false`). Seiten werden 1,5× schärfer als der
  Bildschirm gezeichnet (höchstens ~10 Mio. Pixel je Seite), damit Heranzoomen lesbar bleibt.
- 2026-10-16: Ahmed (3 Punkte):
  - **Auffällige Zeiten** (`/zeiterfassung/auffaellig`, Menü Personal → Auffällige Zeiten; `src/services/time-anomalies.ts`):
    letzte 14 Tage, abgeschlossene Zeiten, bei denen Ist stark vom Plan abweicht (mind. 30 Min. **und** 25 % der Planzeit;
    Plan = verknüpfter Einsatz bzw. Einsatz gleicher Person/Objekt/Wochentag, Tagesausnahme berücksichtigt) oder beim Ein-/
    Ausstempeln „nicht am Objekt“ (mit Entfernung). Häkchen → „als geprüft“ (optional Vermerk, `app.time_entry_reviews`,
    Migration `20261128000001`), dann verschwinden sie. Hinweis auf der Startseite (Büro und Objektleitung), Schild in der
    Zeiterfassung, Kachel „auffällig“ in der App unter Verwaltung. Objektleitung nur ihre Objekte.
  - **Büro/Objektleitung stempeln ohne Einsatz:** Mit verknüpftem Mitarbeiter zeigt die Stoppuhr alle Objekte, die die
    Person sieht (Büro-Rollen alle aktiven, Objektleitung ihre Objekte), mit Suchfeld; geplantes Objekt vorausgewählt.
    Server-Prüfung `assertMaySite` erlaubt dasselbe (`officeProfiles` in `time.ts`, nur aktive Konten).
  - PDF-Ansicht: Knöpfe der Kopfzeile schrumpfen nicht mehr (Text „‹ Zurück“ war angeschnitten), mehr Rand oben/seitlich.
- 2026-10-17: **Stoppuhr: Objekt wählen wie Fortytools, einfacher** (Ahmed, Bildschirmvideo): Fenster der Stoppuhr zeigt
  „Wo arbeitest du?“ mit Suchfeld (Objekt, Kunde, Adresse; mehrere Wörter), darunter „Heute geplant“ (mit Uhrzeit),
  „Zuletzt“ (eigene Zeiten der letzten 60 Tage) und bei bis zu 12 Objekten alle, sonst ab 2 Zeichen. Antippen →
  Einsatzdetails (Nr., Name groß, Adresse, Kunde, geplante Zeit) mit großem „Zeiterfassung starten“; „Anderes Objekt“
  zurück zur Liste. Steht das Objekt fest (heutiger Einsatz, einziges Objekt, QR), öffnen direkt die Details.
  Ohne den Zwischenschritt „Kundeneinsatz / Pause“ aus Fortytools (Pause steht in der laufenden Stoppuhr).
  `SitePicker` + `PICK_JS` in `routes-mobile.tsx`, Texte in 7 Sprachen (`pick_*`).
- 2026-10-17: **„Beim Wechseln sieht man wieder Safari“** (Ahmed, Screenshot Qualität mit X und Adresse): iOS merkt sich den
  App-Bereich beim Hinzufügen zum Home-Bildschirm – bei Installation vor dem 16.10. (Bereich nur `/m`) öffnen /qm und
  Büro-Seiten im Browserfenster. Server kann das an einer installierten App nicht ändern → **einmal Symbol entfernen und
  neu „Zum Home-Bildschirm“**. Neu: App-Seiten (/qm, App-Rahmen) verlinken das Manifest (Bereich `/`), Manifest ohne
  Zwischenspeicher (`no-cache`); die App erkennt die alte Installation (Cookie `vd_pwa` aus dem Vollbild, Seite ohne
  Vollbild) und zeigt dann die Anleitung (`SCOPE_JS` in `push-ui.tsx`).
- 2026-10-17: **„Mitarbeiter-Ansicht“ entfernt** (Ahmed): Knopf in der Zeiterfassung (öffnete `/m` im neuen Tab) und die
  Menü-Sonderregel dafür entfallen. Die eigene Zeiterfassung bleibt über „Meine Zeiten“ bzw. in der App „Meine Zeit“.
- 2026-10-17: **Anmeldung mit Geburtsdatum → eigene PIN Pflicht** (Ahmed): Meldet sich jemand mit dem Geburtsdatum TTMMJJ
  an (automatisch angelegte PIN oder PIN = Geburtsdatum), setzt die App `employee_pins.must_change` (Migration
  `20261129000001`; bestehende automatisch angelegte PINs werden ebenfalls markiert) und zeigt nur noch **„Eigene PIN
  festlegen“** (`/m/pin`, Vollbild, 7 Sprachen) – alle anderen /m-Seiten leiten dorthin um (`pinGate`). Neue PIN: 4–6
  Ziffern, nicht zu einfach, nicht das Geburtsdatum, zweimal eingeben (`changeOwnPin`, Protokoll `set_own_pin`).
  Vom Büro gesetzte PIN gilt ohne Wechsel. Später ändern: Profil → „PIN ändern“. Test in `runde18.db.test.ts`.
- 2026-10-17: **Anleitungen neu** (Ahmed): `docs/anleitung-mitarbeiter-app.html/.pdf` (neu, für Reinigungskräfte: anmelden +
  eigene PIN, Startseite, Start/Stopp, Zeit bestätigen/bearbeiten, Urlaub/Krank, Dokumente/Lohn/Stundenliste, Profil);
  `anleitung-app-installieren` (Abschnitt „Erste Anmeldung: eigene PIN festlegen“) und `anleitung-zeiterfassung-app`
  (neue Objektauswahl der Stoppuhr) aktualisiert. Bilder mit Beispieldaten: `OUT=docs/bilder/anleitung-app node
  e2e/_guide-shots.mjs` (Mitarbeiterin 7701 „Maria Beispiel“ in der Entwicklungs-DB; `OFFICE=1` für die Objektauswahl).
- 2026-10-17: **Zwei Anleitungen für die App** (Ahmed): `docs/anleitung-app.html/.pdf` (Bedienung, 13 Seiten: Grundlagen,
  Meine Zeit, Qualität, Verwaltung, Regeln; wer welchen Bereich sieht) und `docs/anleitung-app-installieren.html/.pdf`
  (iPhone/Android, Anmeldung + eigene PIN, Berechtigungen, „Adressleiste → neu hinzufügen“). Ersetzt
  `anleitung-mitarbeiter-app` und `anleitung-zeiterfassung-app`. Bilder nur mit Beispieldaten aus einer eigenen
  Demo-Datenbank (seed + demo-data): `OUT=… PNR=1001 PIN=4821 node e2e/_guide-shots.mjs` (Meine Zeit) und
  `OUT=… SITE=<objekt> EMP=<mitarbeiter> node e2e/_guide-shots-buero.mjs` (Objektleitung „olga“, mit Mitarbeiter
  verknüpft). Nebenbei: Kacheln der Verwaltungs-App mit Symbol über dem Text (Wörter wurden mitten im Wort umgebrochen),
  Audit-Ergebnis „33 %“ bricht nicht mehr um.
- 2026-10-17: **Bankabruf von Hand ohne 4-mal-täglich-Grenze** (Ahmed: „wieso nur 4× täglich?“): PSD2 (Delegierte VO (EU)
  2018/389, Art. 36 Abs. 5) erlaubt ohne Anwesenheit des Kontoinhabers höchstens 4 Abrufe je Konto und 24 Std. – das gilt
  weiter für den automatischen Abruf (6–21 Uhr, alle 4,5 Std.). Klickt jemand „Umsätze abrufen“, „Ältere Umsätze
  nachladen“ oder verbindet die Bank, schickt die App jetzt die Angaben des anwesenden Benutzers mit (`Psu-Ip-Address`
  aus X-Forwarded-For von Caddy, `Psu-User-Agent`, `Psu-Accept-Language`; `psuHeaders`/`psuOf`) – dann gilt die Grenze
  nicht. Der automatische Abruf schickt sie nie (wäre eine falsche Angabe gegenüber der Bank). Test in `bank-feed.db.test.ts`.
- 2026-10-17: **Soll als Ist nach 2 Tagen sieht aus wie vom Mitarbeiter bestätigt** (Ahmed: „wenn er sich nicht darum
  kümmert“): Die stündliche Übernahme (Einstellung seit 09.10. an, 2 Tage) trägt jetzt wie die Bestätigung in der App ein –
  Quelle „Soll bestätigt“, Status „erfasst“, erfasst von `m:<Personalnr.>`, ohne Büro-Freigabe (vorher „freigegeben“ von
  „automatisch“). Nur das Änderungsprotokoll nennt „automatisch“ (Grund „Plan als Ist automatisch …“) – nötig als Nachweis.
  Bereits automatisch übernommene Zeiten bleiben unverändert. **§ 17 MiLoG:** abweichende tatsächliche Zeiten korrigieren.
- 2026-10-17: **App Store lehnt öffentliche Verteilung ab** (Guideline 3.2, Build 1.0 (106)): App ist nur für Viva-Deluxe-
  Mitarbeitende → **Unlisted App Distribution** beantragen (developer.apple.com/support/unlisted/request), erst nach
  Zusage-Mail erneut einreichen; App ist dann nur über den direkten Link im App Store zu finden. Alternative Custom App
  über Apple Business Manager (D-U-N-S 343512805) nur sinnvoll für firmeneigene, verwaltete Geräte. Bis dahin Web-App.
- 2026-10-17: **Andere Rechnungsanschrift je Leistung** (Ahmed: „zur Leistung auch andere Rechnungsanschrift mitteilen“): In der
  Leistung (Abschnitt Abrechnung) Häkchen „Andere Rechnungsanschrift für diese Leistung“ (Name, Zusatz, Ansprechpartner,
  Straße, PLZ, Ort; vorbelegt mit der Anschrift laut Objekt/Gruppe/Kunde; `site_services.bill_address`, Migration
  `20261130000001`). Monatslauf und „Entwürfe aus verrichteten Leistungen“ legen dafür eine eigene Rechnung an mit der
  Anschrift „nur für diese Rechnung“ (`invoices.bill_address`); Leistungen mit gleicher Anschrift am selben Objekt kommen
  zusammen (`billAddressKey`). Format, E-Mail, Zahlungsziel, Leitweg-ID bleiben wie die Rechnungsgruppe – anderer
  Empfänger mit eigenen Angaben → eigene Rechnungsgruppe. Test in `services-billing.db.test.ts`.
- 2026-10-17: **Liquiditätsvorschau gelöscht** (Ahmed: „komplett löschen“): Startseiten-Karte, `src/services/liquidity.ts` und
  Test entfernt (keine eigenen Tabellen – nichts in der Datenbank gelöscht). Gespeicherte Startseiten-Layouts verwerfen den
  Eintrag automatisch (`normalizeDash`).
- 2026-10-17: **Tiefgaragen Münchner Wohnen: Leistungen eingefügt** (Ahmed: „überall hinzufügen“, ohne eigene Seite): Je
  aktivem TG-Objekt von Münchner Wohnen mit verknüpftem Objekt am Objekt die Leistungen „je Ausführung“ (Leistungsart
  Tiefgaragenreinigung, 19 %, gültig ab 01.01.2026): 1. Scheuersaugen 0,47 €/m², 2. Scheuersaugen 0,26 €/m², 3. Kehrsaugen
  0,32 €/m²; bei Duplex-Stellplätzen 1. Reinigung Duplex 5,27 €, 2. Reinigung Duplex 2,11 € je Stellplatz (Preise aus
  Ahmeds Fortytools-Bild). Menge = Fläche/Duplex am TG-Objekt, sonst aus der vorhandenen Fortytools-Leistung (wird dann am
  TG-Objekt ergänzt). Gleichnamige Leistung vorhanden → nichts doppelt; feste IDs. Läuft einmalig ~90 s nach dem Start
  (`ensureMwServices`, Protokoll `mw_services`). Ohne verknüpftes Objekt oder Fläche übersprungen. Arbeitsschein bei
  „bestätigen“ übernimmt diese Leistungen (mit Preis). „Mechanische Reinigung der Grube“ nicht enthalten.
  **Ahmed: Preise mit dem Vertrag abgleichen, ggf. je Leistung am Objekt ändern.**
- 2026-10-17: Tiefgarage Münchner Wohnen, Nachtrag (Ahmed): **„Mechanische Reinigung der Grube“** als sechste Standard-
  Leistung, 0,53 €/m² (306 m² = 162,18 € laut Fortytools-Auftragsliste). Fläche der Grube neu am TG-Objekt
  (`tg_objects.pit_sqm`, Migration `20261130000002`, Feld „Grube m²“), sonst aus einer vorhandenen Grube-Leistung.
  **Lohnkostenanteil 85 %** für alle Tiefgaragen-Leistungen der MW-Objekte (neue und übernommene) und als Vorgabe der
  Leistungsart „Tiefgaragenreinigung“. Beim Start einmal je Stand (`mw_services` mit `v: 2`): Stand 2 legt nur die Grube
  nach und setzt die 85 % – gelöschte Leistungen kommen nicht zurück. Speichern eines MW-TG-Objekts legt fehlende
  Standard-Leistungen dieses Objekts sofort an (z. B. nach Eintragen der Grube-Fläche). Preise je m²/Stellplatz gelten
  für alle MW-Garagen; der Betrag je Garage ergibt sich aus deren Fläche. Gleichnamige Leistungen aus Fortytools zählen
  als vorhanden (nichts doppelt).
- 2026-10-17: **Kunden-Dokumente auf Objekte übertragen** (Ahmed: „LV beim Kunden auf mehrere oder alle Objekte“): Kunde →
  Dokumente → „Auf Objekte übertragen“: Dokumente ankreuzen, Objekte (oder „alle aktiven“), Ablage (Standard: LV →
  Leistungsverzeichnis, Vertrag → Vertrag, sonst Sonstiges). Keine Kopie – dieselbe Datei (write-once) wird zusätzlich
  beim Objekt verknüpft (`linkCustomerFilesToSites`, Protokoll `file_link_sites`), nichts doppelt, nur Objekte desselben
  Kunden, nur Büro. Test `customer-docs.db.test.ts`.
- 2026-10-17: **Inaktive Objekte ausblenden / Leistungen inaktiv** (Ahmed): Kunde → Objekte mit Filter Aktiv (Standard) /
  Inaktiv / Alle; Kundenliste „Objekte (n)“ zählt und zeigt nur aktive („+ n inaktive anzeigen“). Leistung am Objekt:
  Knopf „Inaktiv“ je Zeile (Rückfrage) bzw. „Aktivieren“; inaktive stehen eingeklappt unter „Inaktive Leistungen“ und
  werden weder im Monatslauf noch bei „Leistungen verrichten“ abgerechnet (Protokoll activate/deactivate).
- 2026-10-17: **Fund „TG 3 - Sendling-Westpark ohne Leistungen“** (Ahmed, Bild): Fortytools liefert die m² nicht am Objekt,
  und viele „TG …“-Objekte hatten keinen Eintrag unter Tiefgaragenreinigung bzw. keine Fläche → übersprungen. Jetzt: Fläche,
  Duplex-Stellplätze und Grube werden zusätzlich aus den übernommenen Rechnungen gelesen (Menge der jüngsten Position
  „… Scheuersaugen / Duplex / Grube – Tiefgaragenreinigung“ am Objekt) und am TG-Objekt eingetragen; aktive Objekte
  „TG …“/„Tiefgarage …“ von Münchner Wohnen ohne TG-Eintrag bekommen einen (`ensureMwTgObjects`, feste ID). Läuft beim
  Start einmal als Stand 3 (`mw_services` `v: 3`) für alle Positionen; Objekte ohne Fläche in Rechnungen bleiben leer →
  Fläche unter Disposition → Tiefgaragenreinigung eintragen, dann werden die Leistungen beim Speichern angelegt.
- 2026-10-17: **Pflichtdokumente je Objekt abwählbar** (Ahmed: „Pflicht wegmachen können“): Objekt → Dokumente: fehlt Raumbuch,
  Leistungsverzeichnis oder Revierplan, steht dort „Für dieses Objekt nicht nötig“ (→ Schild „nicht nötig“, zählt nicht mehr
  als fehlend, keine Seite „Noch nicht hinterlegt“ im Objektordner, nicht in den fehlenden Angaben) bzw. „Wieder als Pflicht
  führen“. `sites.docs_not_needed` (Migration `20261130000003`), Protokoll `doc_not_needed`/`doc_required`. Beim Kunden gibt es
  keine Pflichtdokumente.
- 2026-10-17: **Tiefgaragen Münchner Wohnen: Termine 2026 + Abrechnung Herbst** (Ahmed: Terminliste März 2026 (Excel) und
  Terminübersicht Sept./Okt. (PDF) – „Termine, Leistungen, Fläche eintragen und in ‚Aus Einzelleistungen erstellen‘“;
  „Termine September wurden schon abgerechnet“). Daten in `src/services/garage-mw-2026.ts` (Fortytools-Objektnummern,
  aus Ahmeds Dateien erzeugt, keine Personaldaten), Ablauf `garage-mw-schedule.ts`, einmal beim Start (`mw_tg_2026`):
  80 Termine unter Disposition → Tiefgaragenreinigung (Frühjahr = Nassreinigung, erledigt, „in Fortytools abgerechnet“;
  Herbst = Kehren, vergangene erledigt), Flächen/Duplex am TG-Objekt ergänzt (nur wenn leer), Hinweise wie
  „inkl. LICHTSCHÄCHTE“ als Termin-Notiz. **Herbsttermine ab 01.10.** → verrichtete Leistungen (3. Kehrsaugen,
  2. Reinigung Duplex, Grube – wie Fortytools 10/2025) → Entwürfe → „Aus Einzelleistungen erstellen“; September und
  Objekte mit Fortytools-Rechnung ab 09/2026 nicht. Probe mit den übernommenen Daten: 41 Leistungen, 15.992,84 € netto.
  Termine bis 29.10. sind schon vorgemerkt – fällt einer aus/verschiebt sich, dort „zurücknehmen“. Zuordnung:
  „Ludlstr. 2“ → 2001742 (Ludlstr. 3), „Gilmstr. 58a“ → 20018003 (Abrechnung früher auf 2001738), „Zillertalstr. 60
  (2 Garagen)“ → 2001721 + 2001722 (2001721 ohne Fläche → keine Leistung), „Kemptenerstr. 10+20“ → 2001709 + 2001710,
  „Züricherstr. 178“ → 2001726. Nebenbei: Fläche aus Fortytools-Rechnungen griff nicht (Titel heißen „1. Scheuersaugen“
  ohne „Tiefgarage“), vorhandene Leistungen werden jetzt am Positionsanfang erkannt („3. Scheuersaugen“ = 3. Durchgang).
- 2026-10-17: Tiefgarage Herbst (Ahmed: „Grube oder Duplex in derselben Rechnung wie Kehren, nicht separat“): geprüft mit
  den übernommenen Daten – „Aus Einzelleistungen erstellen“ legt je Objekt **eine** Rechnung mit Kehrsaugen, Duplex und
  Grube an (6 Objekte mit mehreren Positionen, keine Leistung mit eigener Rechnung/Anschrift/Gruppe). Reihenfolge in der
  Rechnung jetzt fest: Kehrsaugen → Duplex → Grube (Ausführungen nach Datum, Vormerk-Zeitpunkt, Leistung sortiert).
  Nur Ankreuzen einzelner Zeilen würde sie trennen – je Kunde/Monat alles ankreuzen. Test in `garage-mw-schedule.db.test.ts`.
- 2026-10-17: **Fehlende TG-Leistungen** (Ahmed: „bei einigen fehlen noch Leistungen“): Garagen, deren Fläche nur aus den
  Terminlisten 2026 kam (z. B. nur September-Termin), bekamen keine Standard-Leistungen – jetzt für jede Garage der Listen;
  Stand `mw_services` v4 holt das beim nächsten Start einmal nach. Ohne Fläche (nirgends hinterlegt) keine Leistungen:
  Liste Tiefgaragenreinigung zeigt „m² fehlt – keine Leistungen am Objekt“. In der Datenkopie: 2001712 (Krokusstr. 73),
  2001721 (Zillertalstr. 60), 2001724 (Züricherstr. 178), 2001728 (Skagerrakstr. 11) – **Ahmed: m² eintragen**, beim
  Speichern entstehen die Leistungen. Keine Platzhalter-Menge (würde falsche Beträge abrechnen).
- 2026-10-17: **Raumbuch + Revierplan ARGE U5W2** (Ahmed, Containerpläne RECON/ALHO): je Objekt 20166001–005 eine Raumbuch-Excel
  (Importformat, Raum-Nr. = Etage.lfd. Nr., Fläche und Belag laut Plan, Turnus W2 angenommen) und ein Revierplan-PDF (Logo,
  Tätigkeiten je Raumart, Räume je Etage). Startschacht: Plan ohne Maße → Flächen geschätzt (14 / 28 m²), Erste Hilfe und
  Bauherr Turnus 0. AG G 2.OG: Büros im Plan doppelt nummeriert (6–9) → „Büro 2.OG-1 … -4“. Dateien nur an Ahmed
  (Kundendaten, nicht im Repo); Import über Objekt → Raumbuch, Revierplan unter Dokumente → Revierplan.
  Für 20166006 (Sanitärcontainer Am Knie 33) und 20166007 (TU Container Personal) liegen keine Pläne vor.
- 2026-10-17: **Zusätzlicher Urlaub** (Ahmed): Mitarbeiter → Urlaub & Krank → „Zusätzlicher Urlaub“ (Admin/Personal): Jahr,
  Tage (halbe Tage, minus zieht ab), Grund Pflicht (`app.leave_extra`, Migration `20261201000001`, feste ID je Formular,
  Löschen mit Protokoll). Kommt zum gerechneten Anspruch dazu (nicht anteilig gekürzt), zählt im Rest, Übertrag und in
  der Anspruchsprüfung; Kachel zeigt „darin +n zusätzlich“. **Rechtlich:** Schwerbehinderte haben 5 Arbeitstage
  Zusatzurlaub bei 5-Tage-Woche (§ 208 SGB IX, im Ein-/Austrittsjahr anteilig – Tage dann selbst entsprechend eintragen).
- 2026-10-17: ARGE U5W2 Raumbuch/Revierplan Fassung 2 (Ahmed): 20166001 + 20166002 Di/Do 17:00–21:30 (W2), 20166003
  Mo/Mi/Fr früh oder mittags (W3), 20166005 Di/Do früh oder mittags (W2), 20166004 entfällt, 20166007 TU Container
  Personal neu aus dem Lageplan BE-A TU-Anlage (16 Container, Flächen geschätzt, Di/Do wie 20166005).
- 2026-10-18: **Bestellungen → „Zu erledigen“ bei Nachunternehmern** (Ahmed): erteilte/beendete NU-Bestellungen stehen dort,
  solange der unterschriebene Auftrag fehlt, eine Rechnung für einen abgelaufenen Zeitraum fehlt, eine Bestellung „nach
  Ausführung“ beendet ist und keine Rechnung hat, oder – laufende (monatlich/wöchentlich) – ab 5 Tage vor Monatsende
  („Monatsende – Rechnung erwartet“). Grund steht im Status (`subcontractTodo` in `expected-invoices.ts`). Bestellungen
  „nach Ausführung“, die vor dem 01.09.2026 endeten, zählen nicht (im alten System abgerechnet, `TODO_FROM`). Probe mit
  der Datenkopie: 60 von 122 NU-Bestellungen zu erledigen. Erledigen: Rechnung erfassen oder „keine Rechnung …“ vermerken.
- 2026-10-18: **Arbeitsscheine offen / erledigt + Unterschrift zuweisen** (Ahmed): Übersicht mit Reitern Offen (Standard) /
  Erledigt / Alle statt „ohne Unterschrift / nicht abgerechnet“; Häkchen je Zeile → „Markierte als erledigt“, „wieder
  offen“, „zum Unterschreiben zuweisen“. **Erledigt nur mit Unterschrift des Kunden** (`setWorkReportDone`); erledigt =
  von Hand markiert oder unterschrieben + ausgestellte Rechnung (`workReportDone`). **Zuweisen** (Liste oder am Schein,
  Kasten „Unterschrift in der App einholen“): eine oder mehrere Personen (`work_reports.sign_employee_ids`, Migration
  `20261201000002`); „ohne Unterschrift“ abgeschlossene Scheine werden dafür wieder geöffnet (alte Fassung bleibt im
  Archiv). In der Mitarbeiter-App steht der Schein ganz oben auf der Startseite (einer = großer Knopf, mehrere = Liste zum
  Auswählen), dazu Push-Nachricht. Ohne Zuweisung wie bisher alle eingesetzten Mitarbeitenden.
- 2026-10-18: Ahmed (5 Punkte):
  - **Arbeitsscheine ohne Unterschrift-Pflicht** (viele auf Papier unterschrieben): „erledigt“ = abgeschlossen (Unterschrift
    oder ohne) und als erledigt markiert bzw. abgerechnet; Schild „Unterschrift fehlt“ und Warnhinweise entfernt. Sammel-
    „erledigt“ schließt Entwürfe vorher mit Grund „auf Papier unterschrieben / erledigt“ ab. Zuweisen zum Unterschreiben in
    der App bleibt.
  - **NU-Bestellungen: Gesamtbetrag** (`subcontractTotal`): Monatspauschale = Preis/Monat; je Stunde mit max. Std./Monat =
    Satz × Stunden (darunter „25,00 € / Std. × 40 Std.“); sonst Einheitspreis mit „Gesamt nach erfassten Stunden“.
    Bestellliste und Bestellungen beim Nachunternehmer.
  - **Alte NU-Bestellungen gelten als unterschrieben** (Migration `20261201000003`, `subcontracts.signed_external =
    'unterschrieben (alte App)'`): alle erteilten/beendeten ohne Nummer im Format BE-JJJJ-NNNN (Datenkopie: 118 von 122).
    Neue Nummern bleiben unverändert. Erledigt-Markieren ist damit möglich, kein „unterschriebener Auftrag fehlt“ mehr;
    der Import aus der alten App setzt das künftig selbst.
  - **Fotos mit Stempel** (`src/services/photo-stamp.ts`, neue Abhängigkeit `sharp` 0.35.4): unten Balken mit hellem Logo,
    Objekt-Nr. · Name · Adresse, Datum/Uhrzeit (Serverzeit), Name, Standort (am Objekt mit Entfernung / nicht am Objekt /
    ungenau / kein Standort + Koordinaten). Gestempelt wird auf dem Server (nicht am Handy veränderbar). Das Original
    bleibt write-once als eigene Datei ohne Verknüpfung, Stand in `app.photo_stamps` (Migration `20261202000001`,
    unveränderbar). Gilt für **QM-App-Fotos** (Audit) und die neue Seite **Verwaltung → Foto** (`/qm/foto`): Objekt
    optional (Objektleitung nur eigene), bis 10 Fotos, Bemerkung; mit Objekt → Objekt → Dokumente → „Fotos“, ohne Objekt →
    Dokumenteneingang; „Zuletzt aufgenommen“. **Nicht** bei Arbeitsscheinen und Tickets (Ahmed).
    **Datenschutz:** Standort nur beim Fotografieren, Mitarbeitende informieren (Art. 13 DSGVO).
- 2026-10-18: **Fotos als Gruppe** (Ahmed: „mehr als 10 Fotos“, „sehe es nicht im Dokumenteneingang“, „gruppenweise, Bemerkung
  aufs Bild, als PDF zusammen, löschen können“): Verwaltung → Foto: bis 50 Fotos je Vorgang, „Foto aufnehmen“ (Kamera)
  oder „Aus Galerie (mehrere)“, Vorschau mit × zum Entfernen; Fotos werden im Browser auf 2000 px als JPEG verkleinert
  (schneller Upload, iPhone-HEIC wird so JPEG). Felder **Ort / Adresse** und **Schaden / Bemerkung** stehen fett im Stempel
  jedes Fotos. Ein Absenden = eine Gruppe (`app.photo_groups`, Migration `20261202000002`, feste ID je Formular → doppelt
  absenden nichts doppelt): **ein PDF mit allen Fotos** (je Foto eine A4-Seite mit Titel und „Foto n von m“) im
  Dokumenteneingang (Kategorie „Fotos (App)“) bzw. mit Objekt unter Objekt → Dokumente → Fotos. Einzelfotos und Originale
  bleiben write-once ohne Verknüpfung, Vorschau über `/qm/foto/bild/<id>` (Büro alle, Objektleitung eigene Objekte/Fotos).
  Dokumenteneingang zeigt die Gruppe mit Titel, Anzahl, Vorschaubildern; **„Löschen“** je Eintrag (Fotogruppe: ausgeblendet
  + PDF-Verknüpfung weg, Protokoll; sonstige Dateien: nur aus dem Eingang). Ein kaputtes Bild hält die anderen nicht auf
  (Meldung je Datei). Vermutete Ursache „nicht im Eingang“: Speichern scheiterte an einzelnen großen/HEIC-Fotos.
- 2026-10-18: **Fotogruppen als Aufgabe für Admin** (Ahmed: „Bemerkung oben im PDF und unten im Bild – lieber nur darüber“,
  „weder zum Objekt noch in den Dokumenteneingang, als Aufgabe für Admin, erledigt → löschen“): Fotos aus Verwaltung → Foto
  werden **ohne Stempel** gespeichert (nur gedreht/verkleinert, `saveStampedPhoto(..., stamp: false)`); im PDF steht über
  jedem Foto Logo, Ort/Objekt, Schaden/Bemerkung (Bordeaux), Datum/Uhrzeit · Name, Standort. Das PDF hat keine
  Verknüpfung (nicht beim Objekt, nicht im Dokumenteneingang); je Gruppe eine **Aufgabe „Fotos prüfen: …“** (feste ID,
  zuständig = erster aktiver Admin, `entity_type 'photo_group'`, Migration `20261202000003`) mit „Fotos ansehen“ (`/fotos/<id>`)
  und PDF (`/fotos/<id>/pdf`). Ist die Aufgabe erledigt: „Fotos löschen“ in der Aufgabenliste bzw. auf der Fotoseite
  (Gruppe ausgeblendet, Aufgabe gelöscht, Protokoll; Dateien bleiben write-once). QM-Audit-Fotos behalten den Stempel.
  Ältere Gruppen (vor dieser Änderung) bleiben im Eingang/beim Objekt.
- 2026-10-18: **Menü aufgeräumt** (Ahmed, 5 Punkte):
  - Objekt-Formular: „Bestellnummer des Kunden“ und „Vertragsnummer“ entfallen (Bestellnummer gehört an Rechnungsgruppe
    bzw. Leistung). Alte Werte bleiben gespeichert und werden nur noch angezeigt, wenn vorhanden („alt – leeren entfernt
    sie“); fehlt das Feld im Formular, wird nichts überschrieben. Eine alte Objekt-Bestellnummer gilt weiter als Rückfall
    auf Rechnungen, bis sie geleert ist.
  - „Noch nicht versendet“ aus dem Menü (Startseite verlinkt die Seite weiter). Preisanpassung unter **Kunden**.
  - **Monatsabschluss gelöscht** (Seite, Service, Test; `/monatsabschluss` → Startseite). Tabelle `month_closings` mit
    früheren Abschlüssen bleibt in der Datenbank.
  - **Weniger Unterseiten:** Personal = Mitarbeiter · Bewerber & Stellen · Zeiterfassung; Transfer = Bank · Dokumente ·
    Lohn & DATEV · Importe; Auswertungen = Umsatz & Ausgaben · Nachkalkulation · Urlaub & Krankheit · Dienste-Liste.
    Die Seiten darunter erscheinen als **Reiter oben auf der Seite** (`SECTION_TABS`/`SectionTabs` in `layout.tsx`,
    nur auf genau diesen Adressen, nach Rolle gefiltert; Menüpunkt bleibt markiert). „Meine Zeiten“ steht nur noch oben
    in der Kopfzeile. Adressen unverändert.
- 2026-10-19: Ahmed (5 Punkte + 2 Nachträge):
  - **Glasreinigung, Block-Termine:** Terminübersicht (Jahresplaner-Druck) zeigt „30.03.–31.03.2027 (2 Tage)“ und
    Uhrzeit „täglich“, Liste „bis …“. **Fund:** Die alte App speicherte manche Block-Termine nur mit `datum`/`datum_bis`
    ohne Einzeltage – der Import nahm nur den ersten Tag. Jetzt Mo–Fr ohne Feiertage dazwischen; erneuter Import der
    alten App ergänzt bestehende eintägige Termine (nur wenn sie noch einen Tag haben).
  - **Terminbestätigungen** (Glasreinigung): mehrere je Termin (Datum, wer/wie, erfasst von) in
    `glass_appointments.confirmations` (Migration `20261203000003`, alte Bestätigung übernommen). Eintragen direkt in der
    Terminkarte bzw. am Termin, entfernen mit Protokoll. Sie hängen am Termin selbst → wird er verschoben, bleiben sie.
    Folgetermine starten ohne Bestätigung. Auch in der gedruckten Terminübersicht (Spalte „Bestätigung“).
  - **Besonderheiten** als Kasten in der Objekt-Übersicht, direkt eintragbar (gleiches Feld wie Objektordner,
    `folder_info.besonderheiten`, bis 2000 Zeichen, Protokoll). Die **Objektleitung sieht jetzt die Objekt-Übersicht**
    (vorher Umleitung auf Einsätze wegen Preisen – die Übersicht enthält keine Preise mehr).
  - **Verbandbuch** (`app.first_aid_entries`, Migration `20261203000002`, `routes-first-aid.tsx`): Einträge je
    Mitarbeiter (Datum/Uhrzeit, Objekt, Ort, Hergang, Verletzung, Erste Hilfe, Ersthelfer, Zeugen, Arzt, > 3 Tage AU).
    Personal → Verbandbuch (Admin/Personal alles; Objektleitung nur Einträge ihrer Objekte, anlegen nur für dort
    eingesetzte Leute), beim Mitarbeiter unter „Mehr“. Ändern mit altem Stand im Protokoll, löschen nur Admin.
    **Rechtlich:** DGUV Vorschrift 1 § 24 Abs. 6 – jede Erste-Hilfe-Leistung dokumentieren, 5 Jahre aufbewahren;
    Gesundheitsdaten (Art. 9 DSGVO) → keine Diagnosen, Zugriff begrenzt (RLS); > 3 Tage AU = Unfallanzeige an die BG
    (§ 193 SGB VII).
  - **Fehlende Unterlagen:** „Stundenliste <Monat> nicht unterschrieben“ bzw. „nach Unterschrift geändert“ für die
    letzten zwei abgeschlossenen Monate mit erfasster Zeit (ab Oktober 2026, frühere Monate sind Import;
    10 Min. zwischengespeichert). Seite jetzt auch für die Objektleitung (Menü Personal; nur ihre Leute, ohne
    Stammdaten-/Nummern-Lücken, kein „nicht nötig“).
  - **Audit einheitlich Punkte 1 bis 5** (Migration `20261203000001`): Note 1–6 und Gut/Mittel/Schlecht → Punkte;
    Ja/Nein bleibt (Abfallbehälter, Spinnweben, Verbrauchsmaterial). Alte Bewertungen behalten ihren Prozentwert
    (Ergebnisse unverändert), der Wert wird auf die nächste Punktzahl umgerechnet. Neue Gegenstände nur Punkte oder Ja/Nein.
  - **Fund „mobile Version am PC“:** Wer am PC einmal `/qm` oder `/app` öffnete, bekam das App-Cookie – danach alle Seiten
    im Handy-Rahmen. Jetzt gilt der App-Rahmen nur auf Handy/Tablet (`inAppFrame`: Cookie + Touch-Gerät); `/app` am PC
    leitet angemeldete Büro-Benutzer auf die Startseite, Anmeldung über `/app` am PC zählt wie die Büro-Anmeldung.
  - Tests: neu `runde44.db.test.ts`; e2e login 47, rechte 42, runde10 40, kasse 68, objekt 31, objektseiten 40, menu grün.
- 2026-10-19: Nachtrag (Ahmed, 2 Punkte):
  - **Fund Glas-Bestätigungsdatum:** Die Übernahme der alten Bestätigung (Migration `20261203000003`) setzte als Datum das
    Anlagedatum des Termins – das war nie das Bestätigungsdatum. Migration `20261203000004` entfernt es (Datum unbekannt =
    leer, Text bleibt); Anzeige ohne Datum. Neue Bestätigungen tragen das eingegebene Datum.
  - **Mein Team für die Objektleitung am PC** (Personal → Mein Team, `/team`, `routes-team.tsx`, nur Objektleitung):
    Mitarbeitende ihrer Objekte mit Suche (Name, Personalnr., Telefon), Telefon, Objekte, Schild „n fehlt“/„vollständig“;
    je Person Kontakt, Einsätze an ihren Objekten, Abwesenheiten und **Unterlagen** (ansehen + hochladen) der Kategorien
    `TEAM_DOC_CATEGORIES` (Personalunterlagen, Unterweisung, Arbeitskleidung, Schlüssel, Aufenthalts-/Arbeitserlaubnis,
    Bescheinigung). Download/Upload-Recht über `linkAllowed` mit Kategorie, nur Leute ihrer Objekte; ZIP gesperrt.
    Nicht sichtbar: Verträge, Lohnabrechnungen, Abmahnung/Beendigung, Steuer-ID, SV-Nr., Bank, Vergütung. In der App
    beim Mitarbeiter Knopf „Unterlagen“. Globale Suche oben bleibt für die Objektleitung aus.
    **Datenschutz:** Objektleitungen sehen damit Personalunterlagen und Ausweis-/Aufenthaltskopien ihrer Leute – im
    Verzeichnis der Verarbeitungstätigkeiten festhalten, Objektleitungen auf Vertraulichkeit verpflichten.
- 2026-10-19: Glasreinigung (Ahmed: „Bestätigung bei manchen rausgenommen“, „Liste der bestätigten und unbestätigten drucken“):
  **Fund:** Die Übernahme in die neue Bestätigungsliste nahm nur Termine mit gesetztem Häkchen „Termin-Bestätigung“ –
  stand nur der Bestätigungstext da („Tel. bestätigt am …“), fehlte sie. Migration `20261203000005` holt diese Texte als
  Bestätigung zurück (Datum unbekannt, Datum steht ggf. im Text). Neu **„Bestätigungen drucken“** (Termine-Liste,
  `/glasreinigung/bestaetigungen`): offene Termine im Zeitraum (Standard heute + 90 Tage), Kunde, Auswahl alle / nur
  unbestätigte / nur bestätigte; Abschnitte „Noch nicht bestätigt“ (mit Linie zum Eintragen) und „Bestätigt“ (mit
  Bestätigungen), A4 quer, Drucken/PDF.
- 2026-10-19: **Bestellungen löschen** (Ahmed: „viele auf einmal angelegt, mit Markiermöglichkeit“): Bestellungen-Liste mit
  Häkchen je Zeile und „alle markieren“ → „Markierte löschen“ (Rückfrage; Material- und NU-Bestellungen). Entwürfe darf
  jedes Büro-Konto löschen, erteilte/beendete/stornierte nur Admin; gesperrt bei verknüpfter Eingangsrechnung bzw.
  gelieferter Material-Bestellung (Meldung je Bestellung, die anderen werden trotzdem gelöscht). Stand (inkl.
  Preisnachträge, Stundennachweis, Positionen) vorher ins Protokoll; Tagesausnahmen verlieren nur die Verknüpfung,
  Freigabe-Aufgabe der Anfrage entfällt. Nummern werden nicht wieder vergeben.
- 2026-10-19: **Bestellungen → „Zu erledigen“ nur noch Entwürfe und erteilte NU-Bestellungen ohne unterschriebenen Auftrag**
  (Scan/Handy-Unterschrift fehlt; Ahmed: „erwartete Rechnungen sind ja unter Rechnungseingang“) – ersetzt die Regel vom
  18.10. Fehlende/erwartete Rechnungen zeigt weiter die Spalte „Abrechnung“ und Rechnungseingang → „Rechnung erwartet“;
  gelieferte Material-Bestellungen ohne Rechnung stehen unter „Abgeschlossen“.
- 2026-10-19: **Vorlagen für Nachunternehmer automatisch ausgefüllt** (Ahmed: „Selbstauskunft, Vertrag usw. wie in der alten
  App, anpassen, verbessern“): Nachunternehmer → Dokumente → „Vorlagen erstellen“ (`src/services/nu-docs.ts`, Texte
  `src/domain/subcontract/nu-docs.ts`, Briefpapier „edel“): Rahmenvertrag (Vertragsbeginn wählbar), Selbstauskunft &
  Compliance-Erklärung (vorab angekreuzt oder leer), Mindestlohnerklärung, Tariftreue-Erklärung (Tariflöhne aus
  Einstellungen), Bewertungsbogen (ISO 9001), Personaleinsatzliste (Excel). Firmen-/NU-Daten werden eingesetzt;
  „in Dokumente ablegen“ speichert das PDF unter „Verträge“ (nichts doppelt). Am Nachweis „Vorlage ausgefüllt erstellen“;
  im **Upload-Portal** können Nachunternehmer die ausgefüllte Vorlage selbst herunterladen, unterschreiben und hochladen.
  **Überarbeitet gegenüber der alten App:** Arbeitszeitgesetz statt „Arbeitszeitordnung“, keine SOKA-BAU (gilt nicht für
  Gebäudereinigung), Kundenschutz nach Vertragsende 2 statt 5 Jahre, kein „Verzicht auf Fortsetzungszusammenhang“,
  Vertragsstrafen niedriger und je Jahr gedeckelt, 500-€-Pauschale mit Gegenbeweis (§ 309 Nr. 5 BGB), Abwerbeverbot nur
  aktives Abwerben, Textform statt doppelter Schriftform, neu § 13b UStG, Ausschlussgründe (§ 19 MiLoG, § 21 SchwarzArbG,
  Wettbewerbsregister) und § 17 MiLoG-Aufzeichnung. **Rechtlich:** Rahmenvertrag ist AGB – vor dem Einsatz von einem
  Anwalt prüfen lassen. „Auftreten als Personal des Auftraggebers“ (§ 5) plus beigestellte Kleidung kann bei enger
  Einbindung als verdeckte Arbeitnehmerüberlassung gewertet werden (§ 9, § 10 AÜG) – § 6 (keine Eingliederung) im Alltag
  einhalten. Die Nachweise selbst schützen nicht vor der Auftraggeberhaftung (§ 13 MiLoG, § 28e Abs. 3a SGB IV).
- 2026-10-19: **Sammelbestellung an Nachunternehmer** (Ahmed: „nicht jede Tiefgarage einzeln“, „Preis je m²“, „oder feste
  Marge z. B. 10 % und Rest Sub“): Bestellung → Abrechnung neu **„je m² (Preis je m² Fläche)“** und **„Anteil am Umsatz
  (feste Marge)“** (Feld „Unsere Marge in %“). Im Entwurf „Als Sammelbestellung“ ankreuzen und weitere Objekte bzw. **alle
  aktiven Objekte eines Kunden** aufnehmen → eine Bestellung (eine Nummer, eine Unterschrift), Kasten „Sammelbestellung“ mit
  Fläche je Objekt (vorbelegt aus Tiefgarage bzw. Raumbuch, änderbar), Kosten je Objekt, Summe, Objekte hinzufügen/entfernen
  (`app.subcontract_sites`, `subcontracts.margin_bp`, Migration `20261204000001`, `src/services/subcontract-sites.ts`).
  Kosten je Objekt: je m² = Preis × Fläche; Pauschale = nach Fläche verteilt; Anteil am Umsatz = unser Netto-Erlös des
  Objekts im Monat × (100 % − Marge). Eingangsrechnung zur Sammelbestellung wird automatisch auf die Objekte verteilt (nach
  Fläche bzw. Umsatz, centgenau, ohne Fläche gleichmäßig); Nachkalkulation schätzt fehlende Monate genauso (je m² nur bei
  monatlicher Bestellung). Bestellschein mit Objektliste (Fläche, Betrag). Bestellliste: „Sammelbestellung · n Objekte“,
  Gesamtbetrag = Preis × Gesamtfläche. Ohne Häkchen wie bisher je Objekt eine eigene Bestellung. Bereits verteilte
  Eingangsrechnungen werden bei späteren Flächenänderungen nicht neu verteilt (dort ggf. „Kostenstellen“ neu speichern).
- 2026-10-19: **Fund „Sammelbestellung kann ich nicht anlegen“** (Ahmed): Das Häkchen „Als Sammelbestellung“ lag im
  Formularraster (Beschriftung links / Feld rechts) und wurde zu einer schmalen, kaum bedienbaren Spalte zerdrückt. Jetzt
  eigene Felder im Bestellformular: **„Bestellung für“** (ein Objekt / mehrere Objekte – eine Sammelbestellung) und
  **„Alle Objekte eines Kunden“**; bei Sammelbestellung darf „Objekt“ leer bleiben (erstes weiteres Objekt bzw. erstes
  aktives Objekt des Kunden wird Hauptobjekt). Im Browser durchgespielt (Kunde gewählt, je m², 0,30 € → Kasten mit allen
  Objekten).
- 2026-10-19: **NU-Bestellung auch unter 50 % Nachweise erteilen** (Ahmed): ersetzt die Sperre vom 09.10. Fehlen Nachweise,
  zeigt der Entwurf über „Auftrag erteilen“ einen Hinweis (x von y gültig, was fehlt, Haftung § 13 MiLoG / § 14 AEntG /
  § 28e Abs. 3a SGB IV); unter 50 % muss „Hinweis zur Kenntnis genommen“ angehakt werden (Server prüft
  `acceptMissing`), Protokoll `nachweise_fehlen` + `hinweis_bestaetigt`. **NU-Vorlagen mit Datum** (Rahmenvertrag,
  Selbstauskunft, Mindestlohn, Tariftreue, Bewertung): Feld „Datum“ (Standard heute) setzt Stand und „Ort, Datum“ ein
  (Ort = Sitz des NU, beim AG bzw. Bewertungsbogen unser Ort). Auch direkt am Nachweis: Datum wählen → „Vorlage ausgefüllt
  erstellen“.
- 2026-10-19: **Alte NU-Aufträge mit mehreren Objekten = Sammelbestellung** (Ahmed: „in einer Bestellung waren mehrere
  Objekte“): Der Import aus der alten App legte solche Aufträge nur auf das erste Objekt. Jetzt werden Objektnummern aus
  der Kostenstelle („20166001 + 20166002 …“) bzw. der Objektliste (Tab-Zeilen, Betrag je Objekt am Ende) gelesen
  (`legacyOrderSites`) und als eine Sammelbestellung angelegt; **erneuter Import (Transfer → Import aus der alten App →
  Nachunternehmer) repariert bereits übernommene** (nur solange sie noch keine Objektliste haben). Im Backup: DIL-004
  (Container ARGE, 7), DIL-010 (ARGE U5W2, 7), DRN-027 (SVLFG, 3), DRN-028 (Stadt Garching, 32), DRN-034 (Planegg, 19);
  DIL-012 hat eine vertippte zweite Nummer („200175002“) → bleibt bei einem Objekt. Neu **Betrag je Objekt**
  (`subcontract_sites.share_cents`, Migration `20261205000001`): bei Pauschalen wird danach statt nach Fläche verteilt
  (Rechnung, Schätzung Nachkalkulation), aus der alten App übernommen, im Kasten „Sammelbestellung“ änderbar.
  Fund: Auswahl „Bestellung für“ und Kasten hatten dieselbe ID `sammel` (jetzt `sammel-art`).
- 2026-10-19: **Angebot: Objekt als Freitext** (Ahmed): Ist kein Objekt gewählt, gibt es im Angebot das Feld „Objekt
  (Freitext)“ (`offers.object_text`, Migration `20261206000001`, bis 500 Zeichen). Es steht als „Objekt: …“-Band im PDF und
  in der Briefansicht, wird beim Kopieren/Folgeangebot übernommen; es wird kein Objekt angelegt. Mit gewähltem Objekt
  gilt das Objekt (Freitext wird geleert). Test in `offers-extra.db.test.ts`.
- 2026-10-19: **Verträge am Objekt** (Ahmed: „neben freiem Brief Arbeitnehmerüberlassungsvertrag und Reinigungsvertrag“):
  Objekt → Dokumente → „Reinigungsvertrag erstellen“ / „Arbeitnehmerüberlassungsvertrag erstellen“ (`/objekte/:id/vertrag`,
  nur Büro; `src/services/site-contracts.ts`, Texte `src/domain/contracts/site-contracts.ts`, PDF im Stil „edel“, auf Wunsch
  unter Dokumente → „Vertrag“ abgelegt). **Reinigungsvertrag:** Kunde = AG, Beginn, unbefristet oder fest bis (+ 12 Monate
  Verlängerung), Kündigungsfrist, Monatspauschale und **Anlage 1 Leistungsverzeichnis** aus den aktiven Leistungen,
  Zahlungsziel aus Rechnungsgruppe, **Lohngleitklausel** über den Lohnkostenanteil (Vorschlag gewichtet aus den Leistungen;
  Kostenelementeklausel § 1 Abs. 2 Nr. 3 PrKG), Weisungsrecht beim AN (Abgrenzung zur AÜ), Mängel/Nachbesserung,
  Haftung. **AÜ-Vertrag (§ 12 AÜG):** nur mit eingetragener AÜ-Erlaubnis (Firmendaten; gilt sie nicht bis Beginn → Fehler),
  Bezeichnung als AÜ, Eckdaten (Einsatzort, Tätigkeit, Anzahl, Einsatzzeit, Verrechnungssatz), Benennung der
  Leiharbeitnehmer vor Beginn (Anlage 1), Höchstüberlassungsdauer 18 Monate, Angaben des Entleihers zu vergleichbaren
  Arbeitnehmern (Anlage 2), Arbeitsschutz/Streik, Vermittlungsvergütung wählbar (2/1,5/1/keine, je Monat −1/12).
  **Rechtlich:** AÜ-Vertrag braucht Schriftform – ausdrucken und vor Beginn eigenhändig unterschreiben (sonst fiktives
  Arbeitsverhältnis zum Kunden, § 9/§ 10 AÜG); beide Texte sind AGB → vor dem ersten Einsatz anwaltlich prüfen lassen.
  Test `site-contracts.db.test.ts`.
- 2026-10-19: **Geräte mit QR-Code verfolgen, Stufe 1** (Ahmed: Scheuersaugmaschinen, Staubsauger, auch Wischwagen usw.):
  Geräte haben Art (Scheuersaugmaschine, Staubsauger, Nasssauger, Wischwagen, Reinigungswagen, Einscheibenmaschine,
  Hochdruckreiniger, Leiter, Sonstiges), Zustand (einsatzbereit / defekt / in Reparatur) und einen QR-Code
  (`devices.kind/status/qr_token`, Migration `20261207000001`). **Etiketten** drucken (Inventar → Geräte, markierte oder
  alle: groß 2 × 5 bzw. klein 3 × 8 je A4, Logo, Art, Name, Nr., „Eigentum …“). Etikett zeigt auf `/g/<code>`: mit
  Büro-Anmeldung → Scan-Seite im Büro, sonst Mitarbeiter-App `/m/g/<code>` (Anmeldung, danach zurück; auch über den
  QR-Scanner der App). Aktionen „Gerät ist hier“, „Mitgenommen zu Objekt …“, „Zurück ins Lager“, „Defekt melden“
  (Beschreibung Pflicht, Foto mit der Kamera) – 7 Sprachen. Gespeichert in `app.device_events` (nur anhängen, feste ID je
  Formular): Objekt, Zeitpunkt, Person, Bewertung am Objekt/nicht am Objekt + Entfernung, Koordinaten des Handys beim Scan.
  Defekt → Aufgabe „Gerät defekt: …“ für den Admin; Gerät → „Prüfung / Reparatur erfassen“ (Prüfung mit nächster Prüfung,
  in Reparatur, repariert = einsatzbereit + Aufgabe erledigt, Notiz). Liste mit „zuletzt gescannt“, Filtern **Lange nicht
  gescannt (> 60 Tage oder nie)**, Defekt/Reparatur, Prüfung fällig, Art, Suche; Gerät im Detail mit Standort, Karte
  (Google Maps erst auf Klick), Verlauf. Kachel „Geräte“ in der Verwaltungs-App. Objektleitung: nur Geräte ihrer Objekte,
  scannen/umsetzen nur auf eigene Objekte. **Datenschutz:** Standort nur im Moment des Scans, kein Tracking –
  Mitarbeitende informieren (Art. 13 DSGVO). Stufe 2 (GPS-Tracker) nicht gebaut. Test `device-tracking.db.test.ts`.
- 2026-10-19: **Aufgaben bearbeiten** (Ahmed): in jeder Aufgabenliste (Aufgaben, Kunde/Objekt/Mitarbeiter → Aufgaben) Knopf
  „✎“ → `/aufgaben/<id>/bearbeiten`: Titel, Beschreibung, Fällig am, Zuständig ändern; danach zurück zur Herkunftsseite.
  Startseite: Aufgaben ohne Zuordnung öffnen direkt die Bearbeiten-Seite. Versionsschutz (anderer Tab), alter/neuer Stand
  im Protokoll (`audit_log`, entity `task`). Objektleitung nur ihr zugeordnete bzw. selbst angelegte Aufgaben
  (`updateTask`/`getTask` in `crm.ts`). Test in `phase2.db.test.ts`.
- 2026-10-20: **Rechnungskorrektur separat verrechnen** (Ahmed: „Kunde zieht die Korrektur erst nächsten Monat ab – Überzahlung
  beim Zuordnen“): Kontoumsätze → Kunde → unter den offenen Rechnungen Abschnitt **„Rechnungskorrekturen separat“**:
  Korrekturen, deren Originalrechnung noch offen ist, als eigene Zeile (+Betrag) ankreuzen → Rechnung wird ausgeglichen,
  der Mehrbetrag als **Guthaben aus der Korrektur** festgehalten (`app.correction_credits`, je Korrektur einmal). Beim
  nächsten Zahlungseingang steht das Guthaben als Minuszeile da → mit der Rechnung ankreuzen, von der der Kunde es abzieht;
  es wird zuerst verrechnet (Zahlung „Verrechnung“, `app.correction_credit_uses`, auch auf Rechnungen von vor der
  Umstellung, Migration `20261208000001`). Feste IDs, doppelt absenden bucht nichts doppelt. Logik `assignCustomerPick`
  in `bank.ts`. **DATEV:** der Mehrbetrag ist ein Zahlungseingang auf den Debitor (Beleg = Korrekturnummer); die spätere
  Verrechnung bleibt innerhalb des Debitors und wird nicht gebucht. Test `correction-credits.db.test.ts`.
- 2026-10-20: **Schlüsselübergabeprotokoll (Word) einlesen** (Ahmed: Protokoll Santexis ins Schlüsselbuch, beim Mitarbeiter
  und beim Objekt hinterlegen): Mitarbeiter → Übergaben → „Schlüsselprotokoll (Word) einlesen“ → Prüfen (GET-Vorschau:
  je Zeile Objekt aus „Ort“ über die Objektnummer – „Büro INT-BUERO“, „Wilhelmsgymnasium2010021“ –, Status neu /
  vorhanden / schon ausgegeben / bei jemand anderem / Objekt fehlt) → Übernehmen (`src/services/key-protocol.ts`): je Zeile
  Schlüssel im Schlüsselbuch beim Objekt (Nummer `S-<Objektnr.>-NN`, Beschreibung „Art: Kennung“, Anzahl, Notiz mit
  Protokoll-Nr.), ausgegeben am Übergabedatum des Protokolls; vorhandener gleicher Schlüssel am Objekt wird nur ausgegeben.
  Protokoll (write-once, feste ID aus Mitarbeiter + Inhalt) beim Mitarbeiter (Kategorie „Schlüssel“, zählt als
  Pflichtunterlage) und bei jedem betroffenen Objekt (neue Objekt-Kategorie „Schlüssel“). Personal-Nr. im Protokoll muss
  zum Mitarbeiter passen. Erneut übernehmen legt nichts doppelt an. Objektleitung nur eigene Objekte. Test
  `key-protocol.db.test.ts`. **Ahmed: Protokoll Santexis auf dem Server einmal bei Christos Santexis (1358) hochladen;
  im Protokoll fehlen die Nr. 13 und 14.**
- 2026-10-20: **Schlüsselübergabeprotokoll selbst erstellen** (Ahmed: „aktuelle Liste, Listen immer zwischenspeichern – nicht
  in Dokumente, dort kommen die unterschriebenen“): Mitarbeiter → Übergaben → „Schlüsselübergabeprotokoll erstellen“: aktuelle
  Liste laut Schlüsselbuch (abwählbar), Datum → PDF auf Briefpapier (`src/services/key-protocol-pdf.ts`: Kopf, Tabelle
  Objekt/Art-Kennung/Anzahl/Schlüssel-Nr./seit, Pflichten, Unterschriften, Rückgabe-Teil). Jeder Stand mit Nummer
  SP-JJJJ-NNNN in `app.key_protocols` (Migration `20261209000001`, nur anhängen), PDF write-once **ohne Verknüpfung** –
  nicht unter Dokumente; Liste „Erstellte Protokolle“ mit PDF und „Unterschrieben hochladen“ (→ Dokumente → Schlüssel).
  Gleicher Inhalt + Datum wie der letzte Stand → kein neuer Stand; feste ID je Formular. Objektleitung nur Schlüssel ihrer
  Objekte. Test in `key-protocol.db.test.ts`; `e2e:uebergabe` wartete nach „an Nachunternehmer“ nicht auf den
  Seitenwechsel (gelegentlich rot) – wartet jetzt auf die Adresse.
  - Nachtrag (Ahmed): Unter Übergaben kein „Unterschrieben hochladen“ mehr – dort nur PDF und Stand einsehen (neuester mit
    Schild „aktuell“); die unterschriebene Fassung wird wie bisher unter Dokumente hochgeladen.
- 2026-10-20: **Fund Personalnummer-Vorschlag ab 1.000.000** (Ahmed): Vorschlag war „höchste Ziffern-Nummer + 1“ – eine
  einzelne lange Nummer (vermutlich versehentlich eine 7-stellige Objekt-/Kundennummer als Personalnummer eingetragen)
  zog ihn hoch. Jetzt zählen nur Nummern bis 5 Stellen, vergebene werden übersprungen (`suggestPersonnelNo`). **Ahmed:
  Mitarbeiterliste nach Personalnummer sortieren und die lange Nummer korrigieren** (sonst stimmt sie auch im
  Lexware-Export nicht).
- 2026-10-20: **Word-Vorlagen: Ankreuzen übersichtlicher** (Ahmed, Screenshot Arbeitsvertrag): Kästchen/Lücken stehen in
  Kästen je Abschnitt der Vorlage mit Mini-Überschrift (Dokumenttitel klein, Abschnitt Bordeaux – aus fetten Überschriften
  der Vorlage, `headingsOf`/`group` in `word-form.ts`). **Fund:** Kästchen allein in einer Tabellenzelle bekamen den
  Text der Zeile darüber (Empfangsbestätigung: alles um eine Zeile verschoben, erste Zeile „bäudereinigung GmbH …“) –
  jetzt Text der Zelle rechts daneben. Lange Texte bis 400 Zeichen, am Wortende gekürzt (vorher 160 → „über Wh“).
  Unterschriftslinien werden nicht mehr als Eingabe angeboten. **Fund:** Die Ausfüll-Maske war vom Zwischenspeichern
  ausgenommen – nach „Herunterladen“ und erneutem Öffnen waren gesetzte Häkchen weg; jetzt bleiben sie im Tab erhalten.
- 2026-10-20: **Geschwärzter Stundennachweis zur Rechnung** (Ahmed: „bei manchen Objekten mit der Rechnung übermitteln,
  geschwärzt, am Ende Hinweis Sonderreiniger, unter Leistungen ankreuzen, einfach gehalten“): Leistung am Objekt →
  Häkchen **„Geschwärzten Stundennachweis an die Rechnung anhängen“** (`site_services.attach_timesheet`, Migration
  `20261211000001`; Liste zeigt „mit Stundennachweis“; Importe ändern den Wert nicht). Enthält eine Rechnung eine solche
  Leistung, hängt beim **Fertigstellen** je Objekt ein PDF an (`src/services/redacted-timesheet.ts`, Briefpapier):
  Objekt, Adresse, Zeitraum (Leistungszeitraum der Position bzw. Rechnung), Kunde, Rechnungsnr., Tabelle Datum ·
  Mitarbeiter/in (**schwarzer Balken**, `FormCol.redact`) · Beginn · Ende · Pause · Stunden, Summe; nur erfasste/
  freigegebene Zeiten des Objekts; am Ende der Hinweis, dass Quartals-/Jahresarbeiten von Sonderreinigern mit
  zusätzlichem Personal erledigt werden und nicht enthalten sind. Geht als Anlage mit der Rechnungs-Mail raus. Nichts
  doppelt (gleicher Dateiname); Fehler beim Anhängen halten das Ausstellen nicht auf (Protokoll
  `timesheet_attach_failed`) → an der Rechnung „Stundennachweis als Anlage anhängen“. Entwurf: „Stundennachweis
  (geschwärzt) – Vorschau“. **Hinweis:** Wird im Voraus abgerechnet, sind die Zeiten beim Ausstellen noch nicht erfasst –
  solche Rechnungen erst nach Monatsende fertigstellen. Test `redacted-timesheet.db.test.ts`.
  - Nachtrag (Ahmed): Hinweis ohne Beispiel „Grund- und Glasreinigung“ (damit sind die Quartals-/Jahresarbeiten nicht
    gemeint) – jetzt nur „Quartals- und Jahresarbeiten werden mit zusätzlichem Personal ausgeführt …“. Bereits
    angehängte Stundennachweise bleiben wie archiviert.
- 2026-10-20: **Objekt aktiv/inaktiv stimmte nicht überein** (Ahmed: „unter Objekte nicht zu sehen, beim Kunden als aktiv“):
  Reiter „Objekte (n)“ beim Kunden zählte auch inaktive Objekte (jetzt nur aktive, wie Objektliste und Filter „Aktiv“);
  die Objektseite zeigte den Status nirgends. Jetzt in der Objekt-Übersicht (Seitenkasten) **Status aktiv/inaktiv** und
  Knopf **„Objekt inaktiv setzen“** bzw. „wieder aktiv setzen“ (Büro, Rückfrage, Protokoll wie die Sammelaktion). Objektliste:
  „Markierte aktiv/inaktiv setzen“ fragt mit Anzahl nach; Auswahl-Häkchen werden nicht mehr vom Browser bzw. der
  Eingaben-Sicherung nach Position wiederhergestellt (sonst hätten sie nach einer Listenänderung auf anderen Objekten
  gesessen – Häkchen mit Wert werden jetzt über den Wert zugeordnet).
- 2026-10-20: **Fund Sammelversand „421 4.4.2 Message submission rate … exceeded“** (IONOS Exchange, 13 Rechnungen 1038329–
  1038341): Der Mailserver lehnte beim MAIL FROM ab – die Mails wurden nicht übertragen. Jede Rechnung ging schon immer als
  eigene Mail; zu viele kamen zu schnell hintereinander. Jetzt: Mails nacheinander mit mind. 2,5 s Abstand (≤ 24/Min.), bei
  Rate-Limit 60 s bzw. 120 s warten und denselben Versuch wiederholen (`src/mail/mailer.ts`). Ein fehlgeschlagener Versand,
  der nachweislich vor der Übertragung abgelehnt wurde (`notTransmitted`: MAIL FROM/RCPT TO, Anmeldung, Verbindung), lässt
  sich wieder ohne Rückfrage senden (auch im Sammelversand); nach DATA bleibt es bei „Erneut versenden“ von Hand (sonst
  ggf. doppelt). **Ahmed: die 13 Rechnungen unter Noch nicht versendet einfach noch einmal senden.**
- 2026-10-20: Startseite ohne Karte „Rechnungsentwürfe & Monatslauf“ (Ahmed). **Abwesend:** lückenlose Abwesenheiten gleicher
  Art einer Person (auch über Wochenende/Feiertage) werden als ein Eintrag gezeigt (`mergeAbsent`, nur Anzeige – Startseite,
  Zeiterfassung, App). Überschneidende Abwesenheiten werden beim Anlegen/Ändern schon abgelehnt.
- 2026-10-20: **Fund „Schwärzen: Invalid input: expected boolean, received string“** (Leistung speichern mit Häkchen
  „Geschwärzten Stundennachweis anhängen“): Das Häkchen kam als „on“ an, die Prüfung erwartete true/false. Jetzt wird
  „on“/„1“/„true“ als ja gelesen (`serviceInput.attach_timesheet`).
- 2026-10-20: **Verträge auch beim Kunden** (Ahmed: „Reinigungsvertrag und AÜ-Vertrag beim Objekt und beim Kunden“): Kunde →
  Dokumente → „Reinigungsvertrag erstellen“ / „Arbeitnehmerüberlassungsvertrag erstellen“ (`/kunden/:id/vertrag`): ein
  aktives Objekt → direkt zum Vertrag, mehrere → Objekt wählen (der Vertrag gilt je Objekt). Zusätzlich im Menü „+ Neu“
  bei Kunde und Objekt (`/neu?typ=reinigungsvertrag|aue-vertrag`, Objekt nicht für die Objektleitung). Am Objekt
  weiterhin unter Dokumente.
- 2026-10-20: **Angebotsliste kompakter** (Ahmed: „nicht so breit und lang, unübersichtlich“): 4 statt 7 Spalten (Angebot Nr. +
  Datum + Anlagen · Kunde fett + Leistung einzeilig gekürzt, Vergabe-Nr./Frist nur wenn vorhanden · Netto mit „davon mtl.“ ·
  Status + Schnellknöpfe), Liste max. 1100 px breit, **25 je Seite** mit Seitenzahlen und „1–25 von n“, **Suche** (Nr., Kunde,
  Leistung, Vergabe-Nr., Objekt), Statistik-Tabelle eingeklappt (Zusammenfassung in der Kopfzeile). Am Handy je Angebot
  eine Karte statt seitlich scrollender Tabelle. Gilt auch für die Angebotslisten bei Kunde und Objekt.
- 2026-10-20: Angebotsübersicht im Fortytools-Stil wieder zurückgenommen (Ahmed: „aktuell sieht es gut aus, nicht genau
  gleich wie Fortytools“) – es bleibt die kompakte Liste (Suche, 25 je Seite, Statistik eingeklappt). **Objektleitung
  hat oben dieselbe Suchleiste wie das Büro** (Ahmed: „Maske soll gleich aussehen“): `/suche` für alle Rollen, Treffer
  gefiltert wie bisher (nur eigene Objekte, nur Seiten, die die Rolle öffnen darf – keine Kunden, Rechnungen, Angebote,
  Personalakten); Platzhalter „Objekte, Arbeitsscheine, Aufgaben, Notizen …“. `e2e:rechte` prüft die Treffer.
- 2026-10-20: **NU-Bestellungen Stichtag 30.09.2026** (Ahmed: „alte Bestellungen beenden, damit ich neu bestellen kann“):
  Migration `20261212000001` setzt alle erteilten NU-Bestellungen mit Beginn bis 30.09.2026 auf „beendet“ (Ende
  spätestens 30.09.2026) und storniert NU-Entwürfe, die bis 30.09.2026 angelegt wurden. Bestellungen ab 01.10., Material-
  Bestellungen und alle Rechnungen bleiben unverändert. Alter Stand je Bestellung im Protokoll (`audit_log` action
  `stichtag_30_09`, `status_alt`/`valid_to_alt`) – bei Bedarf rücknehmbar. „Rechnung erwartet“ zählt die beendeten
  Bestellungen weiter bis September (dort ggf. „keine Rechnung …“ bzw. „bereits bezahlt“ vermerken).
- 2026-10-20: **„Rechnung erwartet“ erst ab Oktober 2026** (Ahmed: „kommen die noch?“): Zeiträume bis September 2026 werden
  nicht mehr erwartet (`EXPECTED_FROM = '2026-10'` in `expected-invoices.ts`); in der Abrechnungsverfolgung je Bestellung
  stehen sie als „keine Rechnung – vor der Umstellung (bis 30.09.2026)“ statt „fehlt“. Vorhandene Eingangsrechnungen
  werden weiter als „abgerechnet“ angezeigt.
- 2026-10-20: **Eingangsrechnung: Bestellung zuerst** (Ahmed): Unter „Zuordnung“ steht oben „Bestellung beim Nachunternehmer –
  zuerst wählen“; die Auswahl zeigt nur Bestellungen des gewählten Nachunternehmers (beim Wechsel neu gefiltert), je
  Zeile Bestellnr. · Objekt (Nr.) · Adresse · Leistung · Preis + Abrechnungsart (· beendet). Beim Wählen werden Objekt,
  Kostenart „Nachunternehmer“, Leistungsmonat (sonst Vormonat des Rechnungsdatums) und bei Monatspauschale der Nettobetrag
  übernommen (nur leere Felder). Leistungsmonat als eine Auswahl „Oktober 2026“ (`MonthSelect`, 24 Monate zurück,
  3 voraus) statt Monat/Jahr-Feldern; Material-Bestellungen ebenfalls nach Lieferant gefiltert.
- 2026-10-20: **NU-Bestellung übersichtlicher** (Ahmed: „unübersichtlich, Rechnung erfassen ganz unten, Schlüssel hat dort
  nichts verloren, Leistungen wie unsere Liste, Sammelobjekte oben ein Objekt und unten die Liste“): Erteilte/beendete
  Bestellung zeigt oben einen Kasten (Nachunternehmer, Objekt bzw. „Sammelbestellung · n Objekte“, Leistung + Häufigkeit/
  Abrechnung, Preis, Zeitraum, Status + Unterschrift) mit **„+ Rechnung erfassen“** (öffnet die Eingangsrechnung mit
  Nachunternehmer, Bestellung und offenem Monat vorbelegt), Bestellschein, Unterschreiben lassen, Als erledigt. Danach
  Rechnungsverfolgung, Sammel-Objekte, Stundennachweis, Unterschrift/Preisnachtrag; **„Bestellung bearbeiten“
  eingeklappt** unten. Schlüssel/Kleidung/Einweisung aus der Bestellung entfernt (bleibt beim Nachunternehmer → Übergaben).
  Bei Sammelbestellungen kein einzelnes „Objekt“-Feld mehr, sondern Verweis auf die Objektliste. **Leistung = unsere
  Leistungsarten** (Einstellungen → Leistungsarten), bisheriger Wert bleibt wählbar. Entwürfe unverändert.
- 2026-10-20: **NU-Bestellung aus Anfrage der Objektleitung ohne Preis** (Ahmed: „Preis kann ich nicht mehr hinzufügen“): Die
  Anfrage war ohne Preis erteilt worden; danach war der Preis gesperrt. Jetzt: Erteilen ohne Preis wird abgelehnt (außer
  „Anteil am Umsatz“); bei erteilten Bestellungen mit Preis 0 und ohne Preisnachtrag ist das Preisfeld einmal frei
  (Hinweis „Preis fehlt noch“, Protokoll). Danach wie bisher nur Preisnachtrag ab Monat. Test in `subcontractors.db.test.ts`.
- 2026-10-20: **Übersichten Einkauf aufgeräumt** (Ahmed: Bestellungen, Nachunternehmer, Lieferanten, Rechnungseingang
  „übersichtlicher und sinnvoller“): gemeinsamer Aufbau `ls-tabs` (Reiter mit Anzahl) + `ls-bar` (Filter, Suche,
  „1–25 von n“) + 25 je Seite (`Pager` in `layout.tsx`). Bestellungen: 4 Spalten (Nr. + NU/Material, Firma · Objekt ·
  Zeitraum, Betrag, Status mit Abrechnung darunter), Art als Chips. Nachunternehmer: Ampel als Reiter (Aktiv / Kritisch /
  Läuft ab / Vollständig / Inaktiv) statt Kacheln, Nachweise kurz („2 von 11 Pflicht“, „9 fehlen“ – Liste beim Darüberfahren),
  Fristen-Hinweis zugeklappt; veralteter Satz „keine neuen Aufträge bei Kritisch“ entfernt. Rechnungseingang: Lieferant-
  Filter, Suche (Nr., Firma, Objekt, Bestellung), Spalten Rechnung / Datum · fällig / Kostenart · Objekt / Brutto / Status,
  erledigte neueste zuerst, Kennzahlen kleiner. Erfassungsmaske: Abschnitte Rechnung / Beträge / Zuordnung / Skonto, jede
  Bestellungszeile als Kasten, „Material-Bestellung“ beschriftet, Kostenstellen-Aufteilung zugeklappt (offen, wenn die Summe
  nicht stimmt oder von Hand aufgeteilt).
- 2026-10-20: **Kostenstellen bei mehreren Objekten automatisch** (Ahmed: „kein Objekt bei mehreren Objekten, kann ja automatisch
  passieren“): Eingangsrechnung mit mehreren Bestellungen bzw. einer Sammelbestellung → Feld „Objekt (für Nachkalkulation)“
  wird durch „automatisch – auf die Objekte der Bestellungen verteilt“ ersetzt. `syncAutoAllocation` verteilt jetzt jede
  Zeile: eigene Beträge, sonst der Rest nach Preis der Bestellungen (centgenau), Sammelbestellungen weiter auf ihre Objekte
  (Fläche/Betrag je Objekt/Umsatz). Vorher brauchte es Beträge je Zeile, die genau aufgingen – sonst landete alles auf
  einem bzw. keinem Objekt. Eigene Aufteilung unter „Kostenstellen“ geht weiter vor. Test in `expected-invoices.db.test.ts`.
- 2026-10-20: **NU „je Stunde“: erfasster Betrag statt Maximum** (Ahmed: „da steht die max und nicht die erfasste“): Bestellliste
  und Reiter Bestellungen beim Nachunternehmer zeigen den Betrag der im laufenden Monat erfassten Stunden (Stundennachweis,
  `hoursOfMonth`), darunter „x Std. × Satz · max. …“.
- 2026-10-20: Eingangsrechnung (Ahmed: „da steht Objekt oder Gemeinkosten – wieso ist es da?“): Sobald eine NU-Bestellung
  gewählt ist, verschwinden „Objekt (für Nachkalkulation)“ und „Leistungsmonat“; stattdessen „aus der Bestellung: <Objekt>“
  bzw. „automatisch verteilt“. Server: mehrere Bestellungen am selben Objekt → dieses Objekt, verschiedene → Feld leer
  (Kostenstellen je Zeile); Leistungsmonat leer → frühester Monat der Zeilen. Die Felder gelten nur noch für Rechnungen
  ohne NU-Bestellung (Material, Miete …).
- 2026-10-20: **Bestellungen ohne Unterschrift drucken** (Ahmed): Bestellungen → Hinweis „n erteilte Bestellungen ohne
  unterschriebenen Auftrag“ → Knopf **„Alle drucken (PDF)“** (`/bestellungen/ohne-unterschrift.pdf`, mit Lieferanten-Filter
  nur dessen): alle erteilten NU-Bestellscheine ohne Scan/Handy-Unterschrift in einer PDF, sortiert nach Nachunternehmer
  und Nummer (`unsignedSubcontractsPdf`). Jeder Bestellschein bettet seine Schrift selbst ein (~0,8 MB je Schein).
- 2026-10-20: **NU-Bestellung „je Stunde“ ohne „monatlich“** (Ahmed: „einmalig, aber in der Bestellung wird von monatlich
  gesprochen“, „nur Max. Std., Status entfernen, unbefristet?, Bestelldatum bearbeiten“): Feld heißt „Max. Stunden“, überall
  „max. … Std.“ ohne „/ Monat“ (Formular, Kopfkasten, Stundennachweis, Bestellschein „Angenommene Std.“/„Gesamtbetrag“).
  Bei einmalig/quartalsweise/… zählen Listen die bisher erfassten Stunden insgesamt („erfasst bisher“, `hoursOfMonth`
  mit `totalIds`), die Warnung „über max.“ gilt für die ganze Bestellung; monatlich/wöchentlich weiter je Monat.
  Bestellschein ohne Zeile „Status“; Zeitraum ohne Ende = „ab TT.MM.JJJJ (unbefristet)“ nur bei regelmäßigen
  Bestellungen, sonst „ab TT.MM.JJJJ“ (auch in den Listen statt „offen“). **Bestelldatum** bei erteilten/beendeten
  Bestellungen unter „Bestellung bearbeiten“ änderbar (nicht in der Zukunft, Protokoll, steht auf dem Bestellschein).
  Eingangsrechnung: Objekt/Leistungsmonat sind bei vorhandenen Bestellzeilen schon vom Server ausgeblendet; die Prüfung
  läuft zusätzlich nach dem Laden erneut (Wiederherstellen der Eingaben setzt Werte ohne „change“ – vermutlich der Grund,
  warum die Felder am iPad stehen blieben).

- 2026-10-21: **Briefe unter Verwaltung + Anschrift als ein Textfeld** (Ahmed: „freien Brief unter Verwaltung, im Archiv,
  Objekt/Kunde wählen oder frei“; „überall, wo man die Anschrift ändern kann, ein freies Feld mit Umbruch wie Fortytools“):
  - **Verwaltung → Briefe** (`/verwaltung/briefe`, Büro): Briefarchiv mit Suche und PDF je Brief; „+ Neuer Brief“ an
    Kunde, Objekt (Anschrift vorbelegt, änderbar) oder frei eingegebene Anschrift. Jeder Brief bekommt eine Nummer
    BR-JJJJ-NNNN und steht in `app.letters` (nur anhängen, Migration `20261213000001`); auch die freien Briefe bei Kunde,
    Objekt, Lieferant erscheinen dort. Kunde/Objekt: PDF zusätzlich in der Akte (Schriftverkehr); frei: nur im Archiv.
    Briefe an Mitarbeitende bleiben nur in der Personalakte (keine Nummer, Datenschutz). Feste ID je Formular → nichts doppelt.
  - **Anschrift als ein Textfeld** (`AddressBlock`, `src/web/address-block.tsx`): Rechnungsentwurf („nur für diese
    Rechnung“), Direktbearbeitung im Rechnungsbrief, „Name / Adresse ändern“ (berichtigte Fassung), Einzelauftrag
    „Rechnung an“, Leistung („andere Rechnungsanschrift“), Rechnungsgruppe, Briefe. Eine Zeile im Feld = eine Zeile im
    Brief; gespeichert wird weiter aufgeteilt (`parseAddressBlock`: erste Zeile Name, Zeilen dazwischen Zusatz – auch
    mehrere –, „z. Hd. …“ = Ansprechpartner, vorletzte Straße/Postfach, letzte „PLZ Ort“), weil die E-Rechnung die Teile
    braucht (mehrzeiliger Zusatz → BT-164 mit Komma). Zentral in einer POST-Middleware (`expandAddressBlocks`), alle
    bisherigen Prüfungen bleiben. Angebote haben keine eigene Anschrift (nehmen Kunde/Interessent); Kundenstammdaten
    behalten getrennte Felder (Karte, Suche, Import).
- 2026-10-21: **Eingangsrechnung direkt als bezahlt** (Ahmed: Lastschrift, PayPal …): Beim Erfassen Häkchen „Schon bezahlt“ mit
  Zahlart (Lastschrift, PayPal, Kreditkarte, EC-Karte, bar, Überweisung), Datum, Bemerkung; bei freigegebenen Rechnungen
  aufklappbar „Als bezahlt markieren“. `markPaidDirect` (purchasing.ts): gibt eine noch nicht geprüfte Rechnung dabei frei,
  Zahlbetrag = brutto − Vorschuss, ohne Skonto, doppelt = nichts; erscheint nicht in der Zahlungsliste; „Zahlung
  zurücknehmen“ an der Rechnung (nicht bei Bankzuordnung). Zahlarten `paypal`/`ec_karte` (Migration `20261214000001`).
  **DATEV:** Zahlungsausgang läuft wie bisher über das Bankkonto – PayPal/Kreditkarte buchen Steuerberater meist über ein
  eigenes Verrechnungskonto; mit dem Steuerberater klären.
- 2026-10-21: **Briefe ohne Briefnummer, mit Zeichen** (Ahmed): Im Brief steht keine BR-Nummer mehr (nur intern im Archiv),
  sondern **Unser Zeichen** (vorbelegt mit dem Kürzel des eigenen Namens), **Ihr Zeichen** (optional) und
  **Ansprechpartner** (vorbelegt mit dem eigenen Namen, erscheint auch unter „Mit freundlichen Grüßen“) – alles änderbar,
  in allen Brief-Formularen (Verwaltung → Briefe, Kunde, Objekt, Lieferant, Mitarbeiter). Bei Objekt zusätzlich
  „Objekt … (Nr. …)“ und „Kundennr.“ im Kopf. Spalten `letters.our_ref/your_ref/sender` (Migration `20261214000002`),
  Briefarchiv zeigt „Unser Zeichen · Ansprechpartner“ statt der Nummer, Suche findet sie.
- 2026-10-21: **Rechte der Benutzergruppen selbst einstellen** (Ahmed: „Rechte je Gruppe in den Einstellungen“): Einstellungen →
  Benutzer & Gruppen → **Rechte der Benutzergruppen** (`/einstellungen/rechte`, nur Admin, `routes-permissions.tsx`): Tabelle
  aller Bereiche (Kunden, Objekte, Rechnungen, Offene Posten, Mahnwesen, Einkauf, Personal, Zeit/Planung, Disposition,
  Inventar, Kassenbuch, Briefe, Bank, DATEV, Auswertungen, Einstellungen …) × Buchhaltung / Personal / Objektleitung mit
  Häkchen, vorbelegt mit der bisherigen Vorgabe; Abweichungen fett, „Alles auf Vorgabe zurücksetzen“. Gespeichert nur
  Abweichungen (`app.role_permissions`, Migration `20261214000003`, Protokoll je Änderung), gelten sofort (Menü und Seiten).
  `canAccess` in `permissions.ts`: Bereich = längster passender Adress-Anfang (`PERM_GROUPS`/`areaOf`), Abweichung geht
  vor der Vorgabe. Admin immer alles; nie einstellbar: Benutzer, Firmendaten, Nummernkreise, Bankabruf, E-Mail, System,
  Archiv, Rechte-Seite, Anmelde-/App-Seiten. Einzelne Admin-Knöpfe in Seiten bleiben Admin. **Achtung Objektleitung:** nur
  Objekte/Zeit/Planung/Arbeitsscheine/Schlüssel/Geräte sind auf ihre Objekte begrenzt – in anderen freigegebenen
  Bereichen (Rechnungen, Kunden …) sieht sie alles (Hinweis auf der Seite). **Datenschutz:** Personal-/Gesundheitsdaten
  nur für Gruppen freigeben, die sie für ihre Aufgabe brauchen (Art. 5, 9 DSGVO).
- 2026-10-21: Ahmed (3 Punkte):
  - **Einzelauftrag:** oben am Auftrag Knopf „Weiteren Einzelauftrag anlegen“ (gleicher Kunde).
  - **Unterweisung aus Word-Vorlage:** Kästchen der Teile „für alle“ (Überschrift „Teil A – Gilt für alle“, „Teil B …“)
    sind vorab angekreuzt, „Teil C – Zusatzmodule, nur bei …“ nicht; Kästchen mit Lücke („Besonderheiten: ___“) nicht.
    Gilt auf der Ausfüll-Seite (je Abschnitt „alle ankreuzen · keine“, oben für alle) und beim Verteilen als Unterweisung
    an alle (`word-form.ts`: `part`, `generalPart`; Überschriften „Teil X“/„A1 …“ werden erkannt). **Vorlage
    VD-UW-2026-V6** (nur an Ahmed, nicht im Repo): gleiche Themen gekürzt, je Thema ein Kästchen, 10 pt statt 6,5 pt,
    2 Seiten mit großem Unterschriftsfeld (Werkzeug im Scratchpad). **Ahmed: unter Einstellungen → Word-Vorlagen
    hochladen** (V5 wird ersetzt). Inhalt fachlich wie V5; mit Fachkraft für Arbeitssicherheit abstimmen.
  - **Materialausgabe / interner Lieferschein** (Inventar → Materialausgabe, `/materialausgabe`; auch Objekt → „+ Neu“
    und am Artikel „An Objekt ausgeben“): Objekt, Datum, Artikel + Menge → Nummer MA-JJJJ-NNNN, Bestand abgebucht,
    **EK des Artikels am Ausgabetag eingefroren** (`material_issue_lines`, `stock_movements.unit_cost_cents/booked_on/
    material_issue_id`, Migration `20261215000001`, nur anhängen). Nachkalkulation zählt den Betrag als Material auf die
    Kostenstelle des Objekts im Monat der Ausgabe (vorher: aktueller EK am Buchungszeitpunkt – jetzt auch bei normalen
    Lagerbuchungen eingefroren). Fehlender EK → Fehler; zu wenig Bestand → Fehler oder Häkchen „Fehlbestand als
    Inventurkorrektur zubuchen“. Lieferschein-PDF (mit / ohne Preise, Unterschrift „Empfangen“), Storno mit Grund
    (Gegenbuchung Bestand + Kosten, bleibt sichtbar). Feste ID je Formular. Recht „Materialausgabe“ unter
    Einstellungen → Rechte (Vorgabe Büro/Buchhaltung). Wird dem Kunden nicht berechnet (dafür Rechnung mit „+ Artikel“).
- 2026-10-21: **Stornorechnung/Rechnungskorrektur versenden** (Ahmed): Knopf „Stornorechnung versenden“ bzw.
  „Rechnungskorrektur versenden“ oben im Aktionsblock (vorher nur klein im Versandkasten). Gleicher Weg wie Rechnungen
  (Format laut Rechnungsgruppe, genau einmal, Betreff „Stornorechnung Nr. …“); auch über Rechnungen → Noch nicht
  versendet → Reiter Rechnungskorrekturen.
- 2026-10-21: Unterweisung V7 (Ahmed): Dauer als Lücke „____ Min.“ (später von Hand), Sprache entfernt, Objekt =
  neuer Platzhalter `${Unterweisung.Objekt}` – auf der Ausfüll-Seite Auswahl (Objekte der Person zuerst, alle Objekte,
  „offen lassen“ = Linie zum Nachtragen; bei genau einem Objekt vorbelegt), Datum oben (`${Unterweisung.Datum}`) und
  über den Unterschriften („Ort, Datum“) automatisch heute. **Ahmed: VD-UW-2026-V7 hochladen.**
- 2026-10-21: **Fund BR-27 „Item net price shall NOT be negative“** (Rechnung mit Minus-Preis): E-Rechnung schreibt
  negative Einzelpreise jetzt als positiven Preis mit negativer Menge (Betrag gleich, KoSIT-gültig, Test in
  `runde23-invoice.db.test.ts`). Rechnung danach einfach erneut fertigstellen.
- 2026-10-21: **Storno-/Korrektur-Entwurf als Brief** (Ahmed): gleiche Ansicht wie der Rechnungsentwurf (Anschrift, Balken
  „Stornorechnung (Entwurf)“, „Zu Rechnung … vom …“, Positionen, Summen), aber nicht bearbeitbar (Positionen kommen aus
  der Originalrechnung); Aktionen Fertigstellen, PDF-Vorschau, KoSIT, Löschen, Rechnungsdatum, Anlagen, Versand.
- 2026-10-21: Storno/Korrektur (Ahmed: „nicht mehr −Menge sondern −Preis“): Positionen mit Minus-Menge werden in Briefansicht,
  Detailseite und PDF als positive Menge mit negativem Einzelpreis gezeigt (Betrag gleich). Gespeichert bleibt Minus-Menge;
  in der E-Rechnung bleibt der Preis positiv und die Menge negativ (BR-27 verbietet negative Preise).
- 2026-10-21: **Stellenanzeige kopieren** (Ahmed): An der Stelle (Bewerber & Stellen → Stelle) Knopf „Kopieren“ → Formular
  „Stelle kopieren“ mit allen Angaben vorbelegt (gleicher Titel, Arbeitstage, Aufgaben, Anforderungen …), wird erst
  beim Speichern als neue Stelle (aktiv) angelegt; Abbrechen führt zur Vorlage zurück. Bewerber/Matching werden nicht kopiert.
- 2026-10-21: Telefonnummer auf dem Stellenplakat erschien am iPhone blau (Safari macht Nummern automatisch zu Links). Plakat
  und alle App-Seiten mit `format-detection: telephone=no`, Links auf dem Plakat in Textfarbe. Gewollte Anruf-Knöpfe
  (`tel:`) bleiben.
- 2026-10-21: Stellen (Ahmed): Kopie ohne „(Kopie)“ im Titel. Arbeitstage: Zeile **„Für alle markierten Tage“** (Modus,
  von, bis) – einmal eintragen, gilt für alle angehakten Tage (auch neu angehakte); einzelne Tage nur bei Abweichung ändern.
  **Plakat als Bild am Handy:** Knopf „Als Bild speichern / teilen“ – Bild wird beim Laden vorab erzeugt, am Handy öffnet
  das Teilen-Menü (iPhone „Bild sichern“, WhatsApp …), sonst Großansicht zum Gedrückthalten; am PC wie bisher Download.
- 2026-10-21: Stellen: Beginn als Auswahl „ab sofort / ab Datum …“ (Ahmed: Datumsfeld lässt sich am Handy nicht leeren);
  „ab sofort“ speichert kein Datum (`start_on` leer), Plakat zeigt „Ab sofort“.
- 2026-10-21: **Stellenplakat neu** (Ahmed: „auf eine Seite, mit Logo, schöner, WhatsApp-Knopf“, `src/web/job-poster.ts`): Kopf
  Bordeaux mit großem Logo und „Stellenangebot“ mehrsprachig, Objektart, Kacheln mit Symbolen (Einsatzort, Stunden, Lohn,
  Arbeitszeit, Beginn, Arbeitstage), jetzt auch **Ihre Aufgaben / Was wir erwarten / Was wir bieten** als Häkchen-Listen.
  Unten Kontakt mit grünem Knopf **„Jetzt per WhatsApp bewerben“** (wa.me mit vorbelegtem Text „… Stelle „<Titel>“ in
  <Ort>“) und **QR-Code** dazu (für den Aushang), Nummer groß, E-Mail. Passt der Inhalt nicht auf A4, wird die Schrift
  schrittweise verkleinert statt abgeschnitten (bis 55 %). Druck/PDF und Bild (html2canvas) eine Seite; das WhatsApp-
  Symbol im Knopf ist ein PNG-Hintergrund (html2canvas zeichnete SVG/Bild im Knopf nicht).
- 2026-10-22: Runde 45 (Ahmed):
  - **Mitarbeiter-Übersicht:** Zeile „auf einen Blick“ im Kopf (nur Admin/Personal): Anschrift mit Karte, Geburtsdatum + Alter,
    Telefon/E-Mail, Staatsangehörigkeit (+ Aufenthalt bis, wenn nötig), Krankenkasse; Anschrift auch unter Kontakt.
  - **Glasreinigung:** Termin zeigt statt Mitarbeiter den **Hausmeister + Ansprechpartner des Kunden** (Liste, Druck, CSV);
    Termin bearbeiten zeigt Hausmeister/Ansprechpartner/Besonderheiten des gewählten Objekts. **Filter bleibt erhalten**
    (Cookie `gp_f`, auch nach „Erledigt“/Speichern/Löschen zurück in dieselbe Liste; „Filter zurücksetzen“), Sortierung
    „nach Kunde“ mit Zwischenüberschriften. Fund „immer 2 offen“: Anzeige rechnete mit dem laufenden statt dem Jahr des
    Termins, Teilbereiche wurden nur bei exakt gleichem Text gezählt, Offene Planung zeigte standardmäßig das Folgejahr –
    jetzt Jahr des Termins, Teilbereiche ohne Groß-/Kleinschreibung, Planung startet im laufenden Jahr. **Mehrere
    Teilbereiche je Termin** (Häkchen + frei, gespeichert „Oberlichter, Wintergarten“, zählt für jeden), am Objekt beliebig
    viele Teilbereiche („+ weiteren Teilbereich“). Kunden/Objekte mit **Suche und Filter** (Kunde, aktiv/inaktiv,
    Kostenstelle verknüpft/nicht). **Verknüpfung mit unseren Objekten/Kunden** (`glass_objects.site_id`,
    `glass_customers.customer_id`, Migration `20261216000001`): Auswahl im Objekt bzw. Kunden, Vorschlag über gleiche
    Straße + Hausnummer bzw. Namen (gespeichert erst mit „Speichern“); Glas-Kunde zeigt seine Objekte mit Kostenstelle
    und nächstem Termin. **Sonderwünsche/Besonderheiten** (+ Führungszeugnis/Hebebühne) in CSV, Bestätigungsliste und
    Jahresplaner-Terminübersicht. Häkchen „Erledigt“ im Formular entfernt (Knopf „✓ Erledigt“ bzw. „wieder offen“ bleibt).
    **Bestätigungen änderbar** (Datum/Text, alter Stand im Protokoll).
  - **Urlaub bei Austritt:** Mitarbeiter → Urlaub & Krank → **„Vorschau: Austritt zum <Monatsende>“** (anderer Tag wählbar;
    bei eingetragenem Austritt „Urlaub bis zum Austritt“): Anspruch anteilig, genommen/beantragt bis dahin, Rest (rot bei
    Minus). Urlaub nach dem Austrittstag zählt nicht. **Rechtlich (§ 5 BUrlG):** Austritt in der 1. Jahreshälfte → 1/12 je
    vollem Monat; Austritt ab 01.07. (nach Wartezeit) → mindestens gesetzlicher Mindesturlaub (20 Tage bei 5-Tage-Woche),
    nur der Mehrurlaub wird gekürzt. Zu viel genommener Urlaub kann in der Regel nicht zurückgefordert werden (§ 5 Abs. 3
    BUrlG) → vor Genehmigung prüfen; Rest wird abgegolten (§ 7 Abs. 4 BUrlG).
  - **Glückwünsche per E-Mail** (Einstellungen → Glückwünsche an Mitarbeitende, Standard aus): am Geburtstag (29.02. →
    28.02.) und Jahrestag des Eintritts, im Namen des Teams und der Geschäftsführung, Absender **info@** (einstellbar), ab
    Uhrzeit, Texte mit Platzhaltern, Vorschau, Liste nächste 30 Tage, „keine Glückwünsche“ je Person
    (`employees.no_greetings`), je Person/Anlass/Jahr genau einmal (`app.greeting_sent`, Migration `20261216000002`), Alter
    wird nie genannt. **Ahmed: In IONOS Exchange dem SMTP-Konto (buchhaltung@) „Senden als“ für info@ erlauben**, sonst
    lehnt der Server ab (steht dann unter „Zuletzt gesendet“ als Fehler). **Datenschutz:** Geburtsdatum für Glückwünsche
    = berechtigtes Interesse; Mitarbeitende informieren, Widerspruch beachten.
  - Formularfuß in Rastern (z. B. „Zusätzlicher Urlaub“) ohne graue Fläche, die schräg ins Raster ragte.
  - Tests: neu `greetings-exit.db.test.ts`, `e2e:kasse` 69 Prüfungen.
- 2026-10-22: **Mitarbeiter „nicht angetreten“** (Ahmed): Knopf im Kopf der Mitarbeiter-Übersicht (Admin/Personal, nur bei
  Eintritt ≤ 60 Tage her oder in der Zukunft, Rückfrage). `markNotStarted` (employees.ts): nur ohne erfasste Arbeitszeit
  (sonst „Austritt erfassen“); Austritt = Eintrittstag, Grund „Nicht angetreten“, sofort ausgetreten; laufende/künftige
  Einsätze werden offen („Zu planende Einsätze“), beantragte/genehmigte Abwesenheiten storniert; Protokoll `not_started`
  mit den betroffenen IDs. Rücknahme über „Austritt zurücknehmen“ (Einsätze dann neu zuordnen). **Lohn/SV:** ist die
  Person schon angemeldet, Anmeldung stornieren (DEÜV); eine Vertragsstrafe für Nichtantritt nur, wenn im Vertrag
  vereinbart (Vorlagen V5: höchstens ½ Monatslohn). Test `not-started.db.test.ts`.
- 2026-10-22: **NU-Bestellung: Preis änderbar** (Ahmed: „Preis bei Bestellung bearbeiten können“): Bei erteilten/beendeten
  Bestellungen ist der Preis unter „Bestellung bearbeiten“ wieder frei (vorher gesperrt bis auf einmaliges Nachtragen bei
  0 €). Er gilt als Grundpreis ab Beginn (wirkt auf Abrechnungsverfolgung/Nachkalkulation rückwirkend); spätere
  Preisnachträge ab Monat bleiben bestehen. Alter/neuer Preis im Protokoll, leer/0 = Preis bleibt. Ist die Bestellung
  schon unterschrieben, steht der Hinweis „neu unterschreiben lassen“ da. Test in `subcontractors.db.test.ts`.
- 2026-10-22: **Arbeitsschein ohne Uhrzeit** (Ahmed: „Beginn/Ende löschen“): Felder Beginn/Ende im Arbeitsschein-Editor,
  „Zeit“ im PDF-Kopf, Uhrzeit in Ansicht/Liste/Mitarbeiter-App entfernt; Zeiten nur noch je Stundenzeile (von–bis,
  Pause). Speichern/Kopieren setzt `start_time/end_time` leer, alte Werte werden nirgends mehr gezeigt.
- 2026-10-22: **Vertragsänderung einfach** (Ahmed: „unsere Vertragsänderung ist kompliziert“): Mitarbeiter → Dokumente →
  „Vertragsänderung erstellen“ (`/personal/:id/vertragsaenderung`, Admin/Personal, `src/services/contract-change.ts`):
  Gilt ab (Standard nächster Monatserster), Vertrag vom, je Punkt „bisher“ (aus Stammdaten) und „neu“ (leer =
  unverändert): Wochenstunden, Arbeitstage, Vergütung (Tariflohn/Stundenlohn/Festgehalt), Einsatzort, Tätigkeit,
  weitere Änderung. PDF im Stil „edel“ nur mit den geänderten Punkten (bisher → neu), Anrede, unveränderte Regelungen,
  Hinweis § 3 NachwG, zwei Unterschriften. „In Stammdaten übernehmen“: Stunden/Arbeitstage ab Stichtag (Verlauf),
  Vergütung ab heute sofort bzw. als Aufgabe „Vergütung ändern“ zum Stichtag (Vergütung hat keinen Verlauf; feste ID,
  nichts doppelt). Minijob: Hinweis, wenn Stunden × Lohn × 4,33 über 603 €. Die Word-Vorlage VD-ZV-Nachtrag bleibt
  verfügbar. **Rechtlich:** Gebäudereinigung = § 2a SchwarzArbG → Nachweis der Änderung nicht elektronisch, sondern
  unterschrieben auf Papier, spätestens am Tag der Änderung (§ 3, § 2 Abs. 1 S. 2 NachwG). Test `contract-change.db.test.ts`.
- 2026-10-22: **Vorlagen als Knöpfe, direkt PDF oder Word** (Ahmed: „alle Word-Anlagen und die Vertragsänderung als Button,
  direkt PDF“, „beide Möglichkeiten Word oder PDF“): Mitarbeiter/Kunde/Objekt → Dokumente → Kasten „Vorlage als PDF
  erstellen“ zeigt jede Word-Vorlage als Knopf, gruppiert nach Ablage (`WordTemplateBox`); beim Mitarbeiter oben
  zusätzlich „Vertragsänderung“ (App-eigene Seite; die Word-Vorlage VD-ZV-Nachtrag wird dort nicht mehr angeboten,
  bleibt unter Einstellungen). Ausfüll-Seite: **„PDF erstellen“** (Standard, neuer Tab; `filledDocxPdf` setzt die
  ausgefüllte .docx mit dem Objektordner-Leser `parseDocx/renderDocx` auf das Briefpapier – Bilder/Kopfzeilen aus Word
  entfallen) oder **„Als Word herunterladen“**. Vertragsänderung ebenfalls „PDF erstellen“ / „Als Word herunterladen“
  (`contractChangeDocx`, schlichte .docx mit gleichem Inhalt). Nichts wird in der Akte abgelegt – unterschriebenen Scan
  hochladen.
- 2026-10-22: **Mitarbeiter → Übersicht → Vertraulich** zeigt jetzt alles (Ahmed): Geburtsdatum, Anschrift, Steuer-ID,
  SV-Nummer, Krankenkasse, IBAN (in Vierergruppen) mit Schild „ungültig“ bei falscher Prüfziffer, dazu Geburtsort,
  Familienstand, Staatsangehörigkeit, Aufenthalt. Weiter nur Admin/Personal (RLS unverändert).
- 2026-10-22: **Fahrzeuge: Kauf & Verkauf, TÜV-Erinnerung** (Ahmed): neuer Abschnitt im Fahrzeug „Kauf & Verkauf“ mit
  Kaufdatum, Kaufpreis, „aktiv (im Bestand)“ und Häkchen **„Verkauft“** (Verkauft am, Verkaufspreis, Käufer). Ein
  verkauftes Fahrzeug ist automatisch inaktiv; sein Kennzeichen darf neu erfasst werden. Beträge in Cent („7.500“ =
  7.500 €). Liste mit Filtern Aktive / Inaktiv-verkauft / Alle, darunter Kaufpreis bzw. „verkauft … für …“. Migration
  `20261217000001`. **HU (TÜV):** Erinnerung (Fahrzeugseite, Liste, Erinnerungen + tägliche Mail) **einen Monat vor dem
  HU-Monat** (HU 11/2026 → ab 01.10.2026; `remindFrom`), Inspektion/Leasingende weiter 30 Tage. **Steuerlich:** Wurde beim
  Kauf Vorsteuer gezogen, ist der Verkauf mit 19 % USt zu fakturieren; Anlagenabgang/Buchwert macht der Steuerberater.
- 2026-10-22: **Nach dem Speichern zurück** (Ahmed: „z. B. Auto speichern, dann über das Menü wieder zur Übersicht“):
  - Jede Seite mit Brotkrumen hat oben links einen Knopf **„‹ Zurück zu <Übersicht>“** (letzte Brotkrume, `PageHead`).
  - Neben dem Speichern-Knopf im Formularfuß erscheint automatisch **„Speichern & zurück“** (`client.ts`, nur wenn das
    Formular genau einen Speichern/Anlegen-Knopf hat, nicht in Tabellen; abschaltbar mit `data-noback`). Er hängt
    `?_zurueck=<Übersicht>` an; eine Middleware in `app.tsx` leitet nach erfolgreichem Speichern dorthin (Meldung wandert
    mit), bei Fehlern bleibt das Formular offen. Nur eigene Pfade. Normales „Speichern“ bleibt auf der Seite.
  - **Fahrzeugschein fehlt** als Hinweis auf der Startseite („bei n Fahrzeugen“) und unter Erinnerungen je Fahrzeug
    (aktive Fahrzeuge ohne Datei der Kategorie „Fahrzeugschein“, `vehiclesWithoutRegistration`).
  - **Fahrzeuge: geschätzter Wert + Summen** (Ahmed): Feld „Geschätzter Wert heute“ (`vehicles.estimated_value_cents`,
    Datum der Schätzung `estimated_on` bleibt, solange der Wert gleich bleibt; Migration `20261217000002`; bei Verkauf
    geleert). Fahrzeugliste oben: Fahrzeuge im Bestand, **Kaufpreis gesamt**, **geschätzter Wert gesamt** (je mit „n ohne
    Kaufpreis/Schätzung“), bei Inaktiv/Alle zusätzlich Verkaufserlöse. Schätzung = eigene Angabe, kein Buchwert
    (Abschreibung macht der Steuerberater).
  - Browser-Tests an die Änderungen dieser Woche angepasst (Arbeitsschein ohne Beginn/Ende, Auswertungen mit 4 Menüpunkten
    + Bereichsreitern). `e2e:mahnung` braucht den lokalen Test-Mailserver (Port 1025) – lief hier nicht, kein App-Fehler.
  - Fahrzeuge: Anzahl im Titel „Fahrzeuge (n)“, in den Filtern Aktive (n) / Inaktiv-verkauft (n) / Alle (n) und in der
    Kachel „im Bestand“ (darunter „n insgesamt · n verkauft“). Kacheln zählen immer den ganzen Bestand, egal welcher Filter.
  - **Fahrzeugwert automatisch geschätzt** (Ahmed: „Schätzung nicht automatisch?“): `autoEstimate` – Faustregel aus Kaufpreis,
    Alter ab Erstzulassung (1. Jahr −24 %, danach −12 %/Jahr, mind. 10 %; gebraucht gekauft: Kaufpreis gilt am Kaufdatum) und
    km (±1 % je 5.000 km Abweichung von 20.000 km/Jahr, max. ±15 %), auf 100 € gerundet; nur Eigentum mit Kaufpreis.
    Eigene Schätzung geht vor (`vehicleValue`); Liste „Wert ca. … (automatisch)“, Summe „davon n automatisch geschätzt“,
    im Fahrzeug der Vorschlag unter dem Feld. Keine Marktdaten (DAT/Schwacke kostenpflichtig) – kein Buch- oder Verkaufswert.
- 2026-10-22: **Geräte beim Objekt** (Ahmed: „Gerät hinzufügen – muss beim Objekt unter Übergaben sichtbar sein“): Objekt →
  Übergaben zeigt oben „Geräte an diesem Objekt“ (Standort = Objekt: Name, Nr., Art, Zustand, nächste Prüfung, zuletzt
  gescannt, Link zum Gerät) und „+ Gerät für dieses Objekt anlegen“ (Standort vorbelegt, `?objekt=`). Darunter wie bisher die
  Übergaben an Mitarbeitende. **Zurück überall:** Kopf von Kunde, Objekt und Mitarbeiter hat jetzt auch „‹ Zurück zu
  Kunden/Objekte/Mitarbeiter“ (auf allen Reitern).
- 2026-10-22: **NU-Bestellung „je Tag“ automatisch je Monat** (Ahmed): In der Bestellung bei Abrechnung „je Tag“ Arbeitstage
  ankreuzen (Standard Mo–Fr; `subcontracts.work_days`, Migration `20261218000001`). Betrag je Monat = Preis des Monats
  (mit Preisnachträgen) × Arbeitstage im Gültigkeitszeitraum, **ohne Feiertage (Bayern)** und ohne **Schließzeiten**
  (Kasten „Arbeitstage & Schließzeiten“ an der erteilten Bestellung: von–bis + Grund, entfernen mit Protokoll;
  `app.subcontract_closures`). Kasten zeigt Vormonat bis +2 Monate (Tage, Feiertage, geschlossen, Betrag); Bestellliste und
  Reiter Bestellungen zeigen den laufenden Monat („17 Tage (Mo–Fr) × 100,00 €“); Nachkalkulation schätzt fehlende
  NU-Rechnungen so; Bestellschein nennt Arbeitstage und Abrechnungsweise (`src/services/subcontract-days.ts`).
  Sammelbestellungen „je Tag“ werden noch nicht geschätzt. Test `subcontract-days.test.ts`.
- 2026-10-22: Bestellungen-Liste: NU-Bestellungen mit Beginn in der Zukunft zeigen „beginnt TT.MM.JJJJ“ (vorher kein Schild,
  weil es noch keinen Abrechnungszeitraum gibt – Ahmed: „bei genau den zwei fehlt nach Ausführung“). **Rechnungseingang →
  Bestellung wählen** zeigt nur noch offene Bestellungen: erteilte mit Beginn in der Zukunft oder solche mit einem Zeitraum,
  der weder abgerechnet noch als „keine Rechnung“ vermerkt ist; schon verknüpfte bleiben wählbar.
- 2026-10-22: Bestellungen → Reiter „Laufend“ enthält jetzt auch erteilte NU-Bestellungen ohne unterschriebenen Auftrag
  (Ahmed: „monatlich, erscheint aber nicht unter laufend“) – sie stehen zusätzlich unter „Zu erledigen“, bis die
  Unterschrift (Scan oder Handy) da ist.
- 2026-10-22: Bestellungen-Reiter (Ahmed: „Laufend sollen nur monatliche Sachen sein“): **Laufend (monatlich)** = erteilte
  NU-Bestellungen mit Häufigkeit monatlich/wöchentlich; neuer Reiter **Einmalig / offen** = erteilte einmalige/quartals-/
  halbjährliche/jährliche NU-Bestellungen und bestellte (noch nicht gelieferte) Material-Bestellungen. Ohne Unterschrift
  stehen sie zusätzlich unter „Zu erledigen“.
- 2026-10-22: **Nachkalkulation einfacher** (Ahmed: „von–bis komisch, Monatsauswahl und Knöpfe, Gesamtsummen oben“): Knöpfe
  Dieser Monat / Letzter Monat / laufendes Jahr / Vorjahr + „Zeitraum: …“, Monatsauswahl (schaltet sofort um,
  `select[data-autosubmit]` in `client.ts`, `MonthSelect … autosubmit`) statt von/bis-Feldern (Adressen mit `von`/`bis`
  gehen weiter); Filter Kunde/Objekt/Objektleitung bleiben beim Umschalten erhalten. Zeile **„Gesamt“** steht jetzt oben
  direkt unter den Spaltenköpfen (hell hinterlegt) statt am Ende der Liste.
- 2026-10-22: **Ausschreibungssuche automatisch** (Ahmed: „München + 100 km, Stuttgart + 20 km, alle Leistungen“; registriert
  bei iTWO, TED, Vergabe München, eVergabe, DTVP, Vergabe Bayern): `src/services/tender-feed.ts`, Migration
  `20261219000001`. Quellen: **Bekanntmachungsservice des Bundes** (oeffentlichevergabe.de, Open-Data-Export je
  Veröffentlichungstag als OCDS-ZIP, CC0, ohne Anmeldung – dort laufen die eForms-Bekanntmachungen der Plattformen
  zusammen) und **TED** (Such-API v3, EU-weite). Server prüft stündlich 5–21 Uhr: fehlende Tage (beim ersten Lauf 14 Tage
  zurück) bzw. TED einmal je Tag; erfolgreiche Tage gemerkt (`tender_feed_runs`), Fehler beim nächsten Lauf wiederholt.
  Filter: CPV-Anfang (Standard 9091 alle Reinigungsdienste, 90921 Desinfektion, 90620/90630 Winterdienst, 98341140
  Hausmeister) **oder** Stichwort in Titel/Beschreibung; Ort der Leistung (sonst Auftraggeber) per Nominatim in
  Koordinaten (`app.geo_cache`, je Ort einmal, 1/s), Luftlinie zu den Umkreisen; ohne Ort nur bei NUTS in Bayern/Region
  Stuttgart („Ort prüfen“). Abgelaufene Fristen weg; gleiche Ausschreibung in Bund und TED → „doppelt“ ausgeblendet.
  Eingang **Angebote → Ausschreibungen → „Gefundene Ausschreibungen“** (`/ausschreibungen/eingang`): Frist, Auftraggeber,
  Ort + km, Grund (CPV/Stichwort), Wert, Links Bekanntmachung/Vergabeunterlagen; **Übernehmen** → Ausschreibung mit
  Abgabefrist-Aufgabe (feste ID, Plattform aus dem Link erkannt), **Verwerfen** (einzeln/markiert, zurückholbar),
  „Jetzt abrufen“. Neue Treffer in der täglichen Erinnerungs-Mail. Einstellungen → **Ausschreibungssuche** (CPV,
  Stichwörter, Umkreise, an/aus). **Grenzen:** Hier in der Testumgebung kein Internet → gegen die echten Schnittstellen
  erst auf dem Server geprüft (Format laut Doku/Open-Source-Nutzern, Lesen defensiv). Ausschreibungen, die eine Plattform
  nur selbst veröffentlicht (manche unterschwellige), fehlen → Suchagenten der Plattformen weiter nutzen. Die Homepage
  war hier nicht erreichbar – **Ahmed: CPV/Stichwörter mit den Leistungen der Homepage abgleichen.**
- 2026-10-22: **Ausschreibungssuche wieder entfernt** (Ahmed: „lösch das, läuft zu unsicher“): Seite „Gefundene
  Ausschreibungen“, Einstellung, stündlicher Abruf, Erinnerungs-Zeilen und Code entfernt; Migration `20261219000002`
  löscht die Such-Tabellen (Treffer, Abruf-Protokoll, Einstellungen, Orts-Zwischenspeicher). Bereits übernommene
  Ausschreibungen bleiben unter Ausschreibungen erhalten. Plattformen „iTWO tender“ und „TED“ bleiben in der Auswahl.
- 2026-10-23: **Abgerechnete Arbeitsscheine als erledigt markieren** (Ahmed: „Nicht möglich – AS-2026-0009: Schon
  abgerechnet“): Sperre in `setWorkReportDone` entfernt; Sammelaktion „Markierte als erledigt“ und Knopf „Als erledigt
  markieren“ am Schein gehen jetzt auch, wenn der Schein schon an einer Rechnung (Entwurf oder ausgestellt) hängt.
  Erledigt ist nur ein Vermerk – Rechnung und Verknüpfung bleiben unverändert.
- 2026-10-23: **Kreuze im Arbeitsvertrag** (Ahmed: „Kreuze fehlen“, PDF Bitrus): Geprüft an VD-AV-2026-V5 – die App kreuzte
  bei Kästchen nur Beschäftigungsart/Befristung vor; § 4.1 Schwerbehinderung und Anlage 3 (Schulobjekte ja/nein) blieben
  leer. Neu: Anlage 3 wird aus den Objekten der Person vorbelegt (Zuordnung oder laufender/künftiger Einsatz; ein Objekt
  „Schule“ → „ja“, sonst „nein“; noch kein Objekt → offen). **Fund:** Die freiwilligen Einwilligungen in Anlage 5
  („Teil B – Freiwillige Einwilligungen“) wurden durch die Unterweisungs-Regel „Teil … für alle“ automatisch angekreuzt –
  vorab angekreuzte Einwilligungen sind unwirksam (Art. 7 DSGVO, EuGH C-673/17 Planet49). Jetzt nie vorab, die Person
  kreuzt selbst an. Schwerbehinderung bleibt offen (freiwillige Angabe, die App kennt sie nicht) – auf der Ausfüll-Seite
  ankreuzen oder von Hand. Test in `word-form.test.ts`.
- 2026-10-23: Kreuze im Arbeitsvertrag, Nachtrag (Ahmed: „lieber als X“, „wird immer noch nicht gemacht“, „Anlage 5 soll
  angekreuzt sein“): **Angekreuzt = Kästchen mit X** in allen PDFs aus Word-Vorlagen/Formularen (Inter hat kein ☒ →
  □ mit zwei gezeichneten Linien, `FormDoc.text`; vorher ■). **Fund (vermutet für die Server-Vorlage):** Beim Ankreuzen
  wurde nur der Zustand des Word-Kontrollkästchens gesetzt; das sichtbare Zeichen nur, wenn es allein als Text im
  Kästchen stand – bei „☐ “ mit Leerzeichen oder Word-Symbol (Wingdings F0A8 / MS Gothic 2610) blieb es leer, im PDF wie
  in Word. Jetzt wird das Zeichen in jeder Form mitgezogen; Renderer kennt auch 2610/2612. Lokal (V5) und per
  Browser-Klick geprüft. **Anlage 5 – freiwillige Einwilligungen wieder vorab angekreuzt** (Ahmed). **Rechtlich:** Vorab
  angekreuzte Einwilligungen gelten nicht als wirksame Einwilligung (Art. 4 Nr. 11, Art. 7 DSGVO; EuGH C-673/17
  Planet49) – die Person muss die Kreuze selbst setzen bzw. bestätigen; im Zweifel Weitergabe der Handynummer usw. nicht
  darauf stützen. Test in `word-form.test.ts`.
- 2026-10-23: Kreuze im Arbeitsvertrag, 3. Runde (Ahmed: „es kommen keine Kreuze an – trotz aktualisieren“): Hier mit
  iPad-Simulation (Tippen) und echtem Absenden geprüft – Kreuze kommen an und stehen im PDF. Auf dem Server weiter leer,
  Ursache von hier nicht sichtbar (Server-Vorlage weicht ab: andere Tabellenbreiten). Neu, damit es sich zeigt:
  Kästchen werden auf der **unveränderten** Vorlage gesetzt (vorher nach dem Festschreiben der Datumsfelder – einzige
  Stelle, an der Ausfüll-Seite und Erzeugen unterschiedlich zählen könnten); **Gegenprobe** nach dem Erzeugen: steht ein
  angekreuztes Kästchen nicht im Ergebnis, kommt eine Fehlermeldung mit den betroffenen Kästchen statt eines falschen
  Dokuments; Protokoll `word_template` enthält `boxes_on`/`boxes_lost`; die Ausfüll-Seite zeigt „Zuletzt erstellt … –
  angekreuzt angekommen: …“ (`lastWordFill`). Damit ist sofort klar, ob die Häkchen vom Gerät ankommen.
- 2026-10-23: Kreuze, 4. Runde + Abstand (Ahmed: „nur noch bei Schwerbehinderung fehlt das Kreuz“, „Ort und Datum stehen
  zu nah am Text“): Das PDF aus Word-Vorlagen zeichnet Word-Kontrollkästchen jetzt nach ihrem **Zustand** (`w14:checked`),
  nicht nach dem Zeichen im Kästchen (`parsePara` in `src/pdf/docx-render.ts`). Vermutung: In der Server-Vorlage steht in
  § 4.1 ein anderes Zeichen bzw. Symbol im Kästchen, sodass der Zustand gesetzt war (Gegenprobe ok), das PDF aber das leere
  Zeichen zeigte. Zeilen „Ort, Datum“ / „<Ort>, den …“ bekommen oben rund 18 pt Abstand (etwa eine Leerzeile). Test
  `src/pdf/docx-render.test.ts`. Die Word-Datei („Als Word herunterladen“) zeigt weiter das Zeichen aus der Vorlage.
- 2026-10-23: **Kreuze gerade** (Ahmed: „Kreuze irgendwie schief“): Kästchen in PDFs aus Word-Vorlagen/Formularen werden jetzt
  komplett gezeichnet – Rahmen und „X“ aus derselben Geometrie (`FormDoc.text`), statt ein X über das Schriftzeichen □ zu
  legen. Gleiche Größe/Breite wie vorher, auch leere Kästchen ☐ im selben Strich.
- 2026-10-23: **Unterschriftslinie Arbeitgeber fehlte** (Ahmed): Im PDF aus Word-Vorlagen wurden Zellrahmen (`w:tcBorders`)
  nicht gezeichnet – die Linien über „Stempel und Unterschrift Arbeitgeber“ / „Unterschrift Arbeitnehmer/in“ sind in den
  Vorlagen obere Zellrahmen. Jetzt gezeichnet (oben/unten je Zelle); in Unterschriftszellen dunkelgrau statt des sehr
  hellen D8D5D8, darüber etwas mehr Platz zum Unterschreiben. Die graue Unterschriftsfläche beim Arbeitnehmer bleibt
  wie bisher direkt auf der Linie. Test in `src/pdf/docx-render.test.ts`.
- 2026-10-23: **Plan-Kalkulation (Soll)** (Ahmed: „Kalkulation nach eingeplanten Einsätzen mit automatischer Sozialversicherung
  je Lohnhöhe – Minijob, Midijob, Vollzeit –, voraussichtliche NU-Rechnungen, laufende Leistungen; wie die Nachkalkulation,
  nur mit Plan-Daten“): Auswertungen → Nachkalkulation → Reiter **Plan-Kalkulation (Soll)** (`/auswertungen/plankalkulation`,
  `src/services/plan-costing.ts`, gleiches Recht wie Nachkalkulation). Zeitraum Dieser/Nächster Monat, nächste 3 Monate,
  Jahr, Monatsauswahl bis 15 Monate voraus, Filter Kunde/nur Verlust. Je Objekt: **Erlös** = laufende Leistungen
  (Monatspauschalen; 2-monatlich … jährlich anteilig je Monat), **Lohn** = eingeplante Einsätze (inkl. bezahlter
  Feiertage, ohne Tage mit eingetragener Abwesenheit) × Stundenlohn × (1 + Zuschlag Urlaub/Krankheit 13 %), Festgehalt =
  Monatsgehalt nach Plan-Stunden verteilt, **Arbeitgeberkosten je Person und Monat** nach dem geplanten Entgelt
  (`src/domain/hr/employer-cost.ts`): Minijob (Beschäftigungsart bzw. bis 603 €) 31,17 % Pauschalen; Midijob bis 2.000 €
  mit Übergangsbereich-Formel (§ 20 Abs. 2a SGB IV, F = 28 % ÷ Gesamtbeitrag; AG-Satz sinkt von 28 % auf 21,15 %);
  darüber regulär 21,15 %; Midijob/regulär + Umlagen 2,2 %, alle + Unfallversicherung 2,5 %. Teilzeit/Vollzeit wird nie
  als Minijob gerechnet (Hinweis „Einsätze vollständig geplant?“), Minijob über 603 € wird rot markiert.
  **Nachunternehmer** laut erteilter Bestellung jeden Monat (`subcontractEstimates(..., { plan: true })`, auch wenn schon
  eine Rechnung gebucht ist; „je Stunde“ mit max. Stunden). **Sachkosten** = Ø der letzten 3 abgeschlossenen Monate (Ist).
  Liste „Mitarbeitende im Plan“ mit Entgelt, Einstufung, AG-Kosten und Satz; Sätze unter „So wird gerechnet“ änderbar
  (Admin/Buchhaltung, `app.plan_cost_settings`, Migration `20261220000001`). **Werte 2026 sind Schätzwerte** (Ø-Zusatzbeitrag,
  U1/U2 der Kasse, BG-Beitrag) – jährlich mit dem Steuerberater abgleichen; nicht enthalten: Nacht-/Sonn-/Feiertagszuschläge,
  Einzelleistungen/Regie. Tests `employer-cost.test.ts`, `plan-costing.db.test.ts`.
- 2026-10-23: **Geschäftsführer ohne Zusatzkosten** (Ahmed): Mitarbeitende mit Tag „Geschäftsführer“ (gleiche Erkennung wie
  beim Lohnexport, `isManagingDirector`) werden in der Plan-Kalkulation nur mit Gehalt bzw. Lohn gerechnet – ohne
  Arbeitgeberkosten und ohne Zuschlag Urlaub/Krankheit (Einstufung „Geschäftsführer (ohne Zusatzkosten)“); in der
  Nachkalkulation (Ist) ohne Lohnzuschlag. Test in `plan-costing.db.test.ts`.
- 2026-10-23: Plan-Kalkulation vereinfacht (Ahmed: „nur Lohn + Lohnzuschlag, Material und Nachunternehmer, Urlaubszuschlag
  weg“): kein Zuschlag Urlaub/Krankheit mehr (Lohn = Plan-Stunden × Stundenlohn bzw. Festgehalt), Arbeitgeberkosten nach
  Lohnhöhe bleiben; statt Sachkosten nur noch **Material** (Ø der letzten 3 Monate, ohne Geräte/Sonstiges). Feld „Zuschlag
  Urlaub/Krankheit“ aus den Sätzen entfernt (Spalte `plan_cost_settings.absence_bp` bleibt ungenutzt). Nachkalkulation (Ist)
  unverändert.
- 2026-10-23: **Rechnungskorrektur mit Minus beim Preis, vorbelegt** (Ahmed): „Rechnungskorrektur“ an einer ausgestellten
  Rechnung startet mit allen Positionen des Originals (Leistungsart, Text, Zeitraum, Menge, Einheit) und **negativem
  Einzelpreis** – so entspricht sie zunächst der ganzen Rechnung; nicht betroffene Positionen entfernen, Teilbeträge über
  Menge/Preis anpassen. Positions-Eingaben mit Minus-Preis (auch im Rechnungsentwurf) werden intern wie bisher als
  Minus-Menge mit positivem Preis gespeichert (E-Rechnung BR-27), der Editor zeigt Minus beim Preis. Verknüpfung zur
  Leistung wird in der Korrektur nicht übernommen. Test in `forms.test.ts`.
- 2026-10-23: **NU-Bestellung „je Tag“: Schulferien als Schließzeiten** (Ahmed): Kasten „Arbeitstage & Schließzeiten“ →
  „Schule: alle Schulferien eintragen“ trägt alle bekannten Schulferien Bayern + Buß- und Bettag (ab heute) als
  Schließzeiten ein (`addSchoolClosures`, feste ID je Zeitraum, überlappende übersprungen). Ferientermine liegen bis
  Sommer 2027 vor – danach in `school-holidays.ts` ergänzen und erneut klicken. **Bestellentwurf:** „Auftrag erteilen“
  steht jetzt oben über dem Formular (Änderungen vorher speichern).
- 2026-10-23: **Auswahllisten öffnen immer nach unten** (Ahmed: „mal so, mal so“): fehlt unten Platz, rückt die Seite nach
  oben; nach oben nur ganz unten auf der Seite. **Fund:** Die nach oben geöffnete Liste hatte die Klasse `up`, die in den
  Statistiken „Anstieg = grün“ bedeutet → alle Einträge grün. Jetzt `cbx-up`.
- 2026-10-23: **Sammelbestellung je Objekt „je m²“ oder „Pauschale“** (Ahmed: „auswählen, wie unser Auftrag angelegt ist“,
  „Preise sehen, die wir erhalten“): Kasten „Sammelbestellung“ bei Abrechnung je m² bzw. Pauschale je Monat: je Objekt
  Auswahl Abrechnung (Vorschlag: je m², wenn unsere Leistung am Objekt in m² abgerechnet wird, sonst Pauschale), Preis je m²
  (leer = Preis der Bestellung) bzw. Pauschalbetrag, Kosten NU / Monat, **Unser Erlös / Monat** (laufende Leistungen,
  Zyklen anteilig) mit DB je Objekt und Summe. Spalten `subcontract_sites.mode/rate_cents` (Migration `20261220000002`).
  Kosten der Bestellung = Summe der Objekte (`objectCosts`): Bestellschein (Objektliste mit Preis bzw. „Pauschale“),
  Gesamtbetrag in den Listen (`sammelTotals`), Verteilung der Eingangsrechnung und Schätzung der Nachkalkulation. Alte
  Pauschal-Sammelbestellungen ohne Wahl je Objekt rechnen unverändert. Test `subcontract-sites.test.ts`.
  Rechnungskorrektur-Formular ohne Zwischenspeicher der Eingaben (sonst überschrieben alte Eingaben die Vorbelegung).
- 2026-10-23: **NU-Bestellung aufgeräumt** (Ahmed, 6 Punkte): Oben zwei Kästen – links „Auftrag erteilen“ (Nachweis-Hinweis
  über die ganze Breite, Häkchen „zur Kenntnis genommen“ darunter links, dann eine Knopfreihe Auftrag erteilen ·
  Bestellschein (PDF) · Stornieren), rechts groß **„Unterschrift des Nachunternehmers“** mit „Am Handy / Tablet“ und
  „Auf Papier unterschrieben → Scan hochladen“ nebeneinander; bei erteilten Bestellungen links nur Preisnachtrag
  (eingeklappt). Formular: „Bestellung für“ ein Objekt → nur Feld „Objekt“ (Feld „Weitere Objekte = je eine eigene
  Bestellung“ entfällt); mehrere Objekte → kein Objekt-Feld, Objekte nur in der Liste „Sammelbestellung“ (vor dem ersten
  Speichern einmal Kunde/Objekte aufnehmen, danach nur noch unten). Bei Sammelbestellung je m²/Pauschale kein Preisfeld –
  „Preis netto“ = Summe der Objekte; Erteilen geht mit Preis 0, wenn die Summe der Objekte > 0 ist. „Max. Stunden“ nur bei
  „je Stunde“, „Unsere Marge“ nur bei „Anteil am Umsatz“, Arbeitstage nur bei „je Tag“ (`SC_FORM_JS`).
  **Bestellliste/Reiter Bestellungen:** Sammelbestellungen zeigen Kunde(n) und die ersten Objekte
  („Sammelbestellung (32 Objekte): Stadt Garching · Rathaus, Bauhof, … +29“, `sammelSummaries`).
  **Nachkalkulation nach gelöschter Bestellung:** Die Werte werden bei jedem Aufruf neu gerechnet; beim Zurückblättern zeigte
  der Browser aber die alte Seite aus dem Zwischenspeicher. Auswertungen und Startseite laden beim Zurückkommen jetzt neu.
- 2026-10-23: **Nach- und Plan-Kalkulation: Filter + PDF** (Ahmed): Plan-Kalkulation hat jetzt wie die Nachkalkulation
  Filter Kunde, Objekt, **Objektleitung** (auch „ohne“), nur Verlust. Beide Seiten: **„PDF exportieren“** mit den
  aktuellen Filtern (A4 quer, Logo, Summenzeile, `src/services/costing-pdf.ts`). Häkchen **„ohne Beträge (nur
  Stunden und Marge)“** (Ahmed: „nicht Objekt und Kunde schwärzen, sondern Erlöse und Preise“) → nur Nr., Objekt, Kunde,
  Stunden (Plan/Ist) und Marge in %, keine Erlöse, Kosten, Löhne; Plan-PDF dann ohne Mitarbeiterliste. Ohne Häkchen alle
  Beträge; die Liste „Mitarbeitende im Plan“ nur ohne Filter (nicht je Objekt aufgeteilt).
- 2026-10-23: **Rechnungsverfolgung NU: falsches „abgerechnet“** (Ahmed: alte Bestellung zeigte eine Rechnung der neuen als
  abgerechnet): Eingangsrechnungen ohne Bestellung wurden jeder Bestellung desselben Nachunternehmers am selben Objekt
  zugerechnet. Jetzt nur, wenn im Leistungsmonat genau diese eine Bestellung (erteilt/beendet, gültig) dort läuft; die
  Rechnung steht dann als „(ohne Zuordnung, vermutet)“, mit Knopf „gehört nicht dazu …“ (Vermerk „keine Rechnung“, der
  vor einer vermuteten Rechnung gilt). Fest zugeordnete Rechnungen: Hinweis „in der Eingangsrechnung unter Zuordnung die
  richtige Bestellung wählen“.
- 2026-10-23: **Export immer in der Bildschirm-Sortierung** (Ahmed: „auf jeder Seite“): Klick auf eine Spaltenüberschrift
  hängt `sort`/`dir` jetzt an alle Exporte der Seite – CSV-, PDF- und Excel-Links sowie Export-Formulare (z. B. „PDF
  exportieren“ der Kalkulation). Server: Middleware legt den Wunsch je Anfrage ab (`src/domain/export-sort.ts`,
  AsyncLocalStorage); **Listen-PDFs** (`renderTablePdf`, je Abschnitt) und **Excel** (`writeXlsx`) sortieren nach der
  gleichnamigen Spalte, CSV wie bisher (`csv-sort.ts`, gleiche Vergleichsregeln: Zahl, Betrag, Datum, Uhrzeit, Text).
  Passt keine Spalte, bleibt die Reihenfolge. Nicht betroffen: Belege (Rechnungen, Briefe), Stundenliste (eigene
  Sortierung), DATEV/Lexware (festes Format). Test `export-sort.test.ts`.
  **Bestellschein an Nachunternehmer ohne Kundennamen** (Ahmed): Zeile „Kunde“ bei Sammelbestellungen entfernt; es stehen
  nur Objekt(e) und Adresse darauf. Bereits archivierte/unterschriebene Bestellscheine bleiben unverändert.
- 2026-10-23: **Ausschreibungen „Laufend“ = noch nicht abgegeben** (Ahmed: „sonst verwirrend“): Reiter Laufend zeigt nur
  neu / prüfen / in Bearbeitung (`OPEN` in `tenders.ts`); abgegebene stehen im neuen Reiter **„Abgegeben – Entscheidung
  offen“**, danach Abgeschlossen / Alle. Zähler „Ausschreibungen (n)“ in den Angeboten zählt nur noch nicht abgegebene.
- 2026-10-23: **Eigener Mailzugang für Glückwünsche** (Ahmed: info@ als Absender; „Senden als“ gibt es in den Outlook-
  Optionen nicht, nur in der Exchange-Verwaltung): `.env.live` optional `GREETING_SMTP_USER` / `GREETING_SMTP_PASS`
  (gleicher SMTP-Server) → Glückwünsche melden sich mit info@ an (`createGreetingMailer`), sonst wie bisher mit dem
  Rechnungs-Zugang. Einstellungen → Glückwünsche zeigt, über welchen Zugang gesendet wird.
- 2026-10-23: **Objekt anlegen = Kunde anlegen** (Ahmed: „wenn es dasselbe ist“): Neues Objekt → Auswahl Kunde
  „+ Neuer Kunde mit denselben Angaben wie das Objekt“ → Felder Kundennummer (vorbelegt) und Rechnungs-E-Mail(s); beim
  Speichern entsteht der Kunde mit Bezeichnung und Anschrift des Objekts (Straße, PLZ, Ort dann Pflicht; ZUGFeRD,
  Gruppe „Standard“, `createCustomerForSite`, feste ID aus der Objekt-ID → Doppelklick legt nichts doppelt an),
  Objektnummer leer = Kundennummer + 01. **Rechnungsentwürfe sortierbar** (Auswahl „Sortieren“ + auf-/absteigend):
  Name (Empfänger), Kundennummer, Kostenstelle (kleinste Objektnummer der Rechnung), Objektname, Rechnungsdatum,
  Leistungszeitraum, Betrag netto; gilt zusammen mit dem Monatsfilter.
