/**
 * The continuation prompts behind the chat's two Resume affordances. Both ride the shared
 * HIDDEN_WAKE_MARKER, so the user never sees a bubble — only the agent waking up.
 *
 * They live here rather than beside either component because the two surfaces sit in different
 * feature folders and may only import each other through a barrel. Shape follows the main process's
 * `buildRetryContinuationPrompt`: state what stopped, then ask the agent to RE-DERIVE what remains
 * rather than "continue where you left off" — after session compaction the done/remaining split may
 * be gone. The task-signal tail is load-bearing: a flow only advances on the agent's `done`.
 */

/** User pressed Pause, then Resume. The process stayed alive, so nothing is half-applied. */
export const RESUME_PAUSED_WAKE_TEXT =
  'The user paused this flow and pressed Resume. The session has been resumed. Re-read the conversation and your todo state, work out what remains, and continue from there.';

/**
 * An app restart killed the agent mid-turn. Unlike a pause, the process died where it stood, so the
 * extra warnings are the point: a tool call with no result never completed, and a write it belonged
 * to may be half-applied. Verifying disk state before continuing is what stops the agent from
 * building on work it only THINKS it finished.
 */
export const RESUME_INTERRUPTED_WAKE_TEXT =
  'This flow run was interrupted by an app restart, so your previous turn stopped mid-step. The session has been resumed. Any tool call that never returned a result did NOT complete, and files it was writing may be half-applied — re-read the conversation and your todo state, verify what actually landed on disk, work out what remains, and continue from there. Finish with your task signal as usual.';
