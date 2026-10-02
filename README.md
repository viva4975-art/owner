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
npm run dev                       # http://localhost:3000  (Login: siehe APP_BASIC_AUTH in .env.dev)
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
```

Die Tests laufen gegen eine echte Postgres-Datenbank (`viva_test`, wird bei jedem Lauf neu aufgebaut) und
den echten KoSIT-Validator. Sind diese lokal nicht erreichbar, werden die betroffenen Tests übersprungen;
in der CI (`REQUIRE_SERVICES=1`) sind sie Pflicht.

Abgedeckt u. a.: lückenloser Nummernkreis auch bei gleichzeitigem Ausstellen, kein Nummernverbrauch bei
Fehlern, Unveränderbarkeit (Datenbank-Trigger), Storno Cent-genau, einmaliges Stornieren, Abschläge nur
einmal verrechenbar, Monatslauf ohne Dubletten, Versand genau einmal (auch bei dreifachem Klick),
Rechnung/Storno/Abschlag/Schluss als XRechnung und ZUGFeRD KoSIT-gültig, Row Level Security.

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
