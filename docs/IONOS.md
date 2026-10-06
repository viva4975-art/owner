# Testbetrieb auf einem IONOS-Server – Anleitung

Ergebnis: Die App läuft unter `https://app.viva-deluxe-reinigung.de` (Testbetrieb). Daten liegen in Supabase Frankfurt,
Dateien auf dem Server. Alle Mails gehen nur an die Testadresse. Fortytools und die alte App bleiben unberührt.

**Wichtig:** Nicht das normale IONOS-Webhosting – das kann keine App mit Server. Es braucht einen **VPS** (eigener
Linux-Server). Alle Passwörter und Schlüssel werden nur auf dem Server eingegeben – nie in den Chat.

## Teil A – Vorbereiten (ca. 20 Min., am PC einfacher)

1. **VPS bestellen** (IONOS → Server & Cloud → VPS): Linux **Ubuntu 24.04**, mind. **4 GB RAM**, 2 Kerne, 80 GB,
   Rechenzentrum **Deutschland**. Im Cloud Panel stehen danach **IP-Adresse** und **root-Passwort** (notieren).
   Unter Netzwerk → Firewall-Richtlinien die Ports **22, 80, 443** freigeben.
2. **Adresse einrichten** (IONOS → Domains & SSL → viva-deluxe-reinigung.de → DNS): neuer Eintrag **A**, Hostname
   `app`, Zeigt auf = IP des VPS. Wirksam meist nach wenigen Minuten (bis 1 Std.).
3. **Supabase-Werte bereitlegen** (supabase.com → Projekt in Frankfurt):
   - Project Settings → General → **Project ID**
   - Project Settings → API Keys → **anon public** und **service_role** (geheim)
   - oben **Connect** → **Session pooler** → Adresse kopieren (enthält `[YOUR-PASSWORD]`)
   - **Datenbank-Passwort** (beim Anlegen vergeben; vergessen → Project Settings → Database → Reset password)
4. **GitHub-Schlüssel** (github.com → Profilbild → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate): Repository access „Only select repositories“ → `viva4975-art/owner`;
   Permissions → Repository → **Contents: Read-only**; Ablauf 1 Jahr. Schlüssel kopieren.
5. **Testadresse** für Mails (z. B. deine eigene). Optional Mailzugang (IONOS-Postfach: `smtp.ionos.de`, Port 587,
   Benutzer = Mailadresse). Ohne Mailzugang läuft alles außer Versand.

## Teil B – Installieren (ca. 15 Min.)

1. Am PC verbinden: Windows → „PowerShell“ öffnen, Mac → „Terminal“:
   `ssh root@<IP-des-VPS>` → „yes“ → root-Passwort (unsichtbar beim Tippen).
2. Diese drei Zeilen einzeln einfügen (Rechtsklick = Einfügen); bei „Token:“ den GitHub-Schlüssel einfügen:

   ```bash
   read -rsp "Token: " GH_TOKEN; export GH_TOKEN; echo
   curl -fsSL -H "Authorization: Bearer $GH_TOKEN" -o install.sh https://raw.githubusercontent.com/viva4975-art/owner/claude/new-session-t3lg2s/deploy/install.sh
   bash install.sh
   ```

3. Das Skript fragt nacheinander: Adresse der App, Supabase-Werte, dein Benutzername + Startpasswort, Testadresse,
   Mailzugang (leer = aus), automatische Updates (`j`). Danach baut es die App (5–10 Min.) und meldet
   „Fertig: https://app.viva-deluxe-reinigung.de“.
4. Adresse öffnen, anmelden, **Passwort ändern**, unter Einstellungen → Firma die Daten prüfen, unter
   Einstellungen → Benutzer weitere Konten anlegen.

## Teil C – Danach

- **Änderungen:** Schreib mir, was geändert werden soll. Nach meinem Push spielt der Server die neue Version innerhalb
  von 10 Minuten selbst ein (Seite neu laden). Von Hand: `bash /opt/viva/deploy/update.sh`.
- **Wenn etwas hakt:** `cd /opt/viva/deploy && docker compose logs --tail 50 app` – Ausgabe als Foto/Text schicken
  (prüfen, dass kein Passwort darin steht).
- **Zugangsdaten ändern:** `nano /opt/viva/deploy/.env.live`, danach `bash /opt/viva/deploy/update.sh`.

## Was im Testbetrieb gilt

- Kunden, Objekte, Mitarbeiter usw. können für den echten Start bleiben. **Testrechnungen** (inkl. Nummern) werden vor
  dem Echtbetrieb entfernt und der Nummernkreis auf den Fortytools-Stand gesetzt – bis dahin schreibt Fortytools die
  echten Rechnungen. Vor dem Entfernen wird gefragt.
- Hochgeladene Dateien und Rechnungs-PDFs liegen auf dem Server (Laufwerk `daten`) – **noch kein revisionssicheres
  Archiv** (GoBD, 10 Jahre, Object Lock) und keine Sicherung. Für den Test ok; vor dem Echtbetrieb: IONOS-Backup bzw.
  S3-Speicher mit Object Lock, Supabase Point-in-Time-Recovery.
- **Datenschutz:** Echte Personaldaten → Auftragsverarbeitungsvertrag mit IONOS (Kundencenter → Datenschutz) und mit
  Supabase (Dashboard → Organization → Legal/DPA) abschließen.
