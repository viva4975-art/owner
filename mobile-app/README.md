# Mitarbeiter-App (App Store / Google Play)

Native Hülle mit [Capacitor](https://capacitorjs.com) um die Mitarbeiter-Ansicht `/m`. Die App lädt die Seiten
vom Live-Server (`server.url` in `capacitor.config.json`) – neue Funktionen sind damit sofort in der App, ohne
neues Store-Update. Nativ dazu kommen:

- **QR-Scanner** (`@capacitor-mlkit/barcode-scanning`): Knopf „QR-Code am Objekt scannen“ in `/m` nutzt ihn
  automatisch, sobald die Seite in der App läuft (im Browser: BarcodeDetector bzw. Kamera-App).
- **Push-Benachrichtigungen** (`@capacitor/push-notifications`): vorbereitet, Server-Seite folgt
  (z. B. „Neues Dokument zum Unterschreiben“, „Einsatz geändert“). Braucht Firebase (Android) und einen
  APNs-Schlüssel (Apple).

Ohne Store geht es schon heute: `/m` ist eine installierbare Web-App (Android: „App installieren“, iPhone:
Safari → Teilen → „Zum Home-Bildschirm“).

## Voraussetzungen (einmalig, Ahmed)

|          | Apple App Store                                                | Google Play                                       |
| -------- | -------------------------------------------------------------- | ------------------------------------------------- |
| Konto    | Apple Developer Program als **Organisation**, 99 $/Jahr        | Google Play Console, einmalig 25 $                |
| Nachweis | D-U-N-S-Nummer der GmbH (kostenlos, dauert 1–2 Wochen)         | D-U-N-S-Nummer, Identitätsprüfung                 |
| Werkzeug | Mac mit Xcode                                                  | Android Studio (Windows/Mac/Linux)                |
| Pflicht  | Datenschutzerklärung (URL), Support-URL, Test-Zugang für Apple | Datenschutzerklärung, Angaben zur Datensicherheit |

**Empfehlung für eine reine Mitarbeiter-App:** nicht öffentlich listen.

- Apple: als „Unlisted App“ (nur per Link) oder über Apple Business Manager als „Custom App“.
- Google: „Private App“ über Managed Google Play oder geschlossener Test-Track.

Risiko: Apple lehnt reine „Webseiten-Hüllen“ teils ab (Richtlinie 4.2 Minimum Functionality). Native Funktionen
(Scanner, Push) und eine nicht öffentliche Verteilung senken das Risiko deutlich.

## Bauen

```bash
cd mobile-app
npm install
# Adresse des Live-Servers in capacitor.config.json eintragen (server.url / allowNavigation)
npx cap add ios        # nur auf dem Mac
npx cap add android
npx cap sync
npx cap open ios       # Xcode: Team/Signing wählen, Archive → App Store Connect
npx cap open android   # Android Studio: Build → Generate Signed Bundle (.aab) → Play Console
```

Kamera-Berechtigung eintragen:

- iOS `ios/App/App/Info.plist`: `NSCameraUsageDescription` = „Zum Scannen des QR-Codes am Objekt“.
- Android: wird vom Scanner-Plugin ergänzt.

App-Icons: `assets/web/app-icon-512.png` (Erzeugung: `node scripts/app-icons.mjs`), z. B. mit
`npx @capacitor/assets generate` auf alle Größen bringen.

## Sicherheit

- In der App liegen keine Schlüssel. Anmeldung wie im Browser (Personalnummer + PIN, Sitzungs-Cookie).
- Nur HTTPS; `allowNavigation` beschränkt die App auf unsere Domain.
