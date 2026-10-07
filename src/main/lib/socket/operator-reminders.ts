/** Existing mode/availability reminders: Claude hook context, or legacy Codex prompt text.
 * Per-delivery message provenance uses its own runtime adapters. */
import log from 'electron-log';
import { PLAN_MODE_NO_FINISH_SIGNAL } from '../../../shared/lib/task-agent-lifecycle-prompt';

// Worded to be unconditionally TRUE for any agent-mode turn: it fires on unknown history too
// (previousMode is an in-memory map, wiped by app restart and skipped by error-path turns), so it
// must assert nothing about what the transcript actually contains.
export const PLAN_MODE_EXIT_REMINDER =
  'Plan mode is not active. If any earlier "Plan mode is active" reminders appear in this conversation, they no longer apply — you can make edits, run tools, and take actions.';

export const DEBUG_MODE_EXIT_REMINDER =
  'You have exited debug mode. You are no longer in DEBUG MODE. Disregard any earlier "DEBUG MODE" instructions in this conversation — they no longer apply. If there is any remaining debug instrumentation in the code, clean it up now (remove all // #region debug log blocks).';

// Disarmed: the chat's pinned task is terminal-final or gone, so frink_task_signal and the lifecycle
// prompt are stripped. On a follow-up turn the agent still has the original armed instructions in its
// history/transcript and may reach for the now-absent tool — this tells it the tool is intentionally
// gone instead of letting it invent a reason. A notice only; it does not re-arm.
export const TASK_SIGNAL_DISARMED_REMINDER =
  'This chat is linked to a task whose lifecycle is already over (it finished, or the task no longer exists), so the frink_task_signal tool is intentionally not available this turn. If you called it earlier in this conversation, that was a prior active run — there is nothing left to signal now. Only frink_task_signal is unavailable; your other tools (Bash, Read, Write, Edit, MCP tools, etc.) remain available — handle the user request normally, just do not look for or attempt to call frink_task_signal.';

export type OperatorReminderInputs = {
  /** Current turn mode (e.g. 'plan' | 'debug' | 'agent'). */
  mode: string;
  /** The mode this sub-chat last ran in, or undefined on a first turn. */
  previousMode: string | undefined;
  /** Whether the SDK session is being resumed — i.e. a prior transcript exists to correct. */
  hasResumeSession: boolean;
  /** Whether the task-signal apparatus is disarmed (pinned task terminal-final or gone). */
  taskSignalDisarmed: boolean;
  /**
   * Whether the agent can see prior turns that referenced the now-stripped tool — a replayed SDK
   * transcript (resume) or frink's inlined `<conversation_history>`. A fresh first turn has nothing to
   * correct, so the disarmed notice would be vacuous.
   */
  agentSawPriorTurns: boolean;
  /** A plan turn with a live task to signal, outside a Flow run (whose prompt states the duty). */
  planOwesNoFinishSignal: boolean;
};

export type OperatorReminderResult = {
  /** Reminder texts to inject this turn (may be empty). */
  reminders: string[];
  /** True when this turn exits debug mode — the caller runs the debug-session cleanup side effect. */
  isExitingDebugMode: boolean;
};

/**
 * Decide which operator reminders apply this turn. Pure: the caller owns delivery (Claude hook vs
 * Codex prepend) and the debug-session cleanup side effect (signalled via `isExitingDebugMode`).
 */
export function buildOperatorReminders(inputs: OperatorReminderInputs): OperatorReminderResult {
  const reminders: string[] = [];
  // Plan→non-plan: the resumed transcript still holds the SDK's own "Plan mode is active"
  // reminder, and debug turns act too (their permissionMode is default/auto, never 'plan'), so
  // every non-plan mode gets the rebuttal. `previousMode === undefined` (unknown history — the
  // tracking map is in-memory, wiped by app restart, and only written on a turn's success path)
  // also fires: the wording is true regardless, and skipping it is how restart-resumed turns
  // parroted stale plan reminders.
  if (
    inputs.mode !== 'plan' &&
    (inputs.previousMode === 'plan' || inputs.previousMode === undefined) &&
    inputs.hasResumeSession
  ) {
    reminders.push(PLAN_MODE_EXIT_REMINDER);
  }
  // Debug→other: tell the agent debug mode ended (caller also cleans up the ingest debug session).
  const isExitingDebugMode =
    inputs.mode !== 'debug' && inputs.previousMode === 'debug' && inputs.hasResumeSession;
  if (isExitingDebugMode) {
    reminders.push(DEBUG_MODE_EXIT_REMINDER);
  }
  // Skip in plan mode: it's read-only (no Bash/Write/Edit), so the reminder's "other tools remain
  // available" wording would mislead.
  if (inputs.taskSignalDisarmed && inputs.agentSawPriorTurns && inputs.mode !== 'plan') {
    reminders.push(TASK_SIGNAL_DISARMED_REMINDER);
  }
  // Per turn rather than in the system prompt, so the prompt (and a warm CLI) stays mode-free.
  if (inputs.planOwesNoFinishSignal) reminders.push(PLAN_MODE_NO_FINISH_SIGNAL);
  return { reminders, isExitingDebugMode };
}

/**
 * Codex fallback (sc-996): wrap reminders as `<system-reminder>` text for prompt prepend, since
 * retained independently of the native channel used for message provenance.
 */
export function wrapRemindersForPrompt(reminders: string[]): string {
  return reminders
    .map((reminder) => `<system-reminder>\n${reminder}\n</system-reminder>`)
    .join('\n\n');
}

/**
 * Claude path: the UserPromptSubmit callback that injects `reminders` as an in-conversation system
 * context attachment; the CLI chooses system-role or reminder rendering per model.
 */
export function buildUserPromptSubmitReminderHook(reminders: string[]) {
  const additionalContext = reminders.join('\n\n');
  return async () => ({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit' as const, additionalContext },
  });
}

export type TurnReminderInputs = OperatorReminderInputs & {
  agentRuntime: string;
  subChatId: string;
  prompt: string;
};

/** Existing reminder delivery stays unchanged: a Claude hook or Codex prompt prepend. */
export function prepareTurnReminders(inputs: TurnReminderInputs): OperatorReminderResult & {
  prompt: string;
} {
  const { agentRuntime, subChatId } = inputs;
  const result = buildOperatorReminders(inputs);
  let prompt = inputs.prompt;
  if (result.reminders.length > 0) {
    if (agentRuntime !== 'claude')
      prompt = `${wrapRemindersForPrompt(result.reminders)}\n\n${prompt}`;
    const via = agentRuntime === 'claude' ? 'UserPromptSubmit hook' : 'prompt prepend';
    log.info(
      `[Socket Executor] ${result.reminders.length} operator reminder(s) for ${subChatId} via ${via}`,
    );
  }
  return { ...result, prompt };
}
