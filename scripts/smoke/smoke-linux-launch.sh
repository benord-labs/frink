#!/usr/bin/env bash
# Launch smoke for the packaged Linux app. The .deb and the AppImage must each map a Frink window under
# Xvfb (the .deb with Chromium's sandbox on), and the bundled CLIs must run on the oldest supported distros.
#
# Run from the repo root after `bun run package:linux`; logs land in $FRINK_SMOKE_OUT:
#   bash scripts/smoke/smoke-linux-launch.sh [deb] [appimage] [old-distros]   # no argument runs all three
# Needs xvfb, xdotool, fuse3 and procps; `deb` also needs sudo, apt and AppArmor, and `old-distros` needs docker.
#
# Local AppImage run from a Mac with Docker Desktop (`open -a Docker`); drop --platform for an arm64 build:
#   docker run --rm --platform linux/amd64 --device /dev/fuse --cap-add SYS_ADMIN --shm-size 1g \
#     -v "$PWD:/src" -w /src ubuntu:24.04 bash -c 'apt-get update && apt-get install -y xvfb xdotool \
#     fuse3 procps libgtk-3-0t64 libnss3 libasound2t64 libgbm1 && useradd -m smoke \
#     && su smoke -c "bash scripts/smoke/smoke-linux-launch.sh appimage"'
set -euo pipefail

# One display for every launch: re-run this script inside xvfb-run.
[ -n "${FRINK_SMOKE_IN_XVFB:-}" ] || FRINK_SMOKE_IN_XVFB=1 exec xvfb-run -a -s '-screen 0 1440x900x24' bash "$0" "$@"

OUT="${FRINK_SMOKE_OUT:-${RUNNER_TEMP:-/tmp}/linux-launch-smoke}"
FATAL_STDERR='FATAL|No usable sandbox|error while loading shared libraries'
APP_SID=''

fail() {
  echo "::error::$*" >&2
  exit 1
}

# Start "$@" as its own session with a fresh HOME, then require a mapped Frink window and a clean stderr.
launch() {
  local label=$1
  shift
  local dir="$OUT/$label"
  rm -rf "$dir"
  mkdir -p "$dir/home"
  HOME="$dir/home" FRINK_LOG_DIR="$dir" setsid "$@" >"$dir/stdout.log" 2>"$dir/stderr.log" &
  APP_SID=$!
  local mapped=0
  timeout 90 xdotool search --sync --onlyvisible --name '^Frink' >/dev/null && mapped=1
  # Give a boot crash after the first paint the chance to surface before judging.
  [ "$mapped" = 0 ] || sleep 5
  if grep -E "$FATAL_STDERR" "$dir/stderr.log"; then fail "$label: fatal error on stderr (above)"; fi
  if [ "$mapped" = 0 ]; then
    tail -n 40 "$dir/stderr.log" >&2
    fail "$label: no Frink window mapped within 90s"
  fi
  kill -0 "$APP_SID" 2>/dev/null || fail "$label: Frink exited after mapping its window"
  ps -o pid=,args= --sid "$APP_SID" >"$dir/processes.txt"
}

# Quit through the browser process: signalling its children too makes it FATAL on a lost GPU process.
stop() {
  kill -TERM "$APP_SID" 2>/dev/null || true
  timeout 15 tail --pid="$APP_SID" -f /dev/null || true
  pkill -KILL -s "$APP_SID" || true
  APP_SID=''
}
trap '[ -z "$APP_SID" ] || stop' EXIT

check_deb() {
  # Ubuntu 23.10+ desktops block unprivileged user namespaces unless an AppArmor profile allows them; match that.
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=1
  # Installing runs electron-builder's after-install, which adds that profile and sets chrome-sandbox's mode.
  sudo apt-get install -y -q ./release/*.deb
  [ -f /etc/apparmor.d/frink ] || fail "deb: the install did not add the AppArmor profile /etc/apparmor.d/frink"
  # TEMPORARY negative proof, reverted in the next commit: without the profile the launch must fail.
  sudo apparmor_parser -R /etc/apparmor.d/frink && sudo rm /etc/apparmor.d/frink
  stat -c '%A %U %n' /opt/Frink/chrome-sandbox
  launch deb /opt/Frink/frink
  local procs="$OUT/deb/processes.txt"
  grep -q -- '--type=zygote' "$procs" || fail "deb: no zygote process, so the sandbox check below would prove nothing"
  # Electron passes --no-sandbox to renderers of `sandbox: false` windows; anywhere else it means the sandbox is off.
  if grep -v -- '--type=renderer' "$procs" | grep -- '--no-sandbox'; then fail "deb: Frink is running without the Chromium sandbox"; fi
  echo "deb: window mapped with the Chromium sandbox on"
  stop
}

check_appimage() {
  if ldconfig -p | grep 'libfuse\.so\.2'; then fail "libfuse2 is installed, so this would not prove the AppImage runs without it"; fi
  launch appimage "$PWD"/release/*.AppImage
  echo "AppImage: window mapped without libfuse2"
  stop
}

# codex links the system OpenSSL 3, which every desktop install ships but the slim debian image omits.
DISTRO_PROBE='ldconfig -p | grep -q libssl.so.3 || { apt-get update -qq && apt-get install -y -qq libssl3 >/dev/null; }
/frink-bin/codex --version && /frink-bin/claude --version'

check_old_distros() {
  local image
  for image in ubuntu:22.04 debian:12; do
    docker run --rm -v "$PWD/release/linux-unpacked/resources/bin:/frink-bin:ro" "$image" sh -c "$DISTRO_PROBE" \
      || fail "the bundled codex/claude do not run on $image"
    echo "codex/claude --version OK on $image"
  done
}

[ $# -gt 0 ] || set -- deb appimage old-distros
for check in "$@"; do
  case "$check" in
    deb) check_deb ;;
    appimage) check_appimage ;;
    old-distros) check_old_distros ;;
    *) fail "unknown check '$check' (expected deb, appimage or old-distros)" ;;
  esac
done
