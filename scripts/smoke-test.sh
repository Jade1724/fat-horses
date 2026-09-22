#!/usr/bin/env bash
# After a deploy: the site loads, and the API refuses a request without a key.
set -euo pipefail
URL="${1:?usage: $0 <url>}"
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$URL/")" && [ "$code" = 200 ] && break
  sleep 10
done
[ "$code" = 200 ] || { echo "smoke test: $URL/ returned $code" >&2; exit 1; }
api="$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/history")"
if [ "$api" = 503 ]; then
  echo "smoke test: site OK; the API has no keys yet. Run: scripts/set-api-keys.sh <user> [<user> ...]" >&2
  exit 0
fi
[ "$api" = 401 ] || { echo "smoke test: /api/history without a key returned $api, expected 401" >&2; exit 1; }
echo "smoke test: OK ($URL)"
