#!/bin/bash
# One command that proves the QA app boots healthy: seed, boot on the fake claude, run
# smoke-check.ts, then always stop the app. Prints one summary line; exits 0 or 1.
set -euo pipefail
. "$(dirname "$0")/env.sh"
cd "$(dirname "$0")/../.."

OUT="$QA_HOME/smoke"
STARTED=$(date +%s)
summary() { echo "qa smoke: $1 ($(($(date +%s) - STARTED))s, logs in $OUT)"; }
fail() {
  summary "FAIL — $1"
  exit 1
}

[ -s "out-qa/main/index.js" ] || fail "not built; run bash scripts/qa/build.sh first"
rm -rf "$OUT"
mkdir -p "$OUT"

if ! bash scripts/qa/seed.sh > "$OUT/seed.log" 2>&1; then
  fail "seed.sh: $(grep -m1 -i 'error' "$OUT/seed.log" || tail -1 "$OUT/seed.log")"
fi

env -u QA_REAL_CLAUDE FRINK_QA_EVIDENCE_DIR="$OUT" bash scripts/qa/boot.sh > "$OUT/boot.log" 2>&1 &
BOOT=$!
trap 'bash scripts/qa/stop.sh "$BOOT" > "$OUT/stop.log" 2>&1 || true' EXIT
# seed.sh only checks the lock, so another run can take it first: grade and stop nothing but our own.
for _ in $(seq 1 300); do
  [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$BOOT" ] && break
  kill -0 "$BOOT" 2>/dev/null || break
  sleep 0.1
done
if [ "$(cat "$LOCK/pid" 2>/dev/null)" != "$BOOT" ]; then
  fail "boot.sh did not take the rig: $(tail -1 "$OUT/boot.log")"
fi
QA_BOOT_PID=$BOOT bun scripts/qa/smoke-check.ts "$OUT/main.log" "$QA_USER_DATA/data/agents.db" \
  > "$OUT/checks.log" 2>&1 || fail "$(head -1 "$OUT/checks.log") (all of it in checks.log)"
summary "PASS"
