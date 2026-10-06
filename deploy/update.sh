#!/usr/bin/env bash
# Neue Version einspielen (als root): bash /opt/viva/deploy/update.sh
# Mit --wenn-neu (für den automatischen Lauf): nur, wenn es auf GitHub etwas Neues gibt.
set -euo pipefail
cd /opt/viva
exec 9>/run/viva-update.lock
flock -n 9 || exit 0
git fetch -q origin
if [ "${1:-}" = "--wenn-neu" ] && [ "$(git rev-parse HEAD)" = "$(git rev-parse '@{u}')" ]; then
  exit 0
fi
git merge -q --ff-only '@{u}'
cd deploy
docker compose --env-file .env.live up -d --build
docker image prune -f >/dev/null
echo "$(date '+%F %T') aktualisiert auf $(git -C /opt/viva log -1 --format='%h %s')"
