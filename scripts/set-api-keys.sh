#!/usr/bin/env bash
# Create a random API key per user and store them in SSM (F14.2).
#   scripts/set-api-keys.sh haruka friend
# The keys are written to ~/.config/fat-horses/api-keys.json (readable only by
# you) and never printed, so they don't end up in terminal logs or chats.
# Running it again replaces every key: list all users each time.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-fat-horses}"
REGION="${REGION:-ap-southeast-2}"
PARAM="${PARAM:-/fat-horses/api-keys}"
[ "$#" -ge 1 ] || { echo "usage: $0 <user> [<user> ...]" >&2; exit 1; }

OUT_DIR="$HOME/.config/fat-horses"
OUT="$OUT_DIR/api-keys.json"
mkdir -p "$OUT_DIR" && chmod 700 "$OUT_DIR"
umask 077

node -e '
  const { randomBytes } = require("node:crypto");
  const keys = {};
  for (const user of process.argv.slice(1)) {
    if (!/^[a-z0-9_-]{1,32}$/.test(user)) { console.error(`bad user "${user}"`); process.exit(1); }
    keys[user] = randomBytes(24).toString("base64url");
  }
  process.stdout.write(JSON.stringify(keys));
' "$@" > "$OUT"

aws ssm put-parameter --region "$REGION" --name "$PARAM" --type SecureString --overwrite \
  --value "file://$OUT" >/dev/null
echo "Stored keys for: $* in $PARAM"
echo "Your copy: $OUT (give each person only their own key)"
echo "The api Lambda reads keys when it starts; run 'make deploy' or wait a few minutes for new keys to apply."
