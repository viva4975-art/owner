# Umzug auf Supabase (Frankfurt) – Schritt für Schritt

Gilt für das **neue** Projekt in Frankfurt (`eu-central-1`). Das alte Projekt `essogronliskkfhocxst` lehnt die App
hart ab (Konfiguration startet nicht).

## 1. Zugangsdaten hinterlegen (nie in den Chat, nie ins Repo)

Im Supabase-Dashboard des neuen Projekts:

| Variable                    | Wo im Dashboard                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_PROJECT_REF`      | Project Settings → General → Reference ID                                                                                   |
| `SUPABASE_URL`              | Project Settings → API → Project URL (`https://<ref>.supabase.co`)                                                          |
| `SUPABASE_REGION`           | `eu-central-1` (muss Frankfurt sein)                                                                                        |
| `SUPABASE_ANON_KEY`         | Project Settings → API → anon public                                                                                        |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → service_role (**nur Server**)                                                                      |
| `DATABASE_URL`              | Connect → Session pooler, Port 5432 (`postgres://postgres.<ref>:<pw>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`) |

Dazu `APP_ENV=test` (erst Testbetrieb) bzw. später `live`, `SESSION_SECRET` (mind. 32 Zeichen, `openssl rand -hex 32`),
`APP_BASIC_AUTH=<erster-admin>:<startpasswort>`, `MAIL_TEST_RECIPIENT` (im Testbetrieb Pflicht), `PUBLIC_URL`,
`KOSIT_VALIDATOR_URL`, SMTP-Zugang (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`).

Wo: in der Cloud-Umgebung (Umgebung bearbeiten → Umgebungsvariablen) bzw. auf dem Server als Umgebungsvariablen
oder `.env.live` (Rechte 600, nie einchecken).

Die App prüft beim Start: Projekt ≠ altes Projekt, Region Frankfurt, `DATABASE_URL` und `SUPABASE_URL` gehören zum
selben Projekt, Pooler-Adresse liegt in `eu-central-1`.

## 2. Datenbank einrichten

```bash
npm run db:migrate:supabase -- --projekt=<ref>
```

Der Projekt-Ref muss zur Bestätigung auf der Kommandozeile stehen. Alle Migrationen sind gegen das offizielle
Supabase-Postgres-Image geprüft (`npm run test:supabase`: Migrationen + alle DB-Tests mit Supabase-Rollen,
`postgres` ohne Superuser, Supabase-`auth.uid()`).

## 3. Erster Start

`npm start` mit den Variablen aus Schritt 1. Beim ersten Start wird der Admin aus `APP_BASIC_AUTH` angelegt (Konto
in Supabase Auth über die Admin-API, Rolle in `app.profiles`). Danach unter „Mein Konto“ das Passwort ändern und
weitere Benutzer unter „Benutzer & Rechte“ anlegen.

## 3a. Server (Testbetrieb) – Docker

`Dockerfile` im Hauptordner: Node-App + KoSIT-Validator in einem Container. Beim Start: KoSIT starten, Migrationen
einspielen (Ziel = `SUPABASE_PROJECT_REF`), App auf Port 3000. Dateien und Archiv unter `/data` → dauerhaftes Laufwerk
einhängen (ohne Laufwerk gehen Uploads/PDFs bei jedem Neustart verloren).

Render (Frankfurt): Dashboard → New → Blueprint → dieses Repo → `render.yaml`. Danach die Variablen mit „sync: false“
im Dashboard eintragen (Supabase-Werte aus Schritt 1, `APP_BASIC_AUTH`, `MAIL_TEST_RECIPIENT`, `PUBLIC_URL` = die
Render-Adresse). `SESSION_SECRET` erzeugt Render selbst. Ohne SMTP-Zugang werden keine Mails verschickt.
Jeder Push auf den Branch spielt automatisch neu ein.

Hinweis Datenschutz: Render ist ein US-Anbieter (Rechenzentrum Frankfurt) → Auftragsverarbeitungsvertrag (DPA) im
Render-Konto abschließen. Alternative mit deutschem Anbieter: Hetzner-Server mit Docker (mehr Einrichtung).

## 4. Vor dem Echtbetrieb (Checkliste)

- [ ] Rechnungsnummer: Startwert auf die nächste freie Fortytools-Nummer setzen, Fortytools danach keine Rechnungen
      mehr schreiben lassen.
- [ ] Fortytools-Import (Transfer → Import aus Fortytools): Kunden → Objekte → Leistungen, Summen abgleichen.
- [ ] Archiv: revisionssicherer Speicher mit Object Lock (S3-kompatibel, EU) statt lokalem Verzeichnis (GoBD).
- [ ] KoSIT-Validator als Dienst neben der App (`scripts/kosit.sh` oder Docker), `KOSIT_VALIDATOR_URL` setzen.
- [ ] SMTP-Zugang + SPF/DKIM für `rechnung@viva-deluxe-reinigung.de`.
- [ ] Datensicherung: Supabase Point-in-Time-Recovery (Pro-Plan) aktivieren.
- [ ] Hosting des Servers in Deutschland/EU (z. B. Frankfurt), HTTPS, `PUBLIC_URL` für QR-Codes.
