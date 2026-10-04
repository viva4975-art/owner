#!/usr/bin/env bash
# Prüft Migrationen + alle DB-Tests gegen das offizielle Supabase-Postgres-Image (Rollen wie im echten Projekt:
# postgres ohne Superuser, auth.uid() von Supabase). Wegwerf-Container, berührt kein echtes Projekt.
set -euo pipefail
IMAGE="${SUPABASE_PG_IMAGE:-supabase/postgres:15.8.1.085}"
PORT="${SUPABASE_PG_PORT:-54330}"
NAME=viva-supa-check
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=supatest -p "$PORT:5432" "$IMAGE" >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -h localhost >/dev/null 2>&1 && break
  sleep 2
done
sleep 5
TEST_DATABASE_URL="postgres://postgres:supatest@127.0.0.1:$PORT/postgres" npx vitest run
