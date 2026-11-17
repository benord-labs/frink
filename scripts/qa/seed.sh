#!/bin/bash
# Seeds the QA app's state: wipes its profile, then writes the fixture workspace. Runs before
# every boot of an instance, so a broken fixture fails here in seconds, not after a full drive.
set -euo pipefail
. "$(dirname "$0")/env.sh"

# The wipe would pull a running instance's profile out from under it, booting or up.
if RUNNING=$(qa_running_pid); then
  echo "The QA instance on port $QA_CDP_PORT is running (boot.sh pid $RUNNING); stop it before seeding it again." >&2
  exit 1
fi

rm -rf "$QA_USER_DATA"
mkdir -p "$QA_USER_DATA" "$QA_FRINK_HOME"

cd "$(dirname "$0")/../.."

# Seed the deterministic fixture workspace (project → this checkout, two chats)
# into the fresh profile BEFORE launch — the app then boots straight into a
# populated shell instead of "No projects registered". Fail loud: a half-seeded
# profile produces confusing judge verdicts.
FRINK_HOME="$QA_FRINK_HOME" bun scripts/qa/seed-db.ts --db "$QA_USER_DATA/data/agents.db" --project-path "${QA_PROJECT_PATH:-$(pwd)}"

# Slash-command fixtures. The vendored Slack payload is the real reported case (four of its
# five templates consume $ARGUMENTS and none declares argument-hint), so mirror it when the
# operator has it staged; the rig home is its own (sc-2903) and this only ever reads.
# boot.sh points the app's FRINK_HOME here; it lives under the profile seed wipes, so these
# fixtures are rewritten every boot and never leak into the operator's real home.
APP_FRINK_HOME="$QA_FRINK_HOME"
OPERATOR_PLUGINS="$HOME/.frink/plugins"
if [ -d "$OPERATOR_PLUGINS/vendor/slack" ] && [ -f "$OPERATOR_PLUGINS/staged.json" ]; then
  mkdir -p "$APP_FRINK_HOME/.frink/plugins/vendor"
  rm -rf "$APP_FRINK_HOME/.frink/plugins/vendor/slack"
  cp -R "$OPERATOR_PLUGINS/vendor/slack" "$APP_FRINK_HOME/.frink/plugins/vendor/slack"
  cp -p "$OPERATOR_PLUGINS/staged.json" "$APP_FRINK_HOME/.frink/plugins/staged.json"
else
  echo "seed: no vendored Slack payload at $OPERATOR_PLUGINS — plugin command fixtures skipped." >&2
fi

# Frink-origin fixtures, always present so the surface stays drivable without a vendor payload:
# one consumes $ARGUMENTS and declares a hint, one takes no arguments at all.
mkdir -p "$APP_FRINK_HOME/.frink/commands"
printf '%s\n' '---' 'description: Digest a channel' 'argument-hint: "[channel names]"' '---' 'Summarise the channels in $ARGUMENTS.' \
  > "$APP_FRINK_HOME/.frink/commands/qa-digest.md"
printf '%s\n' '---' 'description: Draft my standup' '---' 'Draft my standup from today.' \
  > "$APP_FRINK_HOME/.frink/commands/qa-standup.md"
