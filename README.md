# Viva-Deluxe Betriebs-App

Neue Betriebs-App der Viva-Deluxe Gebäudereinigung GmbH (Ablösung Fortytools).
Projekt-Briefing, Entscheidungen und offene Punkte: [`CLAUDE.md`](CLAUDE.md).

**Stand: Prototyp Ausgangsrechnungen.** Kunden, Objekte mit Leistungen/Preisen, Monatslauf, Einzel-,
Abschlags- und Schlussrechnungen, Storno und Rechnungskorrektur, PDF + XRechnung + ZUGFeRD,
KoSIT-Prüfung, unveränderbares Archiv, E-Mail-Versand (im Test nur an die Testadresse).

## Start (lokal)

Voraussetzungen: Node.js 22 (`nvm use`), Docker.

```bash
npm install
docker compose up -d              # Postgres, KoSIT-Validator, Test-Postfach (Mailpit)
cp .env.dev.example .env.dev
npm run db:migrate                # Schema einspielen
npm run db:seed                   # Firmenstamm + DEMO-Kunden/Objekte
npm run dev                       # http://localhost:3000  (erster Start: Admin = APP_BASIC_AUTH aus .env.dev)
```

Test-Postfach (alle Mails landen hier): http://localhost:8025

Ohne Docker: Postgres selbst bereitstellen und den Validator mit `npm run kosit` starten (braucht Java 21).

## So testest du die Abnahme

1. **Übersicht → Monatslauf** für den Vormonat starten → je Objekt ein Entwurf.
2. Entwurf „Grundschule Musterweg“ öffnen → **PDF-Vorschau** ansehen.
3. **E-Rechnung prüfen (KoSIT)** → muss „bestanden“ melden.
4. **Ausstellen** → erhält Nummer `RE-JJJJ-NNNNN`, ist ab jetzt unveränderbar. Im Archiv liegen PDF,
   XRechnung (UBL), ZUGFeRD (PDF/A-3) und beide KoSIT-Prüfberichte mit SHA-256.
5. **Anlage hinzufügen** (z. B. Leistungsnachweis als PDF).
6. **Per E-Mail versenden** → Mail im Test-Postfach, mit Hinweis auf die eigentlichen Empfänger.
   Ein zweiter Klick versendet nicht erneut.
7. **Stornieren** → Stornorechnung (eigene Nummer, Verweis aufs Original) → ausstellen → versenden.

## Prüfungen

```bash
npm run check        # Typecheck + Lint + Format + alle Tests
npm test             # nur Tests
npm run e2e          # Browser-Test: Zurück/Vor, Eingaben behalten, zwei Tabs (Server muss laufen, legt Testdaten an)
npm run e2e:module   # Browser-Test: Angebot + 300-MB-ZIP mit Abbruch/Fortsetzen, Zuschlag, Mahnwesen, Inventar
npm run e2e:zeit     # Browser-Test: Handy-Zeiterfassung (PIN, QR, Stempeln, Soll bestätigen, Nachtrag, Urlaub) + Büro
npm run e2e:einkauf  # Browser-Test: Bestellung → Wareneingang → Eingangsrechnung → SEPA → DATEV → Nachkalkulation
npm run e2e:rechte   # Browser-Test: Anmeldung, Benutzer anlegen, Objektleitung sieht nur eigene Objekte
npm run e2e:auftrag  # Browser-Test: Auftrag → Arbeitsschein → Unterschrift auf dem Canvas → Rechnung mit Anlage → Regie
npm run e2e:objekt   # Browser-Test: Raumbuch → Stundenvorgabe → Qualitätskontrolle mit Unterschrift → Zählerstände
npm run e2e:app      # Browser-Test: Manifest/Service Worker, Dokument verteilen → am Handy unterschreiben → Nachweis
npm run e2e:leistungen # Browser-Test: Leistung (quartalsweise, eigene Rechnung, unfertig) → am Objekt abrechnen → geprüft
npm run e2e:mahnung   # Browser-Test: Mahnwesen-Stapelverarbeitung (braucht überfällige Rechnungen in der DB)
npm run e2e:personal # Browser-Test: Lohnstufe, Stammdaten mit Tags/Warnhinweis, Dokument aus Vorlage, Serienbrief, Kalender
npm run e2e:planung  # Browser-Test: Monatstafel, Einsatz für einen Tag umplanen und zurücksetzen, Vertretungsliste
npm run e2e:auswertung # Browser-Test: alle Auswertungen, Reiter, CSV-Exporte
npm run e2e:angebot  # Browser-Test: Alternativposition, Statistik, zuletzt bearbeitete Kunden, Folgeangebot
npm run e2e:transfer # Browser-Test: Kontoauszug einlesen/zuordnen, Lastschrift-Einstellungen, Dokumenteneingang, Versand
npm run e2e:sonderdienst # Browser-Test: Sonderdienst anlegen, Termin, Aushang, erledigt → Arbeitsschein, Rechnung
```

### Klick-Demo bauen (eine HTML-Datei zum Durchklicken, offline)

```bash
createdb viva_demo                                   # eigene Demo-Datenbank, nie die echte
# .env.demo = Kopie von .env.dev mit DATABASE_URL=…/viva_demo, PORT=3001, ARCHIVE_DIR/FILES_DIR=./var/demo-…
npx tsx --env-file=.env.demo src/scripts/migrate.ts
npx tsx --env-file=.env.demo src/scripts/seed.ts --demo
npx tsx --env-file=.env.demo src/scripts/demo-data.ts  # Rechnungen, Storno, Mahnung, Personal, Zeiten, Einkauf, Benutzer (nur DB-Name *demo*)
npx tsx --env-file=.env.demo src/server.ts &          # Demo-Instanz auf Port 3001
node e2e/klick-demo.mjs                               # → var/klick-demo/viva-deluxe-klick-demo.html
# Handy-Ansicht in der Demo: Personalnummer 1001 / PIN 4821 (nur Demo-Daten)
```

Die Datei enthält alle Seiten mit Beispieldaten; Speichern, Versenden und Hochladen zeigen nur einen Hinweis.

Die Tests laufen gegen eine echte Postgres-Datenbank (`viva_test`, wird bei jedem Lauf neu aufgebaut) und
den echten KoSIT-Validator. Sind diese lokal nicht erreichbar, werden die betroffenen Tests übersprungen;
in der CI (`REQUIRE_SERVICES=1`) sind sie Pflicht.

Abgedeckt u. a.: lückenloser Nummernkreis auch bei gleichzeitigem Ausstellen, kein Nummernverbrauch bei
Fehlern, Unveränderbarkeit (Datenbank-Trigger), Storno Cent-genau, einmaliges Stornieren, Abschläge nur
einmal verrechenbar, Monatslauf ohne Dubletten, Versand genau einmal (auch bei dreifachem Klick),
Rechnung/Storno/Abschlag/Schluss als XRechnung und ZUGFeRD KoSIT-gültig, Row Level Security.

## Module (Stand Prototyp)

| Bereich      | Was geht                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Angebote     | Anlegen mit Positionen (einmalig / monatlich), Vergabe-Nr., Plattform, Abgabefrist (Ampel auf Startseite), PDF auf Briefpapier, Status Entwurf → abgegeben → Zuschlag/Absage, Kopieren, Folgeangebot (ersetzt das vorige), Alternativpositionen (nicht in der Summe), Statistik 12 Monate, zuletzt bearbeitete Kunden, bei Zuschlag Übernahme als Monatspauschalen ins Objekt oder als Rechnungsentwurf. Ausschreibungsunterlagen (ZIP) hochladen. |
| Dateien      | Upload in 8-MB-Stücken, 4 parallel, Wiederholung bei Abbruch, Fortsetzen nach Neuladen (gleiche Datei erneut wählen), SHA-256-Prüfsumme, danach unveränderbar. Grenze `UPLOAD_MAX_BYTES` (Standard 5 GB), Ablage in `FILES_DIR`. Rechnungsanlagen max. 20 MB (gehen per Mail mit).                                                                                                                                                                 |
| Mahnwesen    | Vorschläge aus überfälligen offenen Posten, 3 Stufen mit Fristen/Gebühren/Texten (einstellbar), Mahnsperre je Kunde, PDF mit GiroCode, Archiv, Versand genau einmal.                                                                                                                                                                                                                                                                               |
| Lieferanten  | Lieferanten und Nachunternehmer, Ablauf Freistellungsbescheinigung § 48b / Unbedenklichkeit mit Ampel, Nachweise als Dateien.                                                                                                                                                                                                                                                                                                                      |
| Inventar     | Artikel mit Bestand und Nachbestellliste, Buchungen (Zugang/Abgang/Inventur) unveränderbar; Geräte mit Prüfterminen (DGUV V3); Schlüsselbuch mit Ausgabe-/Rückgabeprotokoll.                                                                                                                                                                                                                                                                       |
| Planung      | Wochenplan, Monatstafel je Mitarbeiter (Filter Einsatzgruppe), je Einsatz und Tag: Ausfall, Vertretung oder Umplanung (Zeit/Mitarbeiter) – die wiederkehrende Planung bleibt; Liste „Einsätze für abwesende Mitarbeiter“ mit Vorschlägen (Objekt-Mitarbeitende zuerst, belegte gesperrt).                                                                                                                                                          |
| Auswertungen | Rechnungs-Statistik (je Monat, Kunden, Zahlungsdauer), Netto-Umsatz, Umsatz-Vorschau 12 Monate aus den Leistungen, Nachkalkulation, Ø Stundensätze je Objekt, Stundenkontrolle Soll/Plan/Ist (CSV), Urlaubskonten, Krankheitstage, Dienste-Liste (CSV/Druck).                                                                                                                                                                                      |
| Kunden       | zusätzlich Status Interessent, Reiter Angebote / Mahnungen / Dokumente.                                                                                                                                                                                                                                                                                                                                                                            |

## Anmeldung und Rollen

- Erster Start: Es gibt noch keine Benutzer → Admin wird aus `APP_BASIC_AUTH` angelegt (`benutzer:passwort`).
  Danach unter „Mein Konto“ ein eigenes Passwort setzen und unter „Benutzer & Rechte“ weitere Konten anlegen
  (Einmal-Passwort, muss bei der ersten Anmeldung geändert werden).
- Sitzung 12 Stunden (Cookie, HttpOnly). Basic Auth mit denselben Zugangsdaten funktioniert für Skripte/Tests.
- `SESSION_SECRET` (mind. 32 Zeichen) ist außerhalb von dev Pflicht – signiert Büro- und Handy-Sitzungen.
- Beim Umzug auf Supabase übernimmt Supabase Auth die Anmeldung; Rollen (`app.profiles`) und Objekt-Zuordnung
  (`sites.manager_user_id`) bleiben.

## Bedienung: Zurück/Vor und mehrere Tabs

- Jede Seite hat eine eigene Adresse; Zurück/Vor im Browser funktioniert überall, auch mitten in einer Bearbeitung.
- Formulare sichern Eingaben laufend im Speicher des jeweiligen Tabs. Wer die Seite verlässt (Menü, Zurück, Fehler beim
  Speichern) und zurückkommt, findet seine Eingaben wieder – mit Hinweis und „Verwerfen“.
- Zwei Tabs stören sich nicht. Bearbeiten beide denselben Datensatz, gewinnt nicht still der Letzte: der zweite bekommt
  die Meldung „zwischenzeitlich geändert“ und kann seine Eingaben übernehmen.
- Nach jedem Speichern leitet der Server auf eine normale Seite um – „Neu laden“ oder „Zurück“ schickt nichts doppelt.

## Umgebungen

| `APP_ENV` | Datenbank                         | Mailversand                         |
| --------- | --------------------------------- | ----------------------------------- |
| `dev`     | nur lokal (localhost)             | nur an `MAIL_TEST_RECIPIENT`        |
| `test`    | Supabase-Testprojekt (Frankfurt)  | nur an `MAIL_TEST_RECIPIENT`        |
| `live`    | Supabase-Live-Projekt (Frankfurt) | an die Rechnungs-E-Mails der Kunden |

Die Konfiguration wird beim Start geprüft und **verweigert** das alte Supabase-Projekt
`essogronliskkfhocxst`, jede Region außer `eu-central-1` und Test-/Dev-Betrieb ohne Testadresse.
Echte `.env.*`-Dateien werden nie eingecheckt; Vorlagen: `.env.*.example`.

## Aufbau

```
supabase/migrations/   SQL-Schema (läuft 1:1 auf Supabase), RLS, Nummernkreis, Unveränderbarkeit
supabase/local/        Supabase-Nachbau (Rollen, auth.uid) für reines Postgres – nur lokal/Tests
src/config/            Umgebungs-Konfiguration (zod-validiert, Schutz vor Live-System)
src/domain/            Reine Fachlogik: Cent-Beträge, Summen (EN 16931), Storno, Monatslauf
src/einvoice/          XRechnung (UBL), CII, ZUGFeRD via @e-invoice-eu/core; KoSIT-Anbindung
src/pdf/               Rechnungs-PDF (DIN 5008, eingebettete Schrift für PDF/A)
src/archive/           Write-once-Archiv mit SHA-256
src/mail/              SMTP-Versand, Umleitung auf Testadresse
src/services/          Abläufe mit Datenbank: Stammdaten, Entwürfe, Ausstellen, Belege, Versand
src/web/               Oberfläche (serverseitig gerendert, Hono) – keine Schlüssel im Browser
scripts/kosit.sh       KoSIT-Validator + XRechnung-Konfiguration laden und starten
```

Grundsätze: Beträge immer als ganze Cent (`bigint`), Mengen in Tausendsteln; Geschäftslogik nur auf dem
Server; jede Datenbankverbindung mit Zeitlimit; Schreibvorgänge idempotent (feste IDs, Upsert,
eindeutige Schlüssel); Datum immer in deutscher Zeit (Europe/Berlin).
