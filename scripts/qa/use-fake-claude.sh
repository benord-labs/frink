#!/usr/bin/env bash
# Points the QA build at the scripted fake `claude` (scripts/qa/fake-bin) instead of the real CLI, so
# turns cost nothing and answer the fixed [qa:*] scenarios. Run after build.sh, before boot.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p out-qa/main/resources
rm -rf out-qa/main/resources/bin
ln -s "$PWD/scripts/qa/fake-bin" out-qa/main/resources/bin
echo "[use-fake-claude] out-qa now runs scripts/qa/fake-bin/darwin-arm64/claude" >&2
