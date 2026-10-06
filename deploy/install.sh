#!/usr/bin/env bash
# Erstinstallation auf einem frischen Ubuntu-Server (24.04 oder neuer), als root:
#   printf "Token: "; read -rs GH_TOKEN; export GH_TOKEN; echo
#   curl -fsSL -H "Authorization: Bearer $GH_TOKEN" -o install.sh \
#     https://raw.githubusercontent.com/viva4975-art/owner/claude/new-session-t3lg2s/deploy/install.sh
#   bash install.sh
# Alles auf diesem Server: Datenbank (Postgres), App, KoSIT, HTTPS, tägliche Sicherung.
# Fragt die Zugangsdaten ab und schreibt sie NUR auf diesen Server (/opt/viva/deploy/.env.live, Rechte 600).
# Das Datenbank-Passwort wird zufällig erzeugt.
set -euo pipefail
REPO="viva4975-art/owner"
BRANCH="${BRANCH:-claude/new-session-t3lg2s}"
DIR=/opt/viva

[ "$(id -u)" = 0 ] || { echo "Bitte als root ausführen (sudo -i)."; exit 1; }
say() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
ask() { local v; read -rp "$1: " v; printf '%s' "$v"; }
ask_secret() { local v; read -rsp "$1 (Eingabe unsichtbar): " v; echo >&2; printf '%s' "$v"; }
# Werte in einfachen Anführungszeichen → $ und # in Passwörtern bleiben unverändert
kv() {
  case "$2" in *"'"*) echo "Das Zeichen ' ist in $1 nicht erlaubt – bitte anderes Passwort wählen." >&2; exit 1 ;; esac
  printf "%s='%s'\n" "$1" "$2"
}

say "1/6 System aktualisieren und Docker installieren"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q && apt-get upgrade -yq
apt-get install -yq git curl ufw openssl unattended-upgrades
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

say "2/6 Firewall: nur SSH, HTTP, HTTPS"
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

say "3/6 Programm von GitHub holen"
if [ ! -d "$DIR/.git" ]; then
  GH_TOKEN="${GH_TOKEN:-$(ask_secret "GitHub-Zugangsschlüssel (Token, nur Lesen)")}"
  umask 077
  printf 'https://x-access-token:%s@github.com\n' "$GH_TOKEN" > /root/.git-credentials
  git config --global credential.helper store
  git clone -q --branch "$BRANCH" "https://github.com/$REPO.git" "$DIR"
else
  git -C "$DIR" pull -q
fi

ENVF="$DIR/deploy/.env.live"
if [ -f "$ENVF" ]; then
  say "4/6 Zugangsdaten vorhanden ($ENVF) – übersprungen (zum Neu-Eingeben Datei löschen)"
else
  say "4/6 Zugangsdaten eingeben (bleiben nur auf diesem Server)"
  DOMAIN=$(ask "Adresse der App, z. B. app.viva-deluxe-reinigung.de")
  ADMIN=$(ask "Benutzername für dich (erster Admin), z. B. ahmed")
  while :; do
    PW=$(ask_secret "Startpasswort für $ADMIN (mind. 8 Zeichen)")
    [ ${#PW} -ge 8 ] && break; echo "Zu kurz."
  done
  TESTMAIL=$(ask "Testadresse – ALLE Mails gehen im Testbetrieb nur hierhin")
  SMTPH=$(ask "Mailserver (SMTP), z. B. smtp.ionos.de – leer lassen = Mailversand aus")
  umask 077
  {
    kv APP_ENV "test"
    kv APP_DOMAIN "$DOMAIN"
    kv PUBLIC_URL "https://$DOMAIN"
    DBPW="$(openssl rand -hex 24)"
    kv DB_HOSTING "eigen"
    kv DB_PASSWORD "$DBPW"
    kv DATABASE_URL "postgres://postgres:$DBPW@db:5432/viva"
    kv SESSION_SECRET "$(openssl rand -hex 32)"
    kv APP_BASIC_AUTH "$ADMIN:$PW"
    kv MAIL_TEST_RECIPIENT "$TESTMAIL"
    if [ -n "$SMTPH" ]; then
      kv SMTP_HOST "$SMTPH"
      kv SMTP_PORT "$(ask 'SMTP-Port (meist 587)')"
      kv SMTP_USER "$(ask 'SMTP-Benutzer (meist die Mailadresse)')"
      kv SMTP_PASS "$(ask_secret 'SMTP-Passwort')"
      kv MAIL_FROM "$(ask 'Absender, z. B. Viva-Deluxe Rechnungen <rechnung@viva-deluxe-reinigung.de>')"
    fi
  } > "$ENVF.neu"
  chmod 600 "$ENVF.neu" && mv "$ENVF.neu" "$ENVF"
fi

# tägliche Sicherung 02:30 (Datenbank + Dateien, 14 Tage)
echo '30 2 * * * root /opt/viva/deploy/backup.sh >> /var/log/viva-backup.log 2>&1' > /etc/cron.d/viva-backup

if [ ! -f /etc/cron.d/viva-update ]; then
  AUTO=$(ask "Neue Versionen automatisch einspielen (alle 10 Minuten prüfen)? j/n")
  if [ "$AUTO" != n ]; then
    echo '*/10 * * * * root /opt/viva/deploy/update.sh --wenn-neu >> /var/log/viva-update.log 2>&1' > /etc/cron.d/viva-update
  fi
fi

say "5/6 App bauen und starten (dauert beim ersten Mal 5–10 Minuten)"
cd "$DIR/deploy"
docker compose --env-file .env.live up -d --build

say "6/6 Warten, bis die App läuft"
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q app)" 2>/dev/null)" = healthy ] && break
  sleep 5
done
if [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q app)")" = healthy ]; then
  DOMAIN=$(grep '^APP_DOMAIN=' .env.live | cut -d= -f2)
  say "Fertig: https://$DOMAIN  (Anmeldung mit deinem Admin, danach Passwort ändern)"
else
  echo "App startet nicht. Letzte Meldungen:"; docker compose logs --tail 40 app; exit 1
fi
