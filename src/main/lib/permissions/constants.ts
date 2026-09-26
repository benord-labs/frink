/** Single source of truth for how long ANY user-facing permission/approval
 *  prompt waits before auto-denying. 9.5 min — long enough that a user away
 *  from the keyboard still gets to answer; short enough to free a stuck agent.
 *
 *  Keep it below 10 min for the PreToolUse path: the CLI aborts a hook after
 *  600s and then feeds the model its own canned "The user doesn't want to take
 *  this action", discarding the deny reason the hook was about to return. That
 *  path is the one where our wording still reaches the model, so it is the one
 *  the margin is for.
 *
 *  It buys NOTHING on the canUseTool path, where the CLI discards a deny message
 *  unconditionally and substitutes the canned refusal at any timing (measured:
 *  the refusal arrived at 570s, under the ceiling). That is why an AskUserQuestion
 *  expiry no longer answers the call at all — see
 *  `docs/decisions/agent-user-question-mechanism.md`.
 *
 *  Main-process only by design (not src/shared) — these timeouts gate Electron
 *  prompts and socket requests, never the vercel `_shared` surface. */
export const PERMISSION_PROMPT_TIMEOUT_MS = 9.5 * 60 * 1000;
