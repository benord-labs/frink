#!/bin/bash
# Boots the prebuilt QA app on its isolated profile, with CDP on :9223.
# Boot-only: app-state prep (profile wipe, fixture DB) lives in seed.sh, which
# qavis runs first — this script owns what must span the app's lifetime: the
# single-run lock and launch. Isolated from the owner's running dev app (own
# userData/lock/sqlite via AUTH_SERVER_PORT suffix, own CDP port).
# Launches the bundle build.sh produced (the recipe's `bootstrap` step), not `electron-vite dev`.
# Triage: the `frink-qa` skill. Manual run:
#   bash scripts/qa/build.sh && bash scripts/qa/seed.sh && bash scripts/qa/boot.sh
set -euo pipefail
. "$(dirname "$0")/env.sh"

mkdir -p "$QA_HOME"

# One QA run at a time: the rig is single-tenant — one CDP port (9223) and one
# $HOME QA profile — so a second concurrent run would wipe and re-seed the
# profile the first one is driving.
if ! mkdir "$LOCK" 2>/dev/null; then
  HOLDER=$(cat "$LOCK/pid" 2>/dev/null || echo "")
  if [ -n "$HOLDER" ] && kill -0 "$HOLDER" 2>/dev/null; then
    echo "frink QA already running (pid $HOLDER) — one run at a time." >&2
    exit 1
  fi
  rm -rf "$LOCK" && mkdir "$LOCK" # stale lock from a killed run — steal it
fi
echo $$ > "$LOCK/pid"

DEV_PID=""
cleanup() {
  # qavis SIGTERMs the whole process group, so electron is already shutting
  # down; wait for the dev wrapper to exit before releasing the run lock.
  if [ -n "$DEV_PID" ]; then wait "$DEV_PID" 2>/dev/null || true; fi
  rm -rf "$LOCK"
}
trap cleanup TERM INT EXIT

cd "$(dirname "$0")/../.."

# Fail loud when build.sh has not run, rather than let Electron's "module not found" stand in.
if [ ! -s "out-qa/main/index.js" ]; then
  rm -rf "$LOCK"
  echo "frink is not built — run: bash scripts/qa/build.sh first (qavis does via the recipe's bootstrap step)." >&2
  exit 1
fi

# Provision Electron's app binary. electron@43 declares NO install lifecycle script, so the binary
# is absent after a clean install and launching electron dies with "Electron uninstall". Doing it
# inline in the recipe's install step (`bun install && node …/install.js`) races frink's own
# postinstall — ensure-native-abi's @electron/rebuild contends @electron/get's cache — and the
# chained install.js silently no-ops (exit 0, no dist/). Run here instead: a separate, later step
# with no contention. Idempotent — a warm cache is an instant extract, a present binary a no-op.
# Goes through the shared script (sc-1452) so the silent-no-op mode this comment describes is
# actually detected: it verifies dist/<path.txt> resolves and fails loudly if not.
node scripts/binaries/ensure-electron-binary.mjs

# Runtime env the app reads via process.env (backend URLs, OAuth client id, PostHog/Sentry keys).
# Under `electron-vite dev` the CLI's loadEnv() put .env into Electron's environment; a direct
# launch does not (nor does `electron-vite preview --skipBuild`, which skips the config entirely).
# Parsed line by line with electron-vite's own regex, not `source`d: the real .env has bare
# non-`#` comment lines that a shell would execute. Values are single-quoted for the eval.
if [ -f .env ]; then
  eval "$(node -e '
    const fs = require("node:fs");
    for (const line of fs.readFileSync(".env", "utf-8").split("\n")) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const val = m[2].replace(/^["\x27]|["\x27]$/g, "").replace(/\x27/g, "\x27\"\x27\"\x27");
      process.stdout.write(`export ${m[1]}=\x27${val}\x27\n`);
    }
  ')"
fi

# QA_FRINK_HOME (env.sh) is the app's own state root; the app refuses to boot if FRINK_HOME is
# unset or resolves to the real home. seed.sh created and seeded it before this launch.
# qavis exports QAVIS_EVIDENCE_DIR (its per-run bundle) to `start`; without it — a manual boot, or an
# older qavis — the log stays profile-local. Announced because a silent fallback would let a run
# "pass" while the log it was meant to capture landed outside the evidence bundle.
QA_LOG_DIR="${QAVIS_EVIDENCE_DIR:-$QA_USER_DATA/logs}"
mkdir -p "$QA_FRINK_HOME" "$QA_LOG_DIR"
echo "[boot.sh] FRINK_HOME=$QA_FRINK_HOME FRINK_LOG_DIR=$QA_LOG_DIR${QAVIS_EVIDENCE_DIR:+ (qavis run dir)}" >&2

# ELECTRON_RUN_AS_NODE must be unset or electron runs as plain node (no window, no CDP).
# FRINK_CDP_PORT keeps clear of the owner's 9222; FRINK_CUSTOM_NODES_DIR keeps the node palette on
# the seeded fixtures instead of the operator's ~/.frink/nodes; FRINK_HOME/FRINK_LOG_DIR are the
# rig-owned state root and log above; the two DISABLE flags keep the QA run off the operator's
# worktrees and queue. MAIN_VITE_AUTH_SERVER_PORT is baked into the renderer at build time, but the
# drain freeze reads it from process.env at runtime, so it must be exported here as well.
# A blank FRINK_WEBHOOK_BASE_URL keeps the rig local-only; unset, every build dials Frink's public relay.
# The entry is given explicitly: package.json's `main` points at out/, which this build never touches.
env -u ELECTRON_RUN_AS_NODE \
  FRINK_CDP_PORT=9223 \
  FRINK_CUSTOM_NODES_DIR="$QA_USER_DATA/nodes" \
  FRINK_HOME="$QA_FRINK_HOME" \
  FRINK_WEBHOOK_BASE_URL= \
  FRINK_LOG_DIR="$QA_LOG_DIR" \
  FRINK_QA_SKIP_WELCOME=1 \
  FRINK_DISABLE_WORKTREE_RECOVERY=1 \
  FRINK_DISABLE_FLOW_ADMISSION_DRAIN=1 \
  MAIN_VITE_AUTH_SERVER_PORT=21399 \
  node_modules/.bin/electron out-qa/main/index.js &
DEV_PID=$!
# Capture the app process's REAL exit instead of letting `set -e` + the EXIT trap mask it as 0. If
# the app dies on its own (a crash, an OOM) rather than being torn down by the caller's SIGTERM,
# this code names it, so the caller sees a crash as a crash and not a blind "exited (0) before
# becoming ready".
DEV_EXIT=0
wait "$DEV_PID" || DEV_EXIT=$?
echo "[boot.sh] app process exited with code $DEV_EXIT" >&2
exit "$DEV_EXIT"
