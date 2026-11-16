#!/bin/bash
# Usage: stop.sh [boot-pid]. Stops the QA app boot.sh launched and waits for the run lock to free;
# given a pid, only while that boot.sh holds the rig. With nothing running it clears a stale lock.
set -euo pipefail
. "$(dirname "$0")/env.sh"

HOLDER=$(cat "$LOCK/pid" 2>/dev/null || echo "")
APP=$(cat "$LOCK/app-pid" 2>/dev/null || echo "")
# Live only if the start time boot.sh recorded still matches: a stale lock's pid may be reused.
up() {
  local started
  started=$(ps -o lstart= -p "$1" 2>/dev/null) && [ "$started" = "$(cat "$2" 2>/dev/null)" ]
}
boot_up() { [ -n "$HOLDER" ] && up "$HOLDER" "$LOCK/pid.start"; }
app_up() { [ -n "$APP" ] && up "$APP" "$LOCK/app-pid.start"; }
# Only the lock read above: a boot.sh that has since taken the rig keeps its own.
release() { [ -n "$HOLDER" ] && [ "$(cat "$LOCK/pid" 2>/dev/null || echo "")" = "$HOLDER" ] && rm -rf "$LOCK"; }

if [ -n "${1:-}" ] && [ "$HOLDER" != "$1" ]; then
  echo "qa stop: boot.sh $1 does not hold the rig (holder: ${HOLDER:-none}); left it alone"
  exit 0
fi
if ! boot_up && ! app_up; then
  release || true
  echo "qa stop: not running"
  exit 0
fi

# boot.sh passes TERM on to the app and frees the lock once it exits; an app whose boot.sh was
# killed is signalled directly.
if boot_up; then kill -TERM "$HOLDER" 2>/dev/null || true; else kill -TERM "$APP" 2>/dev/null || true; fi
for _ in $(seq 1 40); do
  boot_up || app_up || break
  sleep 0.25
done

# Still up after 10 s: kill the launcher and the Electron main it spawned (Chromium's helpers exit
# with their browser process), then boot.sh.
if boot_up || app_up; then
  APP=$(cat "$LOCK/app-pid" 2>/dev/null || echo "$APP")
  if app_up; then
    pkill -KILL -P "$APP" 2>/dev/null || true
    kill -KILL "$APP" 2>/dev/null || true
  fi
  if boot_up; then kill -KILL "$HOLDER" 2>/dev/null || true; fi
  echo "qa stop: app did not exit within 10 s; killed it (pid ${APP:-none}, boot.sh ${HOLDER:-none})" >&2
fi
release || true
echo "qa stop: stopped (boot.sh ${HOLDER:-none})"
