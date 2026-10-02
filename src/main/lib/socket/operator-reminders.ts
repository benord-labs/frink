/**
 * Operator reminders injected mid-conversation — mode-exit transitions (plan→agent, debug→other) and
 * the disarmed task-signal notice. These are delivered as an IN-CONVERSATION SYSTEM PROMPT, NOT as
 * hand-rolled `<system-reminder>` user-turn text:
 *  - Claude path → the SDK's `UserPromptSubmit` hook ({@link buildUserPromptSubmitReminderHook}); the
 *    CLI emits a real `{role:"system"}` message (or its own reminder rendering) per model.
 *  - Codex → no in-conversation system-prompt channel yet (tracked: sc-996); prepend as text
 *    ({@link wrapRemindersForPrompt}), its only current option.
 *
 * Extracted from `executor.ts` to keep that file small and make the gating logic unit-testable in
 * isolation (see `operator-reminders.test.ts`).
 */
import log from 'electron-log';
import { PLAN_MODE_NO_FINISH_SIGNAL } from '../../../shared/lib/task-agent-lifecycle-prompt';
import { TOOL_TASK_SIGNAL_STATES } from '../trpc/routers/frink-task-signal';

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

/** The flow step a person's message landed on, read BEFORE the follow-up resume scrubs its signal. */
export type HumanInterjectionContext = {
  stepTitle: string | null;
  /** Task status at turn start, e.g. `needs_attention` (parked) or `running`. */
  priorStatus: string | null;
  /** State of the step's last `frink_task_signal`, or null when it has none the agent could send. */
  priorSignalState: string | null;
  /** The quiet-idle sweep parked it for ending silently (a synthetic, non-sendable state). */
  endedWithoutSignal?: boolean;
  /** A plan turn ends with ExitPlanMode, not a terminal signal. */
  isPlanMode?: boolean;
};

/** Marks a message a person typed into a Flow step's chat (sc-3214), and what a new signal does now
 * that the follow-up resumed the step (`flow-park-answer-surface`) and cleared its old one. */
export function buildHumanInterjectionReminder(ctx: HumanInterjectionContext): string {
  const step = ctx.stepTitle ? `the flow step "${ctx.stepTitle}"` : 'the current flow step';
  // Only a parked row is resumed by a follow-up (resumeParkedTaskInPlace); a running one is not.
  const wasParked = ctx.priorStatus === 'needs_attention' || ctx.priorStatus === 'failed';
  const before = !ctx.priorSignalState
    ? wasParked && ctx.endedWithoutSignal
      ? 'It was parked because it ended without a signal; this message resumed the step.'
      : 'No signal is recorded for it yet.'
    : wasParked
      ? `It was parked after signalling \`${ctx.priorSignalState}\`; this message resumed the step, so that signal no longer stands.`
      : `It last signalled \`${ctx.priorSignalState}\`, and this turn still owes its own signal.`;
  const resend = ctx.priorSignalState
    ? `re-send \`${ctx.priorSignalState}\` if it still holds, or the state their input now warrants`
    : 'with the state that reflects the outcome';
  const provenance = `This message was typed by a person in this chat. It is NOT the next flow step, and it does not end the flow — you are still inside ${step}.`;
  if (ctx.isPlanMode) {
    return `${provenance} Take their input into the plan, then finish by submitting it with ExitPlanMode as usual.`;
  }
  return [
    provenance,
    before,
    `Answer the person (act on it if they asked for something), then call frink_task_signal for this step: ${resend}.`,
    'A new signal replaces the earlier one; the flow advances at most once per step, so it is never double-counted.',
  ].join(' ');
}

/**
 * Read the step context from the turn-start task row — the snapshot taken BEFORE the follow-up
 * resume scrubs `agentSignal`, so the agent learns what it had signalled.
 */
export function humanInterjectionFromTask(
  task: { title?: string | null; status?: string | null; result?: unknown },
  isPlanMode: boolean,
): HumanInterjectionContext {
  const result = task.result && typeof task.result === 'object' ? task.result : {};
  const signal = (result as { agentSignal?: unknown }).agentSignal;
  const state =
    signal && typeof signal === 'object' ? (signal as { state?: unknown }).state : undefined;
  // Only echo a state the agent can send back; a synthetic park state would be refused by the tool.
  const sendable = (TOOL_TASK_SIGNAL_STATES as readonly unknown[]).includes(state);
  return {
    stepTitle: task.title || null,
    priorStatus: task.status ?? null,
    priorSignalState: sendable ? (state as string) : null,
    endedWithoutSignal: typeof state === 'string' && !sendable,
    isPlanMode,
  };
}

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
  /** Set only when a person typed this turn into a chat an armed Flow step drives. */
  humanInterjection?: HumanInterjectionContext | null;
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
  if (inputs.humanInterjection) {
    reminders.push(buildHumanInterjectionReminder(inputs.humanInterjection));
  }
  return { reminders, isExitingDebugMode };
}

/**
 * Codex fallback (sc-996): wrap reminders as `<system-reminder>` text for prompt prepend, since
 * that runtime has no in-conversation system-prompt channel.
 */
export function wrapRemindersForPrompt(reminders: string[]): string {
  return reminders
    .map((reminder) => `<system-reminder>\n${reminder}\n</system-reminder>`)
    .join('\n\n');
}

/**
 * Claude path: the UserPromptSubmit callback that injects `reminders` as an in-conversation system
 * message; session-callbacks.ts delegates to it per turn.
 */
export function buildUserPromptSubmitReminderHook(reminders: string[]) {
  const additionalContext = reminders.join('\n\n');
  return async () => ({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit' as const, additionalContext },
  });
}

export type TurnReminderInputs = Omit<OperatorReminderInputs, 'humanInterjection'> & {
  /** Turn-start row of the Flow step a person typed into (sc-3214), else null. Read BEFORE the
   * follow-up resume scrubs its agentSignal. */
  interjectedTask: Parameters<typeof humanInterjectionFromTask>[0] | null;
  agentRuntime: string;
  subChatId: string;
  prompt: string;
};

/** This turn's reminders per runtime: Claude's ride the UserPromptSubmit hook (caller hands
 * `reminders` to the turn); Codex has no such channel (sc-996), so they are prepended to `prompt`. */
export function prepareTurnReminders(inputs: TurnReminderInputs): OperatorReminderResult & {
  prompt: string;
} {
  const { interjectedTask, agentRuntime, subChatId } = inputs;
  const result = buildOperatorReminders({
    ...inputs,
    humanInterjection: interjectedTask
      ? humanInterjectionFromTask(interjectedTask, inputs.mode === 'plan')
      : null,
  });
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
