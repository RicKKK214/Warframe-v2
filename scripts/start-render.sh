#!/usr/bin/env sh
# Render start script.
#
# DATABASE_URL is OPTIONAL. The database is a CACHE of scanned market data, not a
# source of truth: every query goes through withDb() (src/lib/db.ts) and falls back
# gracefully. Without it the app still runs and scans live Warframe.market data — it
# just re-scans from scratch after each restart instead of restoring instantly.
#
# Set DATABASE_URL to a free Neon PostgreSQL database to make scanned data persist.
set -e

: "${PORT:=3000}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[start] NOTE: DATABASE_URL is not set - running WITHOUT a persistent cache."
  echo "[start] The app works fine, but scanned market data is lost on every restart,"
  echo "[start] so each cold start re-scans from Warframe.market (slower first load)."
  echo "[start] To fix: create a free database at https://neon.tech and add its"
  echo "[start] connection string as DATABASE_URL in the Render dashboard."
  SKIP_DB=1
else
  export DATABASE_URL
  SKIP_DB=0
  echo "[start] DATABASE_URL=$(echo "$DATABASE_URL" | sed -E "s#://[^@]*@#://***:***@#")"
fi

echo "[start] PORT=$PORT"

# Create the schema if a database is configured. Never fatal: a bad or unreachable
# DATABASE_URL must not stop the service from serving live market data.
if [ "$SKIP_DB" = "0" ]; then
  if npx prisma db push --skip-generate --accept-data-loss; then
    echo "[start] database schema ready - scanned data will persist across restarts"
  else
    echo "[start] WARNING: could not initialise the database."
    echo "[start] Continuing without persistence; check that DATABASE_URL is correct"
    echo "[start] and that the database allows connections from Render."
  fi
fi

# Bind 0.0.0.0 so Render's proxy can reach us, on the port Render assigns.
exec npx next start -H 0.0.0.0 -p "$PORT"
