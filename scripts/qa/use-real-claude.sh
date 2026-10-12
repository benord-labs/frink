#!/usr/bin/env bash
# Points the QA build at the real bundled CLIs (the checkout's resources/bin), undoing
# use-fake-claude.sh. Sends then run on this machine's own Claude login and spend its quota, so
# boot.sh only calls this under QA_REAL_CLAUDE=1. Optional $1: the built app dir (default out-qa/main).
set -euo pipefail
cd "$(dirname "$0")/../.."
APP_DIR="${1:-out-qa/main}"
case "$(uname -m)" in arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
REAL="$PWD/resources/bin/darwin-$ARCH/claude"
# Fail before relinking: a boot that linked a tree with no claude in it would start, then fail
# every send with a spawn error far from the cause.
if [ ! -x "$REAL" ]; then
  echo "[use-real-claude] no bundled claude at $REAL — run the checkout's binary download first." >&2
  exit 1
fi
mkdir -p "$APP_DIR/resources"
rm -rf "$APP_DIR/resources/bin"
ln -s "$PWD/resources/bin" "$APP_DIR/resources/bin"
echo "[use-real-claude] $APP_DIR now runs $REAL — sends spend this machine's Claude quota." >&2
