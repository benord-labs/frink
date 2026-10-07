#!/usr/bin/env bash
# Points the QA build at the scripted fake `claude` (scripts/qa/fake-bin) instead of the real CLI, so
# turns cost nothing and answer the fixed [qa:*] scenarios. boot.sh runs this on every boot unless
# QA_REAL_CLAUDE=1; run it by hand only to switch an already-built tree back to the fake.
# Only `claude` is swapped: every other bundled CLI (codex) stays linked to the checkout's real copy,
# since the app has no PATH fallback for it. Optional $1: the built app dir (default out-qa/main).
set -euo pipefail
cd "$(dirname "$0")/../.."
APP_DIR="${1:-out-qa/main}"
FAKE="$PWD/scripts/qa/fake-bin/darwin-arm64/claude" # a node script, so it serves either arch
BIN="$APP_DIR/resources/bin"
mkdir -p "$APP_DIR/resources"
rm -rf "$BIN"
mkdir -p "$BIN"
[ -e resources/bin/VERSION ] && ln -s "$PWD/resources/bin/VERSION" "$BIN/VERSION"
for ARCH in arm64 x64; do
  mkdir "$BIN/darwin-$ARCH"
  for real in resources/bin/darwin-$ARCH/*; do
    [ -f "$real" ] || continue # files only: skips a missing arch's empty glob and any nested dir
    name=$(basename "$real")
    [ "$name" = claude ] && continue
    ln -s "$PWD/$real" "$BIN/darwin-$ARCH/$name"
  done
  ln -s "$FAKE" "$BIN/darwin-$ARCH/claude"
done
echo "[use-fake-claude] $APP_DIR now runs scripts/qa/fake-bin/darwin-arm64/claude; other bundled CLIs stay real" >&2
