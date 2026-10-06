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
find "$ZIEL" -type f -mtime +14 -delete
echo "$(date '+%F %T') Sicherung ok: $(du -sh "$ZIEL" | cut -f1) gesamt"
