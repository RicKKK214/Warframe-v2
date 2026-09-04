#!/usr/bin/env sh
# Render start script.
#
# The filesystem is ephemeral: the SQLite file does NOT survive a restart or redeploy.
# We therefore (re)create the schema on every boot. This is fast (<1s) and idempotent.
# If it fails for any reason the app still starts — persistence is optional and every
# database call degrades gracefully (see src/lib/db.ts).
set -e

: "${PORT:=3000}"
# Default to the ephemeral /tmp path when DATABASE_URL is not configured. Exporting it
# here matters because the Prisma CLI does NOT read .env the way `next` does, and Render
# services created manually (rather than via render.yaml) may not define it at all.
if [ -z "${DATABASE_URL:-}" ]; then
  echo "[start] FATAL: DATABASE_URL is not set."
  echo "[start] Cached market data needs a persistent PostgreSQL database."
  echo "[start] Create a free one at https://neon.tech and set DATABASE_URL."
  exit 1
fi
export DATABASE_URL

echo "[start] PORT=$PORT"
echo "[start] DATABASE_URL=$(echo "$DATABASE_URL" | sed -E "s#://[^@]*@#://***:***@#")"

# Create the schema on the ephemeral disk. Never fatal.
if npx prisma db push --skip-generate --accept-data-loss; then
  echo "[start] database schema ready"
else
  echo "[start] WARNING: could not initialise database - continuing without persistence"
fi

# Bind 0.0.0.0 so Render's proxy can reach us, on the port Render assigns.
exec npx next start -H 0.0.0.0 -p "$PORT"
