/**
 * Pure translation: local Task row outcome → flow NodeOutput.
 *
 * Runs against the local Drizzle Task type. Stateless — DB writes, advanceFlowRun
 * calls, and orphan recovery live elsewhere (`task-completion-watcher.ts`).
 */

import type { NodeOutput } from '../../../shared/types/flow';
import { TASK_SIGNAL_STATES, type TaskSignalState } from '../../../shared/types/task-signal';
import type { Task } from '../db/schema';

const SIGNAL_SET = new Set<string>(TASK_SIGNAL_STATES);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

type ParsedSignal = {
  state: TaskSignalState;
  summary?: string;
  details?: string;
  verification?: Record<string, unknown>;
};

function parseAgentSignal(result: unknown): ParsedSignal | null {
  if (!isRecord(result)) return null;
  const agentSignal = result.agentSignal;
  if (!isRecord(agentSignal)) return null;
  const state = agentSignal.state;
  if (typeof state !== 'string' || !SIGNAL_SET.has(state)) return null;
  return {
    state: state as TaskSignalState,
    summary: typeof agentSignal.summary === 'string' ? agentSignal.summary : undefined,
    details: typeof agentSignal.details === 'string' ? agentSignal.details : undefined,
    verification: isRecord(agentSignal.verification) ? agentSignal.verification : undefined,
  };
}

function readExitCode(result: unknown): number | null {
  if (!isRecord(result)) return null;
  const exit = result.exitCode;
  return typeof exit === 'number' ? exit : null;
}

function readError(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  return typeof result.error === 'string' ? result.error : undefined;
}

/**
 * The start_task fallback executor writes converging-merge fields (mergeConflict,
 * conflictingBranch, conflictedFiles, mergedBranches) at the TOP LEVEL of task.result,
 * not in structured stdout — without copying them into outputs, a fallback-path
 * conflict is invisible to node_output readers (BatchMonitor run rows).
 */
const CONVERGE_MERGE_KEYS = [
  'mergeConflict',
  'conflictingBranch',
  'conflictedFiles',
  'mergedBranches',
] as const;

function readConvergeMergeFields(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) return {};
  const out: Record<string, unknown> = {};
  for (const key of CONVERGE_MERGE_KEYS) {
    if (result[key] !== undefined) out[key] = result[key];
  }
  return out;
}

/**
 * A transient park's reason rides on `result.usageLimit` / `result.apiError` rather than an
 * agentSignal. Surfacing it as the node's `outputs.summary` lets the run panel's paused-actions
 * line answer "why did my flow pause" (incl. a usage limit's reset time, or the API error text).
 * Presence of a reason is also what gives the park precedence over a signal in
 * {@link mapTaskToNodeOutput}.
 */
function readParkReasonMessage(result: unknown): string | null {
  if (!isRecord(result)) return null;
  for (const key of ['usageLimit', 'apiError'] as const) {
    const reason = result[key];
    if (isRecord(reason) && typeof reason.message === 'string') return reason.message;
  }
  return null;
}

const MAX_STDOUT_PARSE_BYTES = 1_048_576; // 1 MB — server parity guard.
const MAX_RAW_FALLBACK_BYTES = 4096; // 4 KB — server parity truncation.

function parseStructuredOutputs(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) return {};
  const out: Record<string, unknown> = {};
  if (typeof result.stdout === 'string' && result.stdout.length > 0) {
    if (result.stdout.length > MAX_STDOUT_PARSE_BYTES) {
      // Skip JSON.parse — multi-MB payload would block the Electron main thread.
      out._rawStdout = result.stdout.slice(0, MAX_RAW_FALLBACK_BYTES);
    } else {
      try {
        const parsed = JSON.parse(result.stdout);
        if (isRecord(parsed)) Object.assign(out, parsed);
      } catch {
        out._rawStdout = result.stdout.slice(0, MAX_RAW_FALLBACK_BYTES);
      }
    }
  }
  if (typeof result.exitCode === 'number') out.exitCode = result.exitCode;
  return out;
}

function computeDurationMs(startedAt: Date | null, completedAt: Date | null): number {
  if (!startedAt) return 0;
  const end = completedAt ?? new Date();
  return Math.max(0, end.getTime() - startedAt.getTime());
}

/**
 * Maps a terminal Task row → NodeOutput. Branches on agentSignal first
 * (richer state machine), falls back to status + exitCode for shell tasks.
 *
 * Status mapping:
 * - signal 'done' / 'completed' → 'completed'
 * - signal 'awaiting_input' / 'manual_confirmation' → 'awaiting_input'
 * - signal 'blocked' / 'partial' → 'blocked'
 * - signal 'failed' → 'failed'
 * - signal 'missing_completion_signal' → 'awaiting_input' (taskStatus: 'needs_attention')
 * - task status 'cancelled' → 'cancelled'
 * - task status 'completed' / 'done' → 'completed'
 * - task status 'plan_ready' / 'needs_attention' → 'awaiting_input'
 */
/**
 * Map a parsed agentSignal to its node output — the signal half of {@link mapTaskToNodeOutput},
 * split out so each mapper stays under the complexity caps.
 */
function mapSignalToNodeOutput(
  signal: NonNullable<ReturnType<typeof parseAgentSignal>>,
  result: unknown,
  outputs: Record<string, unknown>,
  durationMs: number,
  errorMessage: string | null,
): NodeOutput | null {
  // Mirror server's `baseOutputs()` — include verification when present so
  // downstream `{{prev.outputs.verification}}` template references resolve.
  const baseOutputs: Record<string, unknown> = {
    ...outputs,
    ...readConvergeMergeFields(result),
    summary: signal.summary,
    details: signal.details,
    ...(signal.verification ? { verification: signal.verification } : {}),
  };
  switch (signal.state) {
    case 'done':
    case 'completed':
      return {
        status: 'completed',
        outputs: baseOutputs,
        artifacts: [],
        durationMs,
        signal: signal.state,
      };
    case 'awaiting_input':
    case 'manual_confirmation':
      return {
        status: 'awaiting_input',
        outputs: baseOutputs,
        artifacts: [],
        durationMs,
        signal: signal.state,
      };
    case 'blocked':
    case 'partial':
      return {
        status: 'blocked',
        outputs: baseOutputs,
        artifacts: [],
        durationMs,
        signal: signal.state,
      };
    case 'failed':
      return {
        status: 'failed',
        outputs: baseOutputs,
        artifacts: [],
        durationMs,
        signal: signal.state,
        error: {
          message: signal.details ?? signal.summary ?? errorMessage ?? 'Agent task failed',
          retryable: true,
        },
      };
    case 'missing_completion_signal':
      return {
        status: 'awaiting_input',
        outputs: { ...baseOutputs, taskStatus: 'needs_attention' },
        artifacts: [],
        durationMs,
        signal: signal.state,
      };
  }
  return null;
}

export function mapTaskToNodeOutput(task: Task): NodeOutput {
  const result = task.result;
  const signal = parseAgentSignal(result);
  const outputs = parseStructuredOutputs(result);
  const durationMs = computeDurationMs(task.startedAt, task.completedAt);
  const exitCode = readExitCode(result);
  const errorMessage = readError(result);

  // A user-pause park overrides any signal recorded mid-turn: the user interrupted the turn, so a
  // stale mid-stream `done` must not advance the flow past the paused step (and a stale question
  // must not re-surface). The park writer scrubs agentSignal for user-pause, but a signal written
  // between the park's read and its CAS could still coexist — the marker wins classification.
  if (task.status === 'needs_attention' && (result as Record<string, unknown> | null)?.userPause) {
    return {
      status: 'awaiting_input',
      outputs: { ...outputs, summary: 'Paused by user' },
      artifacts: [],
      durationMs,
      // Typed marker so downstream (run_paused event → renderer sound) can
      // tell the user's own Pause from an agent park without string matching.
      userPaused: true,
    };
  }

  // Transient parks (usage limit / API error) take the same precedence, for a different reason:
  // unlike user-pause their writer KEEPS agentSignal so the resumed turn can reuse it. A `done`
  // recorded moments before the turn died on a 401 would otherwise classify this node `completed`
  // and advance the flow past a step that never finished. The park is the newer fact, so it wins
  // classification; the signal stays on the row for the resume.
  if (task.status === 'needs_attention') {
    const parkMessage = readParkReasonMessage(result);
    if (parkMessage) {
      return {
        status: 'awaiting_input',
        outputs: { ...outputs, summary: parkMessage },
        artifacts: [],
        durationMs,
      };
    }
  }

  // A cancel outranks any signal, for the same reason the parks above do: it is the newest fact
  // about the turn. The cancel writer scrubs agentSignal, but a signal written between the writer's
  // read and its CAS could still coexist — and a stale `done` classifying this node `completed`
  // would walk the flow past the very step the user stopped.
  //
  // Carry the cancel reason onto the node output so a restart interruption
  // (RESTART_INTERRUPTION_REASON) stays distinguishable from a user-initiated
  // cancel downstream (the run panel's Re-run gate keys on it).
  if (task.status === 'cancelled') {
    return {
      status: 'cancelled',
      outputs,
      artifacts: [],
      durationMs,
      ...(errorMessage ? { error: { message: errorMessage, retryable: true } } : {}),
    };
  }

  if (signal) {
    const mapped = mapSignalToNodeOutput(signal, result, outputs, durationMs, errorMessage ?? null);
    if (mapped) return mapped;
  }
  if (task.status === 'completed' || task.status === 'done') {
    return { status: 'completed', outputs, artifacts: [], durationMs };
  }
  // Parked-with-a-reason is handled above, so anything landing here carries no park marker.
  if (task.status === 'plan_ready' || task.status === 'needs_attention') {
    return { status: 'awaiting_input', outputs, artifacts: [], durationMs };
  }

  // failed / unexpected status
  const isClean = exitCode === 0;
  return {
    status: isClean ? 'completed' : 'failed',
    outputs,
    artifacts: [],
    durationMs,
    ...(isClean
      ? {}
      : {
          error: {
            message: errorMessage ?? `Task exited with code ${exitCode ?? 'unknown'}`,
            retryable: false,
          },
        }),
  };
}

const TERMINAL_TASK_STATUSES = new Set([
  'completed',
  'done',
  'failed',
  'cancelled',
  'plan_ready',
  'needs_attention',
]);

export function isTerminalTaskStatus(status: string): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}
