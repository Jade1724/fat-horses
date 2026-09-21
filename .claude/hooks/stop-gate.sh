#!/usr/bin/env bash
# Stop hook: Claude may not end its turn while `make check` fails.
# Exit 2 blocks the stop and feeds stderr back to Claude.
# After MAX_BLOCKS consecutive failures it lets Claude stop, so a
# problem Claude can't fix doesn't loop forever.
set -uo pipefail

MAX_BLOCKS="${STOP_GATE_MAX_BLOCKS:-5}"

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0

input="$(cat)"
session_id="$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("session_id","default"))' 2>/dev/null || echo default)"
counter="${TMPDIR:-/tmp}/claude-stop-gate-${session_id}"

# Nothing changed since the last commit: nothing to verify.
if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
  rm -f "$counter"
  exit 0
fi

if output="$(make check 2>&1)"; then
  rm -f "$counter"
  exit 0
fi

blocks=$(( $(cat "$counter" 2>/dev/null || echo 0) + 1 ))
echo "$blocks" > "$counter"

if [ "$blocks" -gt "$MAX_BLOCKS" ]; then
  rm -f "$counter"
  echo "stop-gate: make check still failing after $MAX_BLOCKS attempts; allowing stop." >&2
  exit 0
fi

{
  echo "make check failed (attempt $blocks/$MAX_BLOCKS). Fix it before finishing."
  echo "--- last 60 lines of output ---"
  printf '%s\n' "$output" | tail -n 60
} >&2
exit 2
