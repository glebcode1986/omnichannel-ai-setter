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
#
# Compared as strings, not matched as a pattern. The name used to be interpolated straight into a regex,
# which fails in the direction that matters: measured, a protected `backup(1).sql` was **not** detected in
# a plan that deleted it, while a plain `compose.yaml` was — so protection was silently lost for any name
# carrying a regex metacharacter. The over-matching direction was harmless (`.env`'s dot also matched
# `aenv`), which is why this never showed up as a failure.
#
# The path is taken by cutting at the first space rather than at a fixed column. Measured on this rsync the
# itemize flag field is 9 characters and the separator a single space — `*deleting stale.txt` — but that
# width differs between rsync versions, and the host's rsync is not this one. Cutting at the first space
# holds whatever the width is, and any padding is then trimmed; a path containing spaces survives because
# only the first separator is consumed.
plan_path() {
  local line="$1" path
  path=${line#* }
  while [ "${path# }" != "$path" ]; do path=${path# }; done
  printf '%s' "$path"
}

VIOLATIONS=""
while IFS= read -r line; do
  [ -n "$line" ] || continue
  candidate=$(plan_path "$line")
  for name in "${PROTECTED[@]}"; do
    if [ "$candidate" = "$name" ]; then
      VIOLATIONS="$VIOLATIONS $name"
    fi
  done
done <<< "$PLAN"
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

# The gate. `KEEPSAY_DEV_DRY_RUN=1` stops here, after every refusal above has had its say and before
# anything on the host changes, so the plan can be read by a person who then runs it again for real.
if [ "${KEEPSAY_DEV_DRY_RUN:-0}" = "1" ]; then
  printf '%s\n' "$PLAN"
  say "dry run only (KEEPSAY_DEV_DRY_RUN=1) — nothing was transferred and nothing was built"
  exit 0
fi

say "recording provenance and retaining the current image"
# Why this is in a deploy script at all: nothing recorded which commit was running, so establishing it
# took digesting the container's source tree and comparing it against candidate commits one by one. A
# deploy that cannot say what it deployed is a deploy nobody can roll back with confidence.
SOURCE_SHA=$(git rev-parse HEAD 2>/dev/null || printf 'unknown')
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  SOURCE_DIRTY=true
  printf '   WARNING: the working tree is dirty, so %s names the commit but not the bytes\n' "${SOURCE_SHA:0:8}" >&2
else
  SOURCE_DIRTY=false
fi
# The same digest an auditor can recompute inside the running container: every tracked .ts/.tsx under
# apps/ and packages/, excluding what the image generates. `next-env.d.ts` is excluded because Next writes
# it and git does not track it — leaving it in made 111 candidate commits all fail to match.
# `shasum -a 1` on macOS, `sha1sum` on Linux: this script runs from an operator's machine and from CI,
# and naming only one of them makes the digest an error on the other rather than a different number.
if command -v shasum >/dev/null 2>&1; then SHA1=(shasum -a 1); else SHA1=(sha1sum); fi
SOURCE_DIGEST=$(find apps packages -type f \( -name '*.ts' -o -name '*.tsx' \) \
  ! -path '*/node_modules/*' ! -path '*/.next/*' ! -path '*/dist/*' ! -path '*/generated/*' \
  ! -name next-env.d.ts -print | LC_ALL=C sort | xargs "${SHA1[@]}" | "${SHA1[@]}" | cut -d' ' -f1)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

# The previous image, tagged under a dated name before anything replaces it. Read off the running
# container rather than guessed from the compose project name, and `||true` nowhere: if this cannot be
# done, the deploy must not proceed, because its only rollback would be gone.
PREV=$($SSH "$HOST" "cd '$DIR' && docker compose ps -q web | head -1" | tr -d '\r')
if [ -z "$PREV" ]; then
  echo "refusing: no running web container on the host, so no image could be retained for rollback" >&2
  exit 5
fi
PREV_IMAGE=$($SSH "$HOST" "docker inspect -f '{{.Config.Image}}' '$PREV'" | tr -d '\r')
PREV_DIGEST=$($SSH "$HOST" "docker image inspect -f '{{.Id}}' '$PREV_IMAGE'" | tr -d '\r')
RETAINED="${PREV_IMAGE%%:*}:$STAMP"
$SSH "$HOST" "docker tag '$PREV_IMAGE' '$RETAINED'"
if ! $SSH "$HOST" "docker image inspect -f '{{.Id}}' '$RETAINED' >/dev/null 2>&1"; then
  echo "refusing: the retained tag $RETAINED does not exist after tagging, so rollback is not available" >&2
  exit 6
fi
printf '   retained %s  (%s)\n' "$RETAINED" "${PREV_DIGEST:0:19}"

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

# The manifest goes into the artefact directory, which means the next run reads it as a protected name and
# excludes it — so the record of what is deployed survives the deploy that follows it.
if [ "$RC" = "0" ]; then
  $SSH "$HOST" "cat > '$ARTEFACTS/deployed.json'" <<JSON
{
  "deployed_at": "$STAMP",
  "source_sha": "$SOURCE_SHA",
  "source_dirty": $SOURCE_DIRTY,
  "source_digest": "$SOURCE_DIGEST",
  "previous_image": "$PREV_IMAGE",
  "previous_image_id": "$PREV_DIGEST",
  "retained_tag": "$RETAINED"
}
JSON
  say "recorded $ARTEFACTS/deployed.json"
  printf '   to roll this deploy back:\n'
  printf '     docker tag %s %s && cd %s && docker compose up -d --force-recreate --no-deps web worker\n' \
    "$RETAINED" "$PREV_IMAGE" "$DIR"
else
  printf '   build failed, so no manifest was written; the host still runs %s\n' "$PREV_IMAGE" >&2
  printf '   if the containers were replaced, roll back with:\n' >&2
  printf '     docker tag %s %s && cd %s && docker compose up -d --force-recreate --no-deps web worker\n' \
    "$RETAINED" "$PREV_IMAGE" "$DIR" >&2
fi
exit "$RC"
