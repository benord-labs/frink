# Shared constants for the QA rig (sourced by seed.sh and boot.sh — never run).
# seed.sh wipes/stamps these paths and boot.sh launches/tears down against them;
# a value drifting between the two scripts corrupts the other's state, so both
# MUST source this file instead of redeclaring.

# macOS-only: QA_USER_DATA below is the mac Electron userData path, and the
# whole QA rig (keychain-encrypted secrets, the QA host) lives on the mac.
if [ "$(uname)" != "Darwin" ]; then
  echo "scripts/qa is macOS-only (userData path + keychain)." >&2
  exit 1
fi

QA_HOME="$HOME/.frink-qa"
# FRINK_QA_PORT names one more rig instance, so worktrees can each run one at once: it is that
# instance's DevTools port and, as "Frink Dev-<port>", its profile. Unset is the default instance.
QA_CDP_PORT=9223
QA_PROFILE_PORT=21399
LOCK="$QA_HOME/lock.d"
if [ -n "${FRINK_QA_PORT:-}" ]; then
  # Only a plain port the app would also name the profile by; the reserved ones are the default
  # instance's (9223, 21399) and the dev and shipped apps' own (9222, 21322, 21321).
  case "$FRINK_QA_PORT" in
    9222 | 9223 | 21321 | 21322 | 21399) FRINK_QA_PORT= ;;
    [1-9][0-9][0-9][0-9] | [1-9][0-9][0-9][0-9][0-9])
      [ "$FRINK_QA_PORT" -ge 1024 ] && [ "$FRINK_QA_PORT" -le 65535 ] || FRINK_QA_PORT= ;;
    *) FRINK_QA_PORT= ;;
  esac
  if [ -z "$FRINK_QA_PORT" ]; then
    echo "FRINK_QA_PORT must be a free port from 1024 to 65535 that is not 9222, 9223, 21321, 21322 or 21399." >&2
    exit 1
  fi
  QA_CDP_PORT=$FRINK_QA_PORT
  QA_PROFILE_PORT=$FRINK_QA_PORT
  LOCK="$QA_HOME/lock-$FRINK_QA_PORT.d"
fi
# The literal prefix is on purpose: nothing a caller sets can widen seed.sh's rm -rf target.
QA_USER_DATA="$HOME/Library/Application Support/Frink Dev-$QA_PROFILE_PORT"
# The app's own state root (mcp/config.json, credentials, plugins, …): rig-owned, never the
# operator's ~/.frink (sc-2903). Under $QA_USER_DATA so the profile wipe resets it; seed.sh writes
# the seeded MCP config here and boot.sh hands it to the app as FRINK_HOME.
QA_FRINK_HOME="$QA_USER_DATA/home"
