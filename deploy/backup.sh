#!/usr/bin/env bash
# Tägliche Sicherung (als root, per cron): Datenbank (pg_dump) + Dateien/Archiv (/data) nach /opt/viva-sicherung.
# Aufbewahrung 14 Tage. Diese Sicherung liegt auf demselben Server – deshalb zusätzlich IONOS Cloud Backup
# (sichert u. a. /opt/viva-sicherung außerhalb des Servers).
set -euo pipefail
ZIEL=/opt/viva-sicherung
mkdir -p "$ZIEL" && chmod 700 "$ZIEL"
T=$(date +%F_%H%M)
cd /opt/viva/deploy
DC=(docker compose --env-file .env.live)
"${DC[@]}" exec -T db pg_dump -U postgres -Fc viva > "$ZIEL/datenbank_$T.dump.tmp"
mv "$ZIEL/datenbank_$T.dump.tmp" "$ZIEL/datenbank_$T.dump"
"${DC[@]}" exec -T app tar czf - -C /data . > "$ZIEL/dateien_$T.tar.gz.tmp"
mv "$ZIEL/dateien_$T.tar.gz.tmp" "$ZIEL/dateien_$T.tar.gz"
find "$ZIEL" -name '*.tmp' -mmin +60 -delete
find "$ZIEL" -maxdepth 1 -type f -mtime +14 -delete
# Statusdatei für den Systemwächter der App (Größe der Datenbank-Sicherung; nur dieser Ordner ist eingebunden)
mkdir -p "$ZIEL/status" && chmod 755 "$ZIEL/status"
stat -c %s "$ZIEL/datenbank_$T.dump" > "$ZIEL/status/letzte-sicherung.txt"
chmod 644 "$ZIEL/status/letzte-sicherung.txt"
# Optional: externer Wächter für die Sicherung (z. B. healthchecks.io) – meldet sich, wenn dieser Ping ausbleibt
PING=$(grep -E '^BACKUP_PING_URL=' .env.live 2>/dev/null | cut -d= -f2- | tr -d "'\"" || true)
if [ -n "$PING" ]; then curl -fsS -m 15 --retry 3 "$PING" >/dev/null || true; fi
echo "$(date '+%F %T') Sicherung ok: $(du -sh "$ZIEL" | cut -f1) gesamt"
