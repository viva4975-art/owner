#!/usr/bin/env bash
# Prüft erzeugte ZUGFeRD-Rechnungen (Rechnung, Storno, Schlussrechnung, Lastschrift) mit veraPDF auf PDF/A-3.
set -euo pipefail
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
npx tsx src/scripts/zugferd-samples.ts "$OUT"
chmod -R a+rX "$OUT"
RESULT="$(docker run --rm -v "$OUT:/data" verapdf/cli:latest --format text /data/rechnung.pdf /data/storno.pdf /data/schluss.pdf /data/lastschrift.pdf)"
echo "$RESULT"
! echo "$RESULT" | grep -q '^FAIL'
