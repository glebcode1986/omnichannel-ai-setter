#!/usr/bin/env bash
#
# Put the working tree on the development host and rebuild it.
#
# This exists because doing it by hand destroyed two files. The repository has a `compose.yaml` — two
# services, Postgres and Redis, for running the app locally — and the development host has a *different*
# `compose.yaml` at the same path, with five services, which is the one that actually runs the stack. An
# `rsync --delete` with a hand-typed exclude list overwrote it and deleted the `Dockerfile` next to it.
# Nothing went down, because a running container does not read its compose file, but the stack could not
# be rebuilt until both were restored from `$ARTEFACTS` on the host.
#
# So the exclude list is not typed here either. It is **read from the host's own artefact directory**,
# which is the record of what belongs to the host rather than to the repository. Add a file there and it
# is protected from the next deploy automatically; that is one place to remember instead of two.
#
# Then it checks its own work: a dry run must not report deleting or updating any protected path. If it
# does, nothing is transferred.
#
# No host address and no credentials live in this file. Both come from the environment:
#
#   KEEPSAY_DEV_HOST   user@host for ssh and rsync
#   KEEPSAY_DEV_KEY    path to the private key
#   KEEPSAY_DEV_DIR    the stack's directory on the host   (default /opt/omnichannel-staging)
#   KEEPSAY_DEV_ARTEFACTS  the host-only artefact directory (default /root/staging-artifacts)
#
set -euo pipefail

HOST="${KEEPSAY_DEV_HOST:?set KEEPSAY_DEV_HOST to user@host}"
KEY="${KEEPSAY_DEV_KEY:?set KEEPSAY_DEV_KEY to the private key path}"
DIR="${KEEPSAY_DEV_DIR:-/opt/omnichannel-staging}"
ARTEFACTS="${KEEPSAY_DEV_ARTEFACTS:-/root/staging-artifacts}"
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"

say() { printf '\n== %s\n' "$1"; }

say "reading the host's artefact list"
# Everything the host owns. `.env` is listed too, and excluded like the rest.
# A `while read` loop rather than `mapfile`, which macOS's bash 3.2 does not have — and does not have
# loudly enough: it reports "command not found" and leaves the array empty, which is the one failure
# this script must never treat as "nothing to protect".
PROTECTED=()
while IFS= read -r name; do
  [ -n "$name" ] && PROTECTED+=("$name")
done < <($SSH "$HOST" "ls -A '$ARTEFACTS'")
if [ "${#PROTECTED[@]}" -eq 0 ]; then
  echo "refusing: $ARTEFACTS is empty, so nothing would be protected" >&2
  echo "an empty list is not 'nothing to protect' — it is a lost record" >&2
  exit 2
fi
printf '   protected: %s\n' "${PROTECTED[*]}"

EXCLUDES=(--exclude '.git' --exclude 'node_modules' --exclude '.next' --exclude 'dist'
          --exclude '.turbo' --exclude '.claude' --exclude '.env' --exclude '.env.*')
for name in "${PROTECTED[@]}"; do
  # `.env.before-google` and friends are snapshots of a protected file; protect the base name too.
  EXCLUDES+=(--exclude "$name")
done

say "dry run"
PLAN=$(rsync -az --delete --dry-run --itemize-changes "${EXCLUDES[@]}" \
  -e "$SSH" ./ "$HOST:$DIR/")

# The check that would have stopped the accident: no protected path may be deleted or rewritten.
VIOLATIONS=""
for name in "${PROTECTED[@]}"; do
  if printf '%s\n' "$PLAN" | grep -qE "^(\*deleting +|[<>ch.][fdLDS][^ ]* )${name}$"; then
    VIOLATIONS="$VIOLATIONS $name"
  fi
done
if [ -n "$VIOLATIONS" ]; then
  echo "refusing: the transfer would touch host-only files:$VIOLATIONS" >&2
  exit 3
fi

# And a control: a dry run that plans nothing cannot prove the filter works, so say so rather than
# reporting a clean result. A deploy with no changes is a mistake worth noticing on its own.
if [ -z "$PLAN" ]; then
  echo "nothing to transfer — the host already matches the working tree" >&2
  exit 4
fi
printf '   %s path(s) to transfer\n' "$(printf '%s\n' "$PLAN" | wc -l | tr -d ' ')"

say "transferring"
rsync -az --delete "${EXCLUDES[@]}" -e "$SSH" ./ "$HOST:$DIR/"

say "building, detached"
# Detached with its own exit code in a file: an ssh connection that drops exits 255, and 255 read as a
# build failure is how a successful deploy gets reported as broken.
$SSH "$HOST" "cat > /tmp/keepsay-dev-build.sh" <<SH
#!/usr/bin/env bash
cd '$DIR' || exit 9
rm -f /tmp/keepsay-dev-build.rc
{
  docker compose build web worker; echo "BUILD_RC=\$?"
  docker compose up -d web worker;  echo "UP_RC=\$?"
  docker compose ps --format '{{.Name}}\t{{.Status}}'
} > /tmp/keepsay-dev-build.log 2>&1
grep -q 'BUILD_RC=0' /tmp/keepsay-dev-build.log && grep -q 'UP_RC=0' /tmp/keepsay-dev-build.log
echo \$? > /tmp/keepsay-dev-build.rc
SH
$SSH "$HOST" "chmod +x /tmp/keepsay-dev-build.sh && nohup /tmp/keepsay-dev-build.sh >/dev/null 2>&1 &" || true

say "waiting for the build"
until $SSH "$HOST" "test -f /tmp/keepsay-dev-build.rc" 2>/dev/null; do sleep 15; done
RC=$($SSH "$HOST" "cat /tmp/keepsay-dev-build.rc")
$SSH "$HOST" "tail -20 /tmp/keepsay-dev-build.log"
say "build rc=$RC"
exit "$RC"
