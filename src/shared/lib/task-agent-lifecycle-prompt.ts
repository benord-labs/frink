/**
 * Plan-mode variant for the local Claude Code path: Claude drafts the plan and submits it
 * through its native ExitPlanMode workflow.
 */
/** The one plan-mode duty the CLI's own plan reminder does not state. */
export const PLAN_MODE_NO_FINISH_SIGNAL =
  "Do NOT call `frink_task_signal` to FINISH: the plan is this run's terminal artifact, so ExitPlanMode is the only way to end it. states done/partial/failed/blocked are refused here.";

export const CLAUDE_PLAN_MODE_LIFECYCLE_BLOCK = [
  'Task lifecycle (plan mode):',
  '- You are in PLAN MODE: when you intend to propose work, draft the plan and submit it through your native plan workflow (ExitPlanMode); otherwise reply normally for clarifications.',
  '- Do NOT edit code/files in plan mode. The plan awaits user approval before any execution.',
  `- ${PLAN_MODE_NO_FINISH_SIGNAL}`,
].join('\n');

/**
 * Flow-only addendum describing what `AskUserQuestion` DOES here: inside a Flow the executor
 * translates the call into an `awaiting_input` park instead of running the (blocking) tool, so the
 * run pauses on the question rather than stalling unattended.
 *
 * Deliberately states no rule the agent can read as licence to skip asking. An earlier version
 * closed with "park only when picking wrong would waste the work", and agents quoted that line back
 * while deciding unilaterally — the restraint now lives inside *when* to ask, not as its own clause.
 * Attended plan chats do NOT get this block: there the tool runs for real as a live prompt.
 */
export const FLOW_PLAN_MODE_QUESTION_BLOCK = [
  'Asking the user (plan mode, inside a Flow):',
  '- `AskUserQuestion` parks the Flow: the run pauses on your question, the user picks an option, and you resume still in plan mode. Use it whenever you genuinely cannot decide — a plan built on a guessed requirement wastes the whole run.',
  '- Ask BEFORE submitting the plan, never after — once ExitPlanMode is called the turn is over.',
].join('\n');

/**
 * Appended when the flow node auto-approves its plan (`autoApprove`/`skipReview`): no human reads
 * the plan and the agent implements straight from it, so the plan-approval step it would otherwise
 * treat as a review checkpoint does not exist.
 *
 * Appended LAST, so it governs where it contradicts the two blocks above: for this node alone,
 * ExitPlanMode does NOT end the run — the implementation continues in the same turn and the run
 * ends on THAT, so the terminal states those blocks call refused are reachable after submission.
 * Without this the agent is told not to signal, ends quiet, and the node hangs until the
 * 45-minute idle sweep parks it.
 *
 * Deliberately does NOT restate which state to send or what `done` means: the frink_task_signal
 * tool description is the single source for that. Saying it twice invites the agent to read "done"
 * as "done implementing the plan" rather than "the node's work is complete".
 */
export const FLOW_PLAN_AUTO_APPROVE_BLOCK = [
  'Note: this plan auto-approves — no one will review it before you implement it. State your assumptions explicitly in the plan rather than relying on an approval step to catch them.',
  'Because of that, this node overrides the two rules above once you submit: ExitPlanMode does NOT end this run — you keep going and implement the plan in this same turn, and the run ends on that implementation rather than on the plan.',
  '- Before submitting the plan, state="awaiting_input" is still the only signal available to you.',
].join('\n');
