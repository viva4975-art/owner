# Viva-Deluxe Betriebs-App

Neue Betriebs-App der Viva-Deluxe Gebäudereinigung GmbH (Ablösung Fortytools).
Projekt-Briefing, Entscheidungen und offene Punkte: [`CLAUDE.md`](CLAUDE.md).

## Start

Voraussetzung: Node.js 22 (`nvm use`).

```bash
npm install
npm run check        # Typecheck + Lint + Format + Tests – muss grün sein
npm test             # nur Tests
npm run test:watch   # Tests im Watch-Modus
```

## Umgebungen (Test / Live getrennt)

| Datei       | Zweck                                                       |
| ----------- | ----------------------------------------------------------- |
| `.env.test` | Test-Betrieb. Mails gehen **nur** an `MAIL_TEST_RECIPIENT`. |
| `.env.live` | Live-Betrieb. Erst nach Abnahme anlegen.                    |

Vorlagen: `.env.test.example`, `.env.live.example`. Echte `.env.*`-Dateien werden nie eingecheckt.

```bash
cp .env.test.example .env.test   # ausfüllen
npm run env:check:test           # prüft die Konfiguration
```

Die Konfiguration wird beim Start geprüft und **verweigert**:

- das alte Supabase-Projekt `essogronliskkfhocxst` (Live-System der alten App),
- jede Region außer `eu-central-1` (Frankfurt),
- Test-Betrieb ohne Mail-Testadresse.

## Aufbau

```
src/
  config/        Umgebungs-Konfiguration (zod-validiert)
  domain/money/  Cent-genaue Beträge (bigint), Rundung, USt-Summen nach EN 16931
docs/            Original-Briefing (PDF)
```

Geldbeträge sind immer ganze Cent als `bigint`. `parseFloat` ist per Lint-Regel verboten.
