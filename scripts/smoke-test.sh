#!/usr/bin/env bash
# After a deploy: the site loads, and the API refuses requests without a session.
set -euo pipefail
URL="${1:?usage: $0 <url>}"
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$URL/")" && [ "$code" = 200 ] && break
  sleep 10
done
[ "$code" = 200 ] || { echo "smoke test: $URL/ returned $code" >&2; exit 1; }
api="$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/history")"
[ "$api" = 401 ] || { echo "smoke test: /api/history without a session returned $api, expected 401" >&2; exit 1; }

# A deliberately wrong password: 401 means a password is set, 503 means none is.
login="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/api/login" \
  -H 'content-type: application/json' --data '{"password":"smoke-test-not-the-password"}')"
if [ "$login" = 503 ]; then
  echo "smoke test: site OK; no password set yet. Run: scripts/set-password.sh" >&2
  exit 0
fi
[ "$login" = 401 ] || { echo "smoke test: /api/login with a wrong password returned $login, expected 401" >&2; exit 1; }
echo "smoke test: OK ($URL)"
