#!/usr/bin/env bash
# Start im Container: KoSIT-Validator im Hintergrund, Datenbank-Migrationen, dann die App.
set -euo pipefail
mkdir -p "$ARCHIVE_DIR" "$FILES_DIR"
./scripts/kosit.sh >/tmp/kosit.log 2>&1 &
for _ in $(seq 1 90); do
  curl -fs -o /dev/null "$KOSIT_VALIDATOR_URL/server/health" && break
  sleep 1
done
curl -fs -o /dev/null "$KOSIT_VALIDATOR_URL/server/health" || { echo 'KoSIT startet nicht'; cat /tmp/kosit.log; exit 1; }
if [ -n "${SUPABASE_PROJECT_REF:-}" ]; then
  npx tsx src/scripts/migrate.ts --projekt="$SUPABASE_PROJECT_REF"
else
  npx tsx src/scripts/migrate.ts
fi
# Firmenstamm (Viva-Deluxe GmbH, Bankverbindungen) beim ersten Start anlegen – vorhandene Daten bleiben unverändert
npx tsx src/scripts/seed.ts
exec npx tsx src/server.ts
