#!/usr/bin/env bash
# Set the shared password (F11.1), and optionally end every live session.
#   scripts/set-password.sh                     # change the password
#   scripts/set-password.sh --revoke-sessions   # …and log everyone out now
#
# The password is typed, never passed as an argument, so it stays out of the
# shell history, and only its scrypt hash leaves this machine. The hash goes
# through a temporary file that is destroyed straight after, which is what AWS
# advises for secrets that would otherwise sit on a command line:
# https://docs.aws.amazon.com/secretsmanager/latest/userguide/security_cli-exposure-risks.html
# Nothing is written to your home directory, and no plaintext is kept anywhere.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-fat-horses}"
REGION="${REGION:-ap-southeast-2}"
HASH_PARAM="${HASH_PARAM:-/fat-horses/password-hash}"
SECRET_PARAM="${SECRET_PARAM:-/fat-horses/session-secret}"
cd "$(dirname "$0")/.."

REVOKE=no
case "${1:-}" in
  --revoke-sessions) REVOKE=yes ;;
  "") ;;
  *) echo "usage: $0 [--revoke-sessions]" >&2; exit 1 ;;
esac

# shred is GNU coreutils and absent on macOS; rm -P is the BSD equivalent. On a
# copy-on-write filesystem neither can truly overwrite in place, so the file
# living in a temporary directory and never in $HOME is what actually protects
# it.
destroy() {
  shred -u "$1" 2>/dev/null || rm -P "$1" 2>/dev/null || rm -f "$1"
}

umask 077
TMP="$(mktemp -t fat-horses-secret)"
trap 'destroy "$TMP"' EXIT

read -rsp "New password: " PASSWORD && echo
[ -n "$PASSWORD" ] || { echo "Empty password." >&2; exit 1; }
read -rsp "Again: " CONFIRM && echo
[ "$PASSWORD" = "$CONFIRM" ] || { echo "They don't match." >&2; exit 1; }
if [ "${#PASSWORD}" -lt 12 ]; then
  echo "Use at least 12 characters: one shared password is the only thing between" >&2
  echo "the internet and your app." >&2
  exit 1
fi

# The CLI owns the hash format, so it can never drift from what the API checks.
printf '%s' "$PASSWORD" | (cd server && npm run -s cli -- hash-password) > "$TMP"
unset PASSWORD CONFIRM
grep -q '^scrypt\$' "$TMP" || { echo "hash-password produced nothing usable." >&2; exit 1; }
aws ssm put-parameter --region "$REGION" --name "$HASH_PARAM" \
  --type SecureString --overwrite --value "file://$TMP" >/dev/null
echo "Password set in $HASH_PARAM."

# A session secret has to exist before anyone can log in; make one if there
# isn't a real one yet, and replace it when asked to end current sessions.
CURRENT="$(aws ssm get-parameter --region "$REGION" --name "$SECRET_PARAM" \
  --with-decryption --query Parameter.Value --output text 2>/dev/null || echo unset)"
if [ "$REVOKE" = yes ] || [ "$CURRENT" = unset ]; then
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' > "$TMP"
  aws ssm put-parameter --region "$REGION" --name "$SECRET_PARAM" \
    --type SecureString --overwrite --value "file://$TMP" >/dev/null
  if [ "$REVOKE" = yes ]; then
    echo "Session secret rotated: everyone is logged out."
  else
    echo "Created the session secret."
  fi
fi

echo "The api Lambda re-reads both within 5 minutes; 'make deploy' applies them now."
