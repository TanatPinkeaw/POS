#!/usr/bin/env bash
#
# Put a Google OAuth client id into a deployed checkout's `.env` and restart the till.
#
# Run it on the box that serves the shop, as root, because `/opt/pos/.env` belongs to
# the account systemd starts the app as:
#
#   sudo bash deploy/set-google-client-id.sh <client-id>.apps.googleusercontent.com
#
# Why a script rather than three commands typed by hand: the failure this exists to
# prevent is a *half* applied change. `echo >> .env` twice leaves two
# GOOGLE_CLIENT_ID lines and the reader takes whichever it likes; `sed -i` under root
# leaves a file the `pos` account cannot read, and the app then starts with no
# database and no Google, which looks like two unrelated faults. So the write is
# atomic, the ownership and mode of the file are put back exactly as they were, and
# the old file is kept beside it.
#
# What it cannot do is make Google accept the sign-in: the client id has to be listed
# under "Authorized JavaScript origins" in the Google Cloud Console, and only a
# browser can prove that half. The check at the end therefore proves *our* half — that
# the running app is holding the id — and prints the exact origin string to paste into
# the console, because that string is wrong in more ways than it looks (scheme, host,
# port, and a trailing slash that is not part of it).
set -euo pipefail

ENV_FILE="${POS_ENV_FILE:-/opt/pos/.env}"
SERVICE="${POS_SERVICE:-pos}"
PORT="${POS_PORT:-3000}"
PUBLIC_URL="${POS_PUBLIC_URL:-https://pos.tanatpinkeaw.stream}"

CLIENT_ID="${1:-}"

fail() {
  echo "error: $*" >&2
  exit 1
}

# Google's own id shape: digits, a dash, then the project's host. Anything else is a
# copy-paste of the wrong thing (a client *secret*, a project number, an app id), and
# the app would then be holding a value that can never verify a token.
case "$CLIENT_ID" in
  '' ) fail "usage: sudo bash $0 <client-id>.apps.googleusercontent.com" ;;
  *apps.googleusercontent.com) ;;
  * ) fail "'$CLIENT_ID' is not a client id. It ends in .apps.googleusercontent.com; a client secret or a project number will not work." ;;
esac

[ -f "$ENV_FILE" ] || fail "$ENV_FILE does not exist. The app reads .env from its working directory, so a box that has never been installed has none yet."

if [ "${POS_SKIP_RESTART:-0}" != "1" ]; then
  command -v systemctl >/dev/null 2>&1 || fail "systemctl is not here. Run this on the machine that serves the shop, or set POS_SKIP_RESTART=1 to only write the file."
fi

# Ownership and mode are read before the write and carried through it. A root-owned
# `.env` is the exact state the deployment notes warn about: `systemctl start` then
# fails for reasons that have nothing to do with Google.
OWNER="$(stat -c '%U:%G' "$ENV_FILE")"
MODE="$(stat -c '%a' "$ENV_FILE")"
BACKUP="${ENV_FILE}.bak-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$ENV_FILE" "$BACKUP"

# Written to a temporary file and moved into place, so a reader never sees a `.env`
# that is half old and half new, and a failure partway through leaves the old file
# untouched. `grep -v` rather than `sed -i` for the same reason, plus it cannot mangle
# the other keys' quoting on the way.
#
# The temporary file is a *copy* (`cp -p`, so it already carries the owner and mode of
# the original) and the new content is written into that copy with `cat >`, which
# writes through the existing inode rather than replacing it. Both details exist for
# one reason: a file created by `mktemp` belongs to whoever ran this script, so
# `mv`-ing it into place would hand the `pos` account a file it cannot read.
TMP="$(mktemp "${ENV_FILE}.XXXXXX")"
BODY="$(mktemp "${ENV_FILE}.XXXXXX")"
trap 'rm -f "$TMP" "$BODY"' EXIT
cp -p "$ENV_FILE" "$TMP"
grep -v -E '^[[:space:]]*(export[[:space:]]+)?GOOGLE_CLIENT_ID=' "$TMP" > "$BODY" || true
printf 'GOOGLE_CLIENT_ID=%s\n' "$CLIENT_ID" >> "$BODY"
cat "$BODY" > "$TMP"
chmod "$MODE" "$TMP"
mv "$TMP" "$ENV_FILE"
trap - EXIT

echo "wrote GOOGLE_CLIENT_ID into $ENV_FILE (owner $OWNER, mode $MODE)"
echo "the previous file is at $BACKUP — delete it once the door works, it holds every other secret too"

# One key, and it is the only one in the file. `export` and leading spaces are
# counted because Node's own `.env` reader accepts them, which means a hand-edited
# file can carry the same key twice and the reader will take whichever it reaches
# last — so leaving the old spelling in place is exactly the failure to avoid.
COUNT="$(grep -c -E '^[[:space:]]*(export[[:space:]]+)?GOOGLE_CLIENT_ID=' "$ENV_FILE" || true)"
[ "$COUNT" = "1" ] || fail "expected exactly one GOOGLE_CLIENT_ID line and found $COUNT. $BACKUP has the file as it was."
echo "masked for the log: ${CLIENT_ID:0:12}… (${#CLIENT_ID} chars)"

if [ "${POS_SKIP_RESTART:-0}" = "1" ]; then
  echo "POS_SKIP_RESTART=1, so nothing was restarted. Run: sudo systemctl restart $SERVICE"
  exit 0
fi

systemctl restart "$SERVICE"

# Started is not serving: a Next server takes a moment to bind, and the restart that
# has just happened is also the first thing to be checked for a crash loop.
#
# **`/login`, and this script was quietly broken by the doors swapping** (ADR 0029). It
# probed `/shop`, which is now a 307 to `/login`: the readiness loop below never saw a 200
# and gave up with "did not answer 200" after thirty seconds on a perfectly healthy
# service, and the read-back further down fetched the redirect's empty body and told the
# operator it could not tell whether Google was configured. The one tool that answers
# "did the value reach the process?" has to aim at the screen that *renders* the answer.
READY=0
for _ in $(seq 1 30); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/login" || true)"
  if [ "$CODE" = "200" ]; then READY=1; break; fi
  sleep 1
done
if [ "$READY" != "1" ]; then
  echo "warning: $SERVICE did not answer 200 on :$PORT within 30s (last was '${CODE:-none}')." >&2
  echo "read the log before concluding anything about Google: journalctl -u $SERVICE -n 50" >&2
  exit 1
fi

# Our half. `apps.googleusercontent.com` is in the served page only when
# `readGoogleClientId()` found a value, and the notice is what the page says when it
# did not — so this distinguishes "configured and served" from "configured on disk but
# not in the process", which are the two failures that look alike from the browser.
HTML="$(curl -s "http://127.0.0.1:${PORT}/login")"
if printf '%s' "$HTML" | grep -q 'apps.googleusercontent.com'; then
  echo "verified: the running app is serving a Google sign-in button"
elif printf '%s' "$HTML" | grep -q 'ยังไม่ได้ตั้งค่าการเข้าสู่ระบบด้วย Google'; then
  echo "verified: the app is up, and it says Google is NOT configured" >&2
  echo "the value is in $ENV_FILE but not in the process — is the service reading that file?" >&2
  exit 1
else
  # A shop that has not been set up redirects to /setup, so the door is not rendered
  # and neither string is present. That is not a Google fault and must not read as one.
  echo "note: the page carried neither the Google door nor the 'not configured' notice." >&2
  echo "if this box has never been through /setup, the door is not on screen yet — that is the setup wizard, not Google." >&2
fi

echo
echo "now Google's half, which only a browser can settle:"
echo "  Google Cloud Console → APIs & Services → Credentials → your Web client"
echo "  → Authorized JavaScript origins, add exactly:"
echo "      ${PUBLIC_URL%/}"
echo "  no trailing slash, and the scheme and port have to be the ones the browser is on"
echo "then wait a few minutes for Google's cache and open ${PUBLIC_URL%/}/login"
echo "if the button comes back greyed or Google answers 403, it is the origin list —"
echo "the app cannot be the cause, because the check above just proved it holds the id."