# Shared constants for the QA rig (sourced by seed.sh and boot.sh — never run).
# seed.sh wipes/stamps these paths and boot.sh launches/tears down against them;
# a value drifting between the two scripts corrupts the other's state, so both
# MUST source this file instead of redeclaring.

# macOS-only: QA_USER_DATA below is the mac Electron userData path, and the
# whole QA rig (keychain-encrypted secrets, qavis host) lives on the mac.
if [ "$(uname)" != "Darwin" ]; then
  echo "scripts/qa is macOS-only (userData path + keychain)." >&2
  exit 1
fi

QA_HOME="$HOME/.frink-qa"
LOCK="$QA_HOME/lock.d"
# Hardcoded literal on purpose: an unset/empty variable must never be able to
# widen seed.sh's rm -rf target.
QA_USER_DATA="$HOME/Library/Application Support/Frink Dev-21399"
# The app's own state root (mcp/config.json, credentials, plugins, …): rig-owned, never the
# operator's ~/.frink (sc-2903). Under $QA_USER_DATA so the profile wipe resets it; seed.sh writes
# the seeded MCP config here and boot.sh hands it to the app as FRINK_HOME.
QA_FRINK_HOME="$QA_USER_DATA/home"
