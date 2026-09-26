import { z } from 'zod';
import type { AgentUserQuestion, TaskSignalPayload } from '../../../../shared/types/task-signal';

/**
 * States allowed from MCP `frink_task_signal` (explicit allowlist — not derived by excluding
 * from `TASK_SIGNAL_STATES`, so new enum values there do not implicitly become tool-accepted).
 */
export const TOOL_TASK_SIGNAL_STATES = [
  'done',
  'completed',
  'awaiting_input',
  'blocked',
  'partial',
  'failed',
] as const;

export type ToolTaskSignalState = (typeof TOOL_TASK_SIGNAL_STATES)[number];

export type ToolTaskSignalPayload = Omit<TaskSignalPayload, 'state'> & {
  state: ToolTaskSignalState;
};

/**
 * Canonical argument schema for the MCP `frink_task_signal` tool — the SINGLE source of truth.
 * Both the dynamic-chat MCP handler and the `canUseTool` persist path (via `parseTaskSignalInput`)
 * validate against this, so a malformed call cannot be rejected on one path while silently mutating
 * flow state on the other. `verification` must be an object: a stringified JSON (or any non-object)
 * is rejected, not coerced — otherwise a downstream condition reading `verification.*` sees
 * `undefined` from a signal the tool contract already rejected.
 */
/**
 * Parser bound on question text, shared with the SDK-translate normalizer that clips to it. Sized
 * for a question that enumerates its options inline — the shape agents actually write — because
 * this bound doubles as the DISPLAY length: the same normalized value feeds the live card, so a
 * question clipped here is a question the user is asked to answer half of.
 */
export const QUESTION_TEXT_MAX = 2000;

/**
 * A clickable question an agent attaches to an `awaiting_input` signal. `description`/`multiSelect`
 * default so an agent can pass bare `{ label }` options; the shape matches the shared
 * `AgentUserQuestion` type the renderer reuses for both this and the SDK AskUserQuestion tool.
 */
const agentUserQuestionSchema = z.object({
  question: z.string().min(1).max(QUESTION_TEXT_MAX),
  header: z.string().min(1).max(120),
  options: z
    .array(
      z.object({ label: z.string().min(1).max(200), description: z.string().max(500).default('') }),
    )
    .min(1)
    .max(20),
  multiSelect: z.boolean().default(false),
});

/**
 * The caps live here alone so the two producers of `questions` — the `frink_task_signal` tool and
 * the SDK `AskUserQuestion` translate (`buildAskUserQuestionParkSignal`) — cannot drift apart.
 * Parsing also STRIPS unknown keys, which is what keeps the SDK tool's extra per-option fields out
 * of the persisted signal.
 */
export const agentUserQuestionsSchema = z.array(agentUserQuestionSchema).max(10);

/**
 * The `frink_task_signal` tool declaration, kept beside the zod above because they are ONE
 * contract in two expressions: the JSON Schema the agent discovers, and the parser that accepts
 * what it sends. Split across files they drift, and a call that passes discovery gets rejected.
 */
export const TASK_SIGNAL_TOOL = {
  name: 'frink_task_signal',
  description:
    'Report the real outcome of the current task-linked execution. Use state="done" when the work is finished and ready for review/use; use awaiting_input / blocked / failed when that is the actual outcome. Use partial only when this run is truly ending with unfinished work, never to narrate active background work. Keep `summary` to ONE concise sentence (the outcome, or the exact input/decision you need) — it is shown at-a-glance in the work queue; put long context in `details`.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      state: {
        type: 'string',
        enum: ['done', 'completed', 'awaiting_input', 'blocked', 'partial', 'failed'],
        description: 'Task signal state',
      },
      summary: {
        type: 'string',
        description:
          'ONE concise sentence: the outcome, or the exact input/decision you need from the user. This is the at-a-glance line shown in the work queue — keep it short; put long context in `details`.',
      },
      details: {
        type: 'string',
        description:
          'Optional longer context — the full plan, reasoning, or background. Shown on expand / audit, never as the at-a-glance line. Put essays here, not in `summary`.',
      },
      verification: {
        type: 'object',
        description:
          'Optional structured verification data for downstream flow steps (e.g. { shouldProceed: true } for a condition reading verification.shouldProceed). MUST be a JSON object literal, NOT a stringified JSON string.',
      },
      questions: {
        type: 'array',
        // Bounds MIRROR the zod in frink-task-signal.ts (parseTaskSignalInput): one contract, so a call that passes discovery is never rejected by the parser.
        // `question` is the one INEQUALITY, in the safe direction: the parser accepts QUESTION_TEXT_MAX,
        // this advertises less. A maxLength reads to a model as an authoring hint, and on THIS producer
        // — the one Frink steers — a short question with the detail in per-option `description` is the
        // shape that renders well. The larger parser bound exists for the SDK AskUserQuestion path,
        // which never reads this declaration.
        maxItems: 10,
        description:
          'OPTIONAL, only with state="awaiting_input": present the user clickable choices instead of writing options as prose. The user pick resumes you as a follow-up message. Omit when you need free-form input.',
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              minLength: 1,
              maxLength: 500,
              description:
                'The complete question to ask the user, in plain language — shown as the main question line above the options, and the key the chosen answer is mapped back under. Write a full sentence, never an identifier/slug.',
            },
            header: {
              type: 'string',
              minLength: 1,
              maxLength: 120,
              description: 'Short label/topic chip for this question (not the question itself).',
            },
            options: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', minLength: 1, maxLength: 200 },
                  description: { type: 'string', maxLength: 500 },
                },
                required: ['label'],
              },
            },
            multiSelect: {
              type: 'boolean',
              description: 'Allow multiple picks (default false).',
            },
          },
          required: ['question', 'header', 'options'],
        },
      },
    },
    required: ['state', 'summary'],
  },
} as const;

const taskSignalArgsSchema = z.object({
  state: z.enum(TOOL_TASK_SIGNAL_STATES),
  summary: z.string().min(1),
  details: z.string().optional(),
  verification: z.record(z.string(), z.unknown()).optional(),
  // Fully loose here (accepts ANY shape, even a non-array): the array shape + count + per-question
  // validation happen in parseTaskSignalInput, ONLY for awaiting_input. So a stray/malformed
  // `questions` (object, string, bad items) on a done/failed signal is ignored, never a hard parse
  // failure that would block task completion.
  questions: z.unknown().optional(),
});

const codexTaskStopGuardArgsSchema = z.object({ stop_hook_active: z.boolean() });
const CODEX_TASK_STOP_BLOCK_RESULT = JSON.stringify({
  decision: 'block',
  reason:
    'This task stopped without reporting its outcome. If work is complete, blocked, or needs input, call frink_task_signal. If provider work is still live, keep waiting; never report partial merely to narrate an active wait.',
});
type CodexTaskStopGuardArgs = { stop_hook_active?: unknown };

export function buildCodexTaskStopGuardResult(
  input: CodexTaskStopGuardArgs,
  signalRequired: boolean,
) {
  const parsed = codexTaskStopGuardArgsSchema.safeParse(input);
  if (!parsed.success) {
    return { text: `Invalid arguments: ${parsed.error.message}`, isError: true };
  }
  const text =
    signalRequired && !parsed.data.stop_hook_active ? CODEX_TASK_STOP_BLOCK_RESULT : '{}';
  return { text, isError: false };
}

export function parseTaskSignalInput(input: unknown): ToolTaskSignalPayload | null {
  const parsed = taskSignalArgsSchema.safeParse(input);
  if (!parsed.success) return null;
  const summary = parsed.data.summary.trim();
  if (!summary) return null;
  const details = parsed.data.details?.trim() ? parsed.data.details : undefined;
  // Clickable choices are only meaningful on a pause. The array shape + count are validated ONLY for
  // awaiting_input and dropped silently if malformed (the task still parks, just without options) —
  // a stray `questions` on any other state is ignored entirely, never failing the signal.
  let questions: AgentUserQuestion[] | undefined;
  if (parsed.data.state === 'awaiting_input') {
    const validated = agentUserQuestionsSchema.safeParse(parsed.data.questions);
    if (validated.success && validated.data.length) questions = validated.data;
  }
  return {
    state: parsed.data.state,
    summary,
    ...(details ? { details } : {}),
    ...(parsed.data.verification ? { verification: parsed.data.verification } : {}),
    ...(questions ? { questions } : {}),
    at: new Date().toISOString(),
  };
}

/**
 * Plan mode's terminal artifact is the PLAN (submitted via ExitPlanMode), so a plan-mode agent may
 * only PARK: `awaiting_input` records a question and pauses the flow, every terminal state is
 * refused. Without this a plan agent could terminalize its task instead of producing a plan, and
 * under auto-approve (`skipReview`) a `done` would advance the node with no plan at all.
 *
 * `terminalsLocked` means "plan restrictions are still in force" — plan mode AND the plan has not
 * been submitted yet. It must NOT be derived from the registered execution mode: after
 * ExitPlanMode an auto-approved node implements in-turn and has to signal a real `done` to
 * advance, while the recorded mode still reads `plan`.
 *
 * Returns the refusal message, or null when the signal is allowed through.
 */
export function refusePlanModeTerminalSignal(
  state: ToolTaskSignalState,
  terminalsLocked: boolean,
): string | null {
  if (!terminalsLocked || state === 'awaiting_input') return null;
  return (
    `frink_task_signal state="${state}" is unavailable in plan mode — the plan itself is this run's ` +
    'terminal artifact, so finish by submitting it with ExitPlanMode. Only state="awaiting_input" is ' +
    'accepted here: use it to ask the user something (attach `questions` for clickable options) and ' +
    'the flow parks until they answer. Park BEFORE submitting the plan, never after.'
  );
}

/**
 * Turn-level inverse of {@link refusePlanModeTerminalSignal}: whether this turn must END with a
 * terminal signal, i.e. whether the Stop hook should chase an agent that stopped without one.
 *
 * Plan DRAFTING owes nothing — ExitPlanMode is its terminal artifact, and demanding a signal there
 * deadlocks an agent legitimately paused mid-plan. The exception is an auto-approve flow node:
 * once its plan card is emitted it keeps implementing in the SAME turn while the registered mode
 * still reads `plan`, so that turn ends owing a real `done` like any agent turn.
 *
 * `planTerminalsLocked` leads deliberately — it also covers a mid-turn EnterPlanMode from agent
 * mode, which `planMode` (fixed at turn start) cannot see. An auto-approve node that never calls
 * ExitPlanMode stays locked and is never chased; its plan never existed, so there is nothing to
 * signal about.
 */
export function turnOwesTerminalSignal(
  /** The turn's registered mode is `plan` — fixed at turn START, so it cannot see a mid-turn flip. */
  planMode: boolean,
  /** Flow agent node with autoApprove/skipReview — no human gate, so it implements in-turn. */
  planAutoApprove: boolean,
  /**
   * Read LIVE from the active turn (the stream flips it on EnterPlanMode / ExitPlanMode), which is
   * what lets this see a state `planMode` never can. Callers pair a live lock with turn-start
   * `planMode`/`planAutoApprove` constants; that stays sound across the wake pump because every
   * burst context INHERITS the arming turn's lock (armWakePump's onBurstStart) — a plan-drafting
   * wait's bursts keep terminals refused, and the constants remain the arming execute's own.
   */
  turn: { planTerminalsLocked: boolean },
): boolean {
  return !turn.planTerminalsLocked && (!planMode || planAutoApprove);
}

const NEEDS_ATTENTION_SIGNAL_STATES = new Set<TaskSignalPayload['state']>([
  'awaiting_input',
  'blocked',
  'partial',
  'missing_completion_signal',
]);

function normalizeTaskResult(result: unknown): Record<string, unknown> {
  return typeof result === 'object' && result != null ? (result as Record<string, unknown>) : {};
}

function isLeaseExpiredFailureResultParsed(parsedResult: unknown): boolean {
  const record = normalizeTaskResult(parsedResult);
  if (record.failureCode === 'EXECUTION_LEASE_EXPIRED') {
    return true;
  }
  const staleExecution = record.staleExecution;
  if (staleExecution !== true) {
    return false;
  }
  const error = record.error;
  return typeof error === 'string' && error.includes('Execution lease expired');
}

export function canApplyTaskSignalForStatus(task: { status: string; result: unknown }): boolean {
  if (task.status === 'running') {
    return true;
  }
  if (task.status !== 'failed') {
    return false;
  }
  return isLeaseExpiredFailureResultParsed(task.result);
}

function resolveTaskDoneStatus(task: { result: unknown }): 'done' | 'plan_ready' {
  const resultRecord = normalizeTaskResult(task.result);
  const startMode = resultRecord.startMode;
  if (startMode === 'plan' && resultRecord.skipReview !== true) {
    return 'plan_ready';
  }
  return 'done';
}

/**
 * Applies persisted `agentSignal` transitions. Accepts full `TaskSignalPayload` so internal
 * paths can pass synthetic states (e.g. `missing_completion_signal`); MCP tool input must
 * first pass `parseTaskSignalInput` and therefore only `ToolTaskSignalState` values.
 */
export function resolveTaskSignalTransition(
  task: { result: unknown },
  signal: TaskSignalPayload,
): {
  status: 'needs_attention' | 'failed' | 'plan_ready' | 'done' | 'completed';
  result: Record<string, unknown>;
} {
  const currentResult = normalizeTaskResult(task.result);
  const {
    error: _ignoredError,
    failureCode: _ignoredFailureCode,
    staleExecution: _ignoredStaleExecution,
    staleDetectedAt: _ignoredStaleDetectedAt,
    lastHeartbeatAt: _ignoredLastHeartbeatAt,
    usageLimit: _ignoredUsageLimit,
    apiError: _ignoredApiError,
    // A genuine agent signal supersedes a user pause — a stale userPause marker would make the
    // renderer classify this park as "paused by user" and hide the agent's question card.
    userPause: _ignoredUserPause,
    // Any recorded signal supersedes a quiet-end marker — a survivor would let the quiet-idle
    // sweep park a turn that has already signaled (see markLinkedTaskQuietEnd).
    quietEndedAt: _ignoredQuietEndedAt,
    ...resultWithoutStaleFailureMeta
  } = currentResult;
  // A stray agent `completed` is coerced to a done-class status below; normalize the STORED signal to
  // match so downstream readers of `agentSignal.state` (e.g. resolveAutoCompletionAction) don't treat
  // the run as auto-completable and skip the review gate.
  const normalizedSignal: TaskSignalPayload =
    signal.state === 'completed' ? { ...signal, state: 'done' } : signal;
  const nextResult: Record<string, unknown> = {
    ...resultWithoutStaleFailureMeta,
    agentSignal: normalizedSignal,
  };

  if (NEEDS_ATTENTION_SIGNAL_STATES.has(signal.state)) {
    return {
      status: 'needs_attention',
      result: nextResult,
    };
  }

  if (signal.state === 'failed') {
    return {
      status: 'failed',
      result: {
        ...nextResult,
        error: signal.details ?? signal.summary,
      },
    };
  }

  // `completed` is no longer an agent-FACING choice — agents are guided to signal `done` only and
  // the flow engine owns closing the run. A stray agent `completed` (LLMs may still emit it) is
  // COERCED to `done` by falling through here, so it stays reviewable + sidebar-tracked rather than
  // archiving/de-tracking a mid-flow step. (`completed` remains a valid engine-set tasks.status.)
  const doneStatus = resolveTaskDoneStatus(task);
  return {
    status: doneStatus,
    result: nextResult,
  };
}

export function buildManualConfirmationResult(
  latestResult: unknown,
  details?: string,
  at = new Date().toISOString(),
): Record<string, unknown> {
  const { usageLimit: _ignoredUsageLimit, ...result } = normalizeTaskResult(latestResult);
  return {
    ...result,
    agentSignal: {
      state: 'manual_confirmation',
      summary: 'User responded to AskUserQuestion',
      ...(details ? { details } : {}),
      at,
    },
  };
}
