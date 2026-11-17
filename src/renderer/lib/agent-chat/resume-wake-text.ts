/** The continuation prompt behind the paused bar's Resume, sent behind HIDDEN_WAKE_MARKER so no
 * bubble shows. Like `buildRetryContinuationPrompt`, it asks the agent to re-derive what remains. */

/** User pressed Pause, then Resume. The process stayed alive, so nothing is half-applied. */
export const RESUME_PAUSED_WAKE_TEXT =
  'The user paused this flow and pressed Resume. The session has been resumed. Re-read the conversation and your todo state, work out what remains, and continue from there.';
