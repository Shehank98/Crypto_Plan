#!/bin/sh
# Boot the combined single-service container: apply DB migrations, start the
# Express API on an internal port, then start Next.js on the public $PORT.
set -e

echo "==> Applying database migrations"
cd /app/backend
npx prisma migrate deploy

echo "==> Seeding coins (idempotent)"
node dist/scripts/seedCoins.js || echo "seed failed (continuing) — you can retry from the UI"

echo "==> Starting API on 127.0.0.1:4000"
API_PORT=4000 node dist/api/server.js &
API_PID=$!

# If the API dies, take the whole container down so Railway restarts it.
trap 'kill "$API_PID" 2>/dev/null' EXIT

echo "==> Starting web on port ${PORT:-3000}"
cd /app/frontend
exec npx next start -p "${PORT:-3000}" -H 0.0.0.0
