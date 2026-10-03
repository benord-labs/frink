#!/bin/bash
# Builds the QA app into out-qa/; boot.sh launches it.
# Builds into out-qa/, never out/: this build bakes QA-only env, and a stale QA build in out/
# is what `bun run package:mac` would ship.
set -euo pipefail

cd "$(dirname "$0")/../.."

# Build-time only: MAIN_VITE_* values are baked in by electron-vite's loadEnv(). This one selects
# the QA userData dir ("Frink Dev-21399", see env.sh) and auth-callback port. Values the app reads
# from process.env at runtime are exported by boot.sh instead.
export MAIN_VITE_AUTH_SERVER_PORT=21399

echo "[build.sh] bun run build --outDir out-qa" >&2
# Trailing args reach only the last command of the `build` script chain (electron-vite build).
bun run build -- --outDir out-qa
echo "[build.sh] done." >&2
