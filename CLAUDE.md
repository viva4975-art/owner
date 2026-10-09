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
- [ ] Mail-Zugang (SMTP) für buchhaltung@viva-deluxe-reinigung.de (IONOS Exchange) in `.env.live` eintragen – Anleitung `docs/anleitung-server-eintragen.pdf`
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
- [x] ~~Qwist~~ → Enable Banking (gebaut 08.10.): Schlüssel hochladen + Banken verbinden (Ahmed)
- [ ] Je Behörde klären: nimmt sie XRechnung per E-Mail an oder nur über ein Portal (ZRE/OZG-RE, Peppol)?
- [ ] SEPA-Zahlungslauf: erste pain.001-Datei als Testeinreichung bei der Bank hochladen (Format/Limit prüfen)
- [ ] Je ein echter Kontoauszug (CAMT.053, sonst CSV) von Münchner Bank und Targobank zum Testen des Imports
- [ ] Fortytools-XML-Exporte auf dem Live-Server einspielen (Transfer → Import aus Fortytools); Angebotsstatus-Zuordnung
      bestätigen; danach in Fortytools keine Rechnungen/Angebote mehr schreiben (Nummernkreise)
- [ ] Korrigierte Word-Vorlagen (ZIP „Viva-Deluxe_Vorlagen-Platzhalter“) unter Einstellungen → Word-Vorlagen hochladen

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
