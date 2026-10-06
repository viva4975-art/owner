#!/usr/bin/env bash
# Lädt den KoSIT-Validator + XRechnung-Prüfkonfiguration und startet ihn als Daemon (Port 8081).
# Wird lokal (ohne Docker) und in der CI genutzt. Versionen hier zentral pflegen.
set -euo pipefail
VALIDATOR_VERSION=1.6.3
CONFIG_RELEASE=2026-08-31
XRECHNUNG_VERSION=3.0.2
DIR="${KOSIT_DIR:-.kosit}"
PORT="${KOSIT_PORT:-8081}"

mkdir -p "$DIR"
cd "$DIR"
if [ ! -f "validator-$VALIDATOR_VERSION-standalone.jar" ]; then
  curl -fsSL -o "validator-$VALIDATOR_VERSION-standalone.jar" \
    "https://github.com/itplr-kosit/validator/releases/download/v$VALIDATOR_VERSION/validator-$VALIDATOR_VERSION-standalone.jar"
fi
if [ ! -f "config-$CONFIG_RELEASE/scenarios.xml" ]; then
  # Ab 2026 heißen Tags „v<Datum>“ und die Datei „xrechnung-<Version>-validator-configuration-<Datum>.zip“
  curl -fsSL -o config.zip \
    "https://github.com/itplr-kosit/validator-configuration-xrechnung/releases/download/v$CONFIG_RELEASE/xrechnung-${XRECHNUNG_VERSION}-validator-configuration-$CONFIG_RELEASE.zip"
  if command -v unzip >/dev/null; then
    unzip -oq config.zip -d "config-$CONFIG_RELEASE"
  else # z. B. im Docker-Build mit JDK: jar kann ZIP entpacken
    mkdir -p "config-$CONFIG_RELEASE" && (cd "config-$CONFIG_RELEASE" && jar xf ../config.zip)
  fi
  rm config.zip
fi
if [ "${1:-}" = "--download-only" ]; then exit 0; fi
exec java -jar "validator-$VALIDATOR_VERSION-standalone.jar" \
  -s "config-$CONFIG_RELEASE/scenarios.xml" -r "config-$CONFIG_RELEASE" -D -H "${KOSIT_HOST:-127.0.0.1}" -P "$PORT"
