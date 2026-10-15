#!/bin/bash
# iPhone-App (iOS-Projekt) auf dem Mac einrichten bzw. aktualisieren – Viva-Deluxe.
# Aufruf im Terminal, im Ordner mobile-app:   bash ios-einrichten.sh
# Darf mehrfach laufen (z. B. nach einem neuen ZIP-Stand); vorhandenes iOS-Projekt wird nur aktualisiert.
# Anleitung: docs/anleitung-iphone-mac.pdf
set -euo pipefail
cd "$(dirname "$0")"

rot() { printf '\033[31m%s\033[0m\n' "$1"; }
gruen() { printf '\033[32m%s\033[0m\n' "$1"; }
schritt() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

schritt "Prüfe Werkzeuge"
fehlt=0
command -v node >/dev/null || { rot "Node.js fehlt → https://nodejs.org (LTS, „macOS Installer (.pkg)“)"; fehlt=1; }
command -v pod >/dev/null || { rot "CocoaPods fehlt → im Terminal: brew install cocoapods (Anleitung Schritt 3)"; fehlt=1; }
xcodebuild -version >/dev/null 2>&1 || { rot "Xcode fehlt oder ist nicht ausgewählt → Anleitung Schritt 2"; fehlt=1; }
[ "$fehlt" = 0 ] || exit 1
node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 20 ]; then rot "Node.js $node_major ist zu alt – bitte Version 20 oder neuer installieren"; exit 1; fi
gruen "Node $(node -v), $(xcodebuild -version | head -1), CocoaPods $(pod --version)"

schritt "Pakete laden (npm install)"
npm install --no-audit --no-fund

if [ ! -d ios ]; then
  schritt "iOS-Projekt anlegen"
  npx cap add ios
fi

schritt "Einstellungen setzen"
# QR-Scanner (Google ML Kit) braucht mindestens iOS 15.5
sed -i '' "s/platform :ios, '[0-9.]*'/platform :ios, '15.5'/" ios/App/Podfile
sed -i '' 's/IPHONEOS_DEPLOYMENT_TARGET = 1[0-4]\.[0-9]*;/IPHONEOS_DEPLOYMENT_TARGET = 15.5;/' ios/App/App.xcodeproj/project.pbxproj
# Auch alle Pods (Capacitor, Google …) auf 15.5 – sonst meldet neues Xcode
# „IPHONEOS_DEPLOYMENT_TARGET is set to 14.0, but the range …“
if ! grep -q 'viva-deployment-target' ios/App/Podfile; then
  perl -0pi -e "s/(post_install do \|installer\|\n)/\$1  # viva-deployment-target\n  installer.pods_project.targets.each do |t|\n    t.build_configurations.each { |c| c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.5' }\n  end\n/" ios/App/Podfile
  grep -q 'viva-deployment-target' ios/App/Podfile || { rot "Podfile: post_install nicht gefunden – bitte melden"; exit 1; }
fi

plist=ios/App/App/Info.plist
setze() { # Schlüssel Typ Wert
  /usr/libexec/PlistBuddy -c "Set :$1 $3" "$plist" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 $2 $3" "$plist"
}
setze CFBundleDisplayName string "Viva-Deluxe"
setze NSCameraUsageDescription string "Zum Scannen des QR-Codes am Objekt und für Fotos der Qualitätskontrolle."
setze NSLocationWhenInUseUsageDescription string "Nur beim Ein- und Ausstempeln, um zu prüfen, ob du am Objekt bist."
setze NSPhotoLibraryUsageDescription string "Zum Hochladen von Fotos und Dokumenten."
# nur HTTPS (Standardverschlüsselung) → Exportfrage in App Store Connect entfällt
setze ITSAppUsesNonExemptEncryption bool false

schritt "App-Symbol und Startbild (Viva-Deluxe-Logo)"
cp resources/icon.png ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
for f in splash-2732x2732.png splash-2732x2732-1.png splash-2732x2732-2.png; do
  cp assets/splash.png "ios/App/App/Assets.xcassets/Splash.imageset/$f"
done

schritt "Abgleichen (npx cap sync ios, inkl. pod install)"
npx cap sync ios

gruen "Fertig. Xcode öffnet sich jetzt – weiter mit Schritt 6 der Anleitung (Team wählen, Archive)."
npx cap open ios
