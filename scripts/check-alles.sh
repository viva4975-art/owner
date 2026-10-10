#!/usr/bin/env bash
# Gesamtprüfung vor einem größeren Update (Ahmed 10.10.: „Prüfskript regelmäßig laufen lassen“).
# Reihenfolge: Format, Lint, Typen, Unit-/DB-Tests (KoSIT muss laufen), Seiten-Rundgang PC + Handy
# (App muss unter E2E_BASE_URL laufen, Standard http://localhost:3000). Bricht beim ersten Fehler ab.
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s ==\n' "$1"; }
step 'Format (prettier)';      npx prettier --check . >/dev/null
step 'Lint (eslint)';          npx eslint .
step 'Typen (tsc)';            npx tsc --noEmit
step 'Unit-/DB-Tests (vitest)'; npx vitest run --hookTimeout=60000
step 'Seiten-Rundgang';        node e2e/seiten-check.mjs
printf '\nAlles grün. Bericht: var/seiten-check/bericht.json\n'
