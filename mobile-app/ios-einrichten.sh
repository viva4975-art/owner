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

schritt "UIScene-Lebenszyklus (Pflicht ab iOS-SDK 26)"
# Ohne Scene-Manifest startet die App mit neuem Xcode nicht:
# „UIScene life cycle is required for apps built with this SDK“ (schwarzer Bildschirm).
if ! /usr/libexec/PlistBuddy -c "Print :UIApplicationSceneManifest" "$plist" >/dev/null 2>&1; then
  pb() { /usr/libexec/PlistBuddy -c "$1" "$plist"; }
  k=":UIApplicationSceneManifest"
  pb "Add $k dict"
  pb "Add $k:UIApplicationSupportsMultipleScenes bool false"
  pb "Add $k:UISceneConfigurations dict"
  pb "Add $k:UISceneConfigurations:UIWindowSceneSessionRoleApplication array"
  r="$k:UISceneConfigurations:UIWindowSceneSessionRoleApplication:0"
  pb "Add $r dict"
  pb "Add $r:UISceneConfigurationName string Default"
  pb "Add $r:UISceneDelegateClassName string App.SceneDelegate"
  pb "Add $r:UISceneStoryboardFile string Main"
fi
appdelegate=ios/App/App/AppDelegate.swift
if ! grep -q 'viva-scene-delegate' "$appdelegate"; then
  cat >> "$appdelegate" <<'SWIFT'

// viva-scene-delegate: Fenster je Scene; die Oberfläche (Capacitor) kommt aus Main.storyboard
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
}
SWIFT
fi

schritt "Zurück-Knopf bei PDFs"
# WKWebView zeigt PDFs ganzseitig ohne Zurück → eigener Controller mit Knopf „‹ Zurück“ und Wisch-Geste
sb=ios/App/App/Base.lproj/Main.storyboard
sed -i '' 's/customClass="CAPBridgeViewController" customModule="Capacitor"/customClass="VivaViewController" customModule="App" customModuleProvider="target"/' "$sb"
# Fassung 2: zusätzlich „Teilen“ (Drucken, Sichern, Mail, WhatsApp). Ältere Fassung wird ersetzt.
if grep -q 'viva-pdf-zurueck' "$appdelegate" && ! grep -q 'viva-pdf-zurueck-v2' "$appdelegate"; then
  perl -0pi -e 's/\n*\/\/ viva-pdf-zurueck:.*\z/\n/s' "$appdelegate"
fi
if ! grep -q 'viva-pdf-zurueck-v2' "$appdelegate"; then
  grep -q '^import WebKit' "$appdelegate" || perl -0pi -e 's/^/import WebKit\n/' "$appdelegate"
  cat >> "$appdelegate" <<'SWIFT'

// viva-pdf-zurueck-v2: Bei PDFs oben links „‹ Zurück“, oben rechts „Teilen“ (Drucken, Sichern, Mail …);
// Wischen vom linken Rand geht ebenfalls zurück
class VivaViewController: CAPBridgeViewController {
    private var urlObs: NSKeyValueObservation?
    private var loadObs: NSKeyValueObservation?
    private let backButton = UIButton(type: .system)
    private let shareButton = UIButton(type: .system)

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard let wv = webView else { return }
        wv.allowsBackForwardNavigationGestures = true
        style(backButton, title: "‹ Zurück", action: #selector(goBack))
        style(shareButton, title: "Teilen / Drucken", action: #selector(sharePdf))
        NSLayoutConstraint.activate([
            backButton.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 12),
            backButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            backButton.heightAnchor.constraint(equalToConstant: 44),
            backButton.widthAnchor.constraint(equalToConstant: 120),
            shareButton.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
            shareButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            shareButton.heightAnchor.constraint(equalToConstant: 44),
            shareButton.widthAnchor.constraint(equalToConstant: 170),
        ])
        urlObs = wv.observe(\.url, options: [.new]) { [weak self] _, _ in self?.updateButtons() }
        loadObs = wv.observe(\.isLoading, options: [.new]) { [weak self] _, _ in self?.updateButtons() }
    }

    private func style(_ b: UIButton, title: String, action: Selector) {
        b.setTitle(title, for: .normal)
        b.setTitleColor(.white, for: .normal)
        b.titleLabel?.font = .boldSystemFont(ofSize: 17)
        b.backgroundColor = UIColor(red: 125 / 255, green: 20 / 255, blue: 53 / 255, alpha: 0.95)
        b.layer.cornerRadius = 22
        b.isHidden = true
        b.translatesAutoresizingMaskIntoConstraints = false
        b.addTarget(self, action: action, for: .touchUpInside)
        view.addSubview(b)
    }

    private func setVisible(_ on: Bool) {
        backButton.isHidden = !on
        shareButton.isHidden = !on
        if on {
            view.bringSubviewToFront(backButton)
            view.bringSubviewToFront(shareButton)
        }
    }

    private func updateButtons() {
        guard let wv = webView else { return }
        if wv.url?.path.lowercased().hasSuffix(".pdf") == true {
            setVisible(true)
            return
        }
        setVisible(false)
        if wv.isLoading { return }
        wv.evaluateJavaScript("document.contentType") { [weak self] result, _ in
            if (result as? String) == "application/pdf" { self?.setVisible(true) }
        }
    }

    @objc private func goBack() {
        guard let wv = webView else { return }
        if wv.canGoBack {
            wv.goBack()
        } else if let start = URL(string: "https://app.viva-deluxe-reinigung.de/app") {
            wv.load(URLRequest(url: start))
        }
    }

    // PDF mit der Anmeldung der App laden und über das iOS-Teilen-Menü anbieten
    @objc private func sharePdf() {
        guard let wv = webView, let url = wv.url else { return }
        shareButton.isEnabled = false
        wv.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            var req = URLRequest(url: url)
            let host = url.host ?? ""
            let mine = cookies.filter { c in
                let d = c.domain.hasPrefix(".") ? String(c.domain.dropFirst()) : c.domain
                return host == d || host.hasSuffix("." + d)
            }
            for (k, v) in HTTPCookie.requestHeaderFields(with: mine) { req.setValue(v, forHTTPHeaderField: k) }
            URLSession.shared.dataTask(with: req) { data, resp, _ in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.shareButton.isEnabled = true
                    guard let data = data, !data.isEmpty else { return }
                    var name = resp?.suggestedFilename ?? url.lastPathComponent
                    if name.isEmpty { name = "Dokument" }
                    if !name.lowercased().hasSuffix(".pdf") { name += ".pdf" }
                    let file = FileManager.default.temporaryDirectory.appendingPathComponent(name)
                    do { try data.write(to: file, options: .atomic) } catch { return }
                    let vc = UIActivityViewController(activityItems: [file], applicationActivities: nil)
                    vc.popoverPresentationController?.sourceView = self.shareButton
                    vc.popoverPresentationController?.sourceRect = self.shareButton.bounds
                    self.present(vc, animated: true)
                }
            }.resume()
        }
    }
}
SWIFT
fi

schritt "App-Symbol und Startbild (Viva-Deluxe-Logo)"
cp resources/icon.png ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
for f in splash-2732x2732.png splash-2732x2732-1.png splash-2732x2732-2.png; do
  cp assets/splash.png "ios/App/App/Assets.xcassets/Splash.imageset/$f"
done

schritt "Abgleichen (npx cap sync ios, inkl. pod install)"
npx cap sync ios

gruen "Fertig. Xcode öffnet sich jetzt – weiter mit Schritt 6 der Anleitung (Team wählen, Archive)."
npx cap open ios
