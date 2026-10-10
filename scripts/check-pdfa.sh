#!/usr/bin/env bash
# Prüft erzeugte ZUGFeRD-Rechnungen (Rechnung, Storno, Schlussrechnung, Lastschrift) mit veraPDF auf PDF/A-3.
# Mit Docker: Image verapdf/cli. Ohne Docker: veraPDF-CLI 1.30.3 über Maven (Java + mvn nötig, Cache in ~/.cache/verapdf).
set -euo pipefail
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
npx tsx src/scripts/zugferd-samples.ts "$OUT"
chmod -R a+rX "$OUT"
FILES=(rechnung.pdf storno.pdf schluss.pdf lastschrift.pdf)
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  RESULT="$(docker run --rm -v "$OUT:/data" verapdf/cli:latest --format text "${FILES[@]/#//data/}")"
else
  VERA="${VERAPDF_HOME:-$HOME/.cache/verapdf}"
  if [ ! -d "$VERA/lib" ]; then
    mkdir -p "$VERA"
    cat > "$VERA/pom.xml" <<'POM'
<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>
<groupId>local</groupId><artifactId>vera</artifactId><version>1</version>
<dependencies><dependency><groupId>org.verapdf.apps</groupId><artifactId>cli</artifactId><version>1.30.3</version></dependency></dependencies>
</project>
POM
    (cd "$VERA" && mvn -q -B dependency:copy-dependencies -DoutputDirectory=lib)
  fi
  RESULT="$(java -cp "$VERA/lib/*" org.verapdf.apps.GreenfieldCliWrapper --format text "${FILES[@]/#/$OUT/}")"
fi
echo "$RESULT"
echo "$RESULT" | grep -q '^PASS'
! echo "$RESULT" | grep -q '^FAIL'
