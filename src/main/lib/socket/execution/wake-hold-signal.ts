/**
 * A wake burst's task-signal and pending-work duties, split out of `claude-wake-hold` so the pump
 * module keeps only the pump: what a burst persists, whether the turn it belongs to has declared
 * itself finished, and how the wait it is blocked on is named to the renderer.
 */

import log from 'electron-log';
import { isInvoluntaryAbortReason } from '../../../../shared/lib/user-abort-error';
import type { TaskSignalPayload, TaskSignalState } from '../../../../shared/types/task-signal';
import type { WakeHoldState } from '../../../../shared/types/wake-hold';
import { captureMainException, captureMainMessage } from '../../sentry/init';
import type { StopPendingWork } from '../../task-stop-hook';
import { type ClaudeSession, chatFence } from '../claude-session-registry';
import type { ClaudeTurnContext } from '../claude-turn-context';
import {
  markLinkedTaskQuietEnd,
  persistLinkedTaskSignal,
} from '../../trpc/routers/frink-task-signal-persist';

/**
 * States meaning "this turn is over, and nothing it started still matters" — NARROWER than terminal.
 * `awaiting_input` ends on a follow-up that ADOPTS the live session, so ending its wait destroys the
 * work that answer resumes; `partial`/`blocked` mean work is unfinished; `failed` costs nothing to
 * exclude. NEVER derive from `TASK_SIGNAL_STATES` — `manual_confirmation` and
 * `missing_completion_signal` are written FOR the agent, and would drop every hold in the app.
 */
const WAIT_ENDING_SIGNAL_STATES: ReadonlySet<TaskSignalState> = new Set(['done', 'completed']);

/** Display labels for the SDK's background-task kinds. A Map, not an object literal: `type` is an
 * unbounded string, and an object would resolve `constructor`/`toString`/`__proto__` to inherited
 * NON-strings that slip past the `??` below and break the bounded-by-construction claim. */
const BACKGROUND_TASK_LABELS = new Map<string, string>([
  ['shell', 'Command'],
  ['subagent', 'Agent'],
  ['monitor', 'Monitor'],
  ['workflow', 'Workflow'],
]);

/**
 * Name what a wait is blocked on, for the held row.
 *
 * Publishes the task KIND only — never a task's description, command line or cron prompt. Those are
 * free text the CLI caps at 1000 chars and which routinely carry file paths and arguments, and the
 * held row has no room to render them honestly. Because every label comes from the table above or
 * the neutral fallback, the published strings are bounded by construction: `type` is documented as
 * falling back to a raw discriminant for kinds this build has never heard of, so an unknown kind
 * must not reach the UI verbatim.
 */
export function summarizePendingWork(work: StopPendingWork): WakeHoldState {
  return {
    waitingOn: [
      ...work.backgroundTasks.map(
        (task) => BACKGROUND_TASK_LABELS.get(task.type) ?? 'Background task',
      ),
      ...work.sessionCrons.map(() => 'Scheduled wake'),
    ],
  };
}

/** Causes that ALERT — an allow-list for the reason `INVOLUNTARY_ABORT_REASONS` is one
 * (shared/lib/user-abort-error.ts): the rest are free-form teardowns the user asked for. */
const ALERTING_DROP_CAUSES: ReadonlySet<string> = new Set([
  'plan submitted',
  'question-park kill',
  'session busy',
  'wake-pump-exit',
  'provider-switch',
  'non-flow successor bypassed Flow wake hold',
  'successor cannot adopt Flow wake runtime slot',
]);

/** Did frink drop this work without the user asking? Splits `<head>:<tail>` once, so a prefixed
 * cause is judged on its head and `renderer-lifecycle:renderer-reload` on its tail. */
function alertsOnDroppedWork(cause: string): boolean {
  const colon = cause.indexOf(':');
  if (colon === -1) return ALERTING_DROP_CAUSES.has(cause);
  const [head, tail] = [cause.slice(0, colon), cause.slice(colon + 1)];
  return ALERTING_DROP_CAUSES.has(head) || isInvoluntaryAbortReason(tail);
}

/** Name the teardown that dropped pending harness work: closing stdin kills every backgrounded
 * task, and a silent close leaves the kill undiagnosable (decision unattended-wake-budget). */
export function logDroppedPendingWork(
  subChatId: string,
  pendingWork: StopPendingWork | null,
  cause: string,
): void {
  if (!pendingWork) return;
  const kinds = [
    ...pendingWork.backgroundTasks.map((task) => task.type),
    ...pendingWork.sessionCrons.map(() => 'cron'),
  ];
  log.warn(
    `[Socket Executor] Disposing session for ${subChatId} with pending work (${cause}) — dropping: ${kinds.join(', ')}`,
  );
  if (alertsOnDroppedWork(cause)) {
    captureMainMessage('Session disposed with pending background work', 'warning', {
      subChatId,
      cause,
      kinds: kinds.join(','),
    });
  }
}

/** One line naming how a turn that took over a wake hold ended, so a wait that never came back
 * can be traced to its cause. Logs once per adopted turn; ordinary turns stay silent. */
export function logAdoptedTurnEnd(
  turn: Pick<ClaudeTurnContext, 'adoptedHold'>,
  subChatId: string,
  disposition: string,
): void {
  if (!turn.adoptedHold) return;
  turn.adoptedHold = false;
  log.info(`[Socket Executor] Adopted turn ended for ${subChatId}: ${disposition}`);
}

type TurnEndSession = Pick<
  ClaudeSession,
  'stopHook' | 'queue' | 'busy' | 'subChatId' | 'inputsReadAt'
>;

/** Why the session must end instead of being held or kept, or null when it may stay. */
function disposeCause(
  session: TurnEndSession,
  turn: Pick<ClaudeTurnContext, 'planSubmissionHalt'>,
  signal: AbortSignal,
): string | null {
  if (signal.aborted) return 'aborted';
  if (turn.planSubmissionHalt()) return 'plan submitted';
  if (session.queue.closed) return 'question-park kill'; // killed by a question park: dead input
  if (session.busy) return 'session busy';
  return chatFence(session) || null; // its chat was torn down or switched account mid-turn
}

function adoptedTurnDisposition(cause: string | null, session: TurnEndSession): string {
  const pendingWork = session.stopHook?.lastPendingWork;
  if (cause) return `disposed (${cause})`;
  if (pendingWork) return `re-armed (${summarizePendingWork(pendingWork).waitingOn.join(', ')})`;
  const why = session.stopHook?.stoppedSinceReset ? 'no pending work' : 'no Stop snapshot';
  return `not re-armed (${why})`;
}

/** The turn-end arm-vs-dispose gate: true ends the session instead of holding or keeping it. Names
 * the work a disposal drops, and gives an adopted turn its disposition line. */
export function turnEndMustDispose(
  subChatId: string,
  session: TurnEndSession,
  turn: Pick<ClaudeTurnContext, 'adoptedHold' | 'planSubmissionHalt'>,
  signal: AbortSignal,
): boolean {
  const cause = disposeCause(session, turn, signal);
  if (cause) logDroppedPendingWork(subChatId, session.stopHook?.lastPendingWork ?? null, cause);
  logAdoptedTurnEnd(turn, subChatId, adoptedTurnDisposition(cause, session));
  return cause !== null;
}

/**
 * Did this turn declare its own work finished, overriding what the harness still has registered?
 *
 * That list is a liveness fact, not an intent one, and stays non-empty for a task that can never
 * exit (a backgrounded `tail -f` is the observed case) — so it must not outrank the agent's own
 * `done`. The override is scoped to those un-exitable kinds (`shell`, `monitor`): a `subagent` or
 * `workflow` task is settled by the harness itself and always reports back, so a `done` while one
 * is live is the agent mispredicting — dropping it kills real work (observed: two background
 * subagents, `done` after the first, second killed). Mirrors the CLI's own result hold-back, which
 * never releases over live agent/workflow tasks. See decision unattended-wake-budget.
 *
 * `since` scopes the read: the signal slot is per execution context, never cleared, and shared by
 * its wake bursts — so an unqualified read would let a stale `done` end a wait not declared over.
 */
export function declaresWaitOver(
  signal: TaskSignalPayload | null | undefined,
  pending: StopPendingWork | null | undefined,
  since: string | null,
): boolean {
  if (!signal || !WAIT_ENDING_SIGNAL_STATES.has(signal.state)) return false;
  // A ScheduleWakeup cron is work the USER set up, not something the agent's `done` speaks for, and
  // standing the pump down drops it. Any cron pending keeps the wait whatever the signal says.
  if ((pending?.sessionCrons.length ?? 0) > 0) return false;
  if (pending?.backgroundTasks.some((t) => t.type === 'subagent' || t.type === 'workflow')) {
    return false;
  }
  return !since || (typeof signal.at === 'string' && signal.at > since);
}

/** One burst's signal duties. The verdict is taken BEFORE the persist advances the cursor past this
 * burst's own signal — reading after would compare the signal against itself and never fire. Both
 * are returned rather than mutated, so the pump keeps one writer for its latch and its cursor.
 *
 * A fresh wait-ending signal that a veto keeps from ending the wait is DEFERRED, not honored: it is
 * neither persisted (an eager `done` on the task row would let the renderer terminalize it while
 * the pump still holds) nor advanced past (the cursor stays, so the declaration remains standing
 * and ends the wait at the first burst whose veto has cleared — the agent need not repeat it). */
export async function settleBurstSignal(params: {
  subChatId: string;
  signalTaskId: string | null;
  executionContextId: string | undefined;
  getLatestTaskSignal: (executionContextId: string) => TaskSignalPayload | null | undefined;
  pending: StopPendingWork | null | undefined;
  lastSeenSignalAt: string | null;
  throwOnError: boolean;
}): Promise<{ waitOver: boolean; lastSeenSignalAt: string | null }> {
  const { executionContextId, getLatestTaskSignal, pending, lastSeenSignalAt } = params;
  const signal = executionContextId ? (getLatestTaskSignal(executionContextId) ?? null) : null;
  const waitOver = declaresWaitOver(signal, pending, lastSeenSignalAt);
  // Deferred = would end the wait but for a veto (the second call strips the vetoes).
  const deferred = !waitOver && declaresWaitOver(signal, null, lastSeenSignalAt);
  return {
    waitOver,
    lastSeenSignalAt: await persistBurstTurnEndDuties({ ...params, signal, deferred }),
  };
}

/** The write decision, isolated from the error boundary: a quiet (or deferred-declaration) burst
 * refreshes the park sweep's inactivity clock and keeps the cursor where it was (see
 * settleBurstSignal's deferral contract); a fresh honored signal persists and advances it. */
async function writeBurstSignalOrQuietMark(
  subChatId: string,
  signalTaskId: string | null,
  signal: TaskSignalPayload | null,
  deferred: boolean,
  lastSeenSignalAt: string | null,
): Promise<string | null> {
  if (!signal || deferred || signal.at === lastSeenSignalAt) {
    // Un-park first (the sweep may have parked the row after this burst opened), THEN mark quiet:
    // the mark only lands on a running row, and it is what restarts the sweep's clock.
    if (signalTaskId) {
      await resumeQuietIdleParkOnBurst(signalTaskId, subChatId);
      await markLinkedTaskQuietEnd(signalTaskId);
    }
    return lastSeenSignalAt;
  }
  if (signalTaskId) await persistLinkedTaskSignal({ taskIdForExecution: signalTaskId, signal });
  return signal.at ?? lastSeenSignalAt;
}

/** Persist a new burst signal or refresh its quiet marker. Flow waits surface write failures;
 * legacy waits stay best-effort. Returns the timestamp used to detect the next new signal. */
async function persistBurstTurnEndDuties(params: {
  subChatId: string;
  signalTaskId: string | null;
  signal: TaskSignalPayload | null;
  deferred: boolean;
  lastSeenSignalAt: string | null;
  throwOnError: boolean;
}): Promise<string | null> {
  const { subChatId, signalTaskId, signal, deferred, lastSeenSignalAt, throwOnError } = params;
  try {
    return await writeBurstSignalOrQuietMark(
      subChatId,
      signalTaskId,
      signal,
      deferred,
      lastSeenSignalAt,
    );
  } catch (error) {
    captureMainException(error, { surface: 'claude-wake-hold', stage: 'signal-persist' });
    log.error('[Socket Executor] Wake-burst signal persist failed', {
      subChatId,
      taskId: signalTaskId,
      error: error instanceof Error ? error.message : String(error),
    });
    if (throwOnError) throw error;
    return lastSeenSignalAt;
  }
}

/** A wake burst is activity, and activity un-parks a quiet-idle park (`needs_attention` + signal
 * `missing_completion_signal` ONLY). Never rejects. Why start AND end: flow-quiet-wait-handling. */
export async function resumeQuietIdleParkOnBurst(
  signalTaskId: string | null,
  subChatId: string,
): Promise<void> {
  if (!signalTaskId) return;
  try {
    const { getDatabase } = await import('../../db');
    const { getTaskById } = await import('../../db/repos/tasks');
    const task = await getTaskById(getDatabase(), signalTaskId);
    if (!task) return;
    const live =
      task.status === 'running'
        ? await repairFlowBehindRunningTask(task)
        : await resumeQuietParkedTask(task, subChatId);
    if (!live) return;
    // fallow-ignore-next-line circular-dependency
    const { broadcastTaskSignalPersisted } = await import('../client');
    broadcastTaskSignalPersisted({
      taskId: task.id,
      status: 'running',
      isFlowLinked: Boolean(task.flowRunId),
    });
  } catch (error) {
    captureMainException(error, { surface: 'claude-wake-hold', stage: 'burst-unpark' });
    log.warn('[Socket Executor] Wake-burst un-park failed', {
      subChatId,
      taskId: signalTaskId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

type LinkedTask = {
  id: string;
  status: string;
  result: unknown;
  flowRunId: string | null;
  nodeRunId: string | null;
};

/** A `running` task whose node/run were left parked behind it (a resume that lost its flow half
 * to a crash or a thrown unpark) is repaired here; a healthy flow is left alone. True if repaired. */
async function repairFlowBehindRunningTask(task: LinkedTask): Promise<boolean> {
  if (!task.flowRunId) return false;
  const { getDatabase } = await import('../../db');
  const { getNodeRun } = await import('../../db/repos/node-runs');
  const { getFlowRun } = await import('../../db/repos/flow-runs');
  const db = getDatabase();
  const [node, run] = await Promise.all([
    task.nodeRunId ? getNodeRun(db, task.nodeRunId) : null,
    getFlowRun(db, task.flowRunId),
  ]);
  if (node?.status === 'running' && run?.status === 'running') return false;
  const { unparkFlowInPlace } = await import('../../tasks');
  const row = { id: task.id, status: task.status, result: task.result };
  return unparkFlowInPlace(task.flowRunId, task.nodeRunId, task.id, row, false);
}

/** Quiet-idle parks ONLY: user pauses, the agent's own questions and transient parks wait for the
 * user. True when the task and its flow are live again. */
async function resumeQuietParkedTask(task: LinkedTask, subChatId: string): Promise<boolean> {
  if (task.status !== 'needs_attention') return false;
  const { parseResultRecord } = await import('../../db/repos/tasks');
  // SAFETY: `agentSignal` is only ever written from a parsed TaskSignalPayload
  // (resolveTaskSignalTransition), and only its `state` is read here.
  const agentSignal = parseResultRecord(task.result).agentSignal as { state?: string } | undefined;
  if (agentSignal?.state !== 'missing_completion_signal') return false;
  const { resumeParkedTaskInPlace } = await import('../../tasks');
  return resumeParkedTaskInPlace(task, 'wake_burst', subChatId);
}
