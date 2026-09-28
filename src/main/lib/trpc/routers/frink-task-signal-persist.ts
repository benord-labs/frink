import type { TaskSignalPayload } from '../../../../shared/types/task-signal';
import { captureMainException } from '../../sentry/init';
import {
  canApplyTaskSignalForStatus,
  parseTaskSignalInput,
  refusePlanModeTerminalSignal,
  resolveTaskSignalTransition,
} from './frink-task-signal';

/**
 * Single write path for persisting a task signal on a linked execution task (interactive
 * router stream + socket executor). Returns whether `updateTaskStatus` ran.
 *
 * Lives in its own module so consumers (e.g. `executor.ts`) get reliable named exports in the IDE;
 * re-exporting async functions from `frink-task-signal.ts` sometimes surfaced as “no exported member”.
 */
export async function persistLinkedTaskSignal(params: {
  taskIdForExecution: string | null | undefined;
  signal: TaskSignalPayload;
}): Promise<boolean> {
  const { taskIdForExecution, signal } = params;
  if (!taskIdForExecution) return false;
  const { getDatabase } = await import('../../db');
  const { getTaskById, updateTaskStatus } = await import('../../db/repos/tasks');
  const db = getDatabase();
  const latestTask = await getTaskById(db, taskIdForExecution);
  if (!latestTask) return false;
  const transition = resolveTaskSignalTransition(latestTask, signal);
  // CAS on the statuses canApplyTaskSignalForStatus admits (running, or a lease-expired failed):
  // if a concurrent park landed between the read above and this write, the write must no-op
  // instead of clobbering the fresh needs_attention park with a stale pre-park snapshot.
  let updated = canApplyTaskSignalForStatus(latestTask)
    ? await updateTaskStatus(db, taskIdForExecution, transition.status, {
        result: transition.result,
        expectStatuses: ['running', 'failed'],
      })
    : null;
  if (!updated)
    updated = await writeAgainstParkedRow(taskIdForExecution, latestTask, transition, signal);
  if (!updated) return false;
  // Deliberate dynamic import: socket/client → executor → here forms a static cycle, broken at
  // runtime by loading client lazily. Pre-existing; surfaced only because this file was renamed.
  // fallow-ignore-next-line circular-dependency
  const { broadcastTaskSignalPersisted } = await import('../../socket/client');
  broadcastTaskSignalPersisted({
    taskId: taskIdForExecution,
    status: transition.status,
    isFlowLinked: Boolean(latestTask.flowRunId),
  });
  return true;
}

/** The primary CAS lost. A user-pause or quiet-idle park is SUPERSEDED (the agent's real signal is
 * the truth); a row a wake burst resumed to `running` takes the ordinary write. Every write CASes. */
async function writeAgainstParkedRow(
  taskIdForExecution: string,
  latestTask: { flowRunId: string | null },
  transition: ReturnType<typeof resolveTaskSignalTransition>,
  signal: TaskSignalPayload,
) {
  const { getDatabase } = await import('../../db');
  const { getTaskById, parseResultRecord } = await import('../../db/repos/tasks');
  const db = getDatabase();
  const fresh = await getTaskById(db, taskIdForExecution);
  if (!fresh) return null;
  const freshResult = parseResultRecord(fresh.result);
  // Only a WAKE-BURST resume is this same execution continuing; a follow-up message is a new
  // attempt, and an older turn's delayed signal must not terminalize it.
  if (fresh.status === 'running' && freshResult.resumedBy === 'wake_burst') {
    const { replaceWakeResumedRow } = await import('../../db/repos/task-parking/quiet-marker');
    const resumedAt = String(freshResult.resumedAt ?? '');
    return replaceWakeResumedRow(db, taskIdForExecution, resumedAt, transition);
  }
  if (fresh.status !== 'needs_attention') return null;
  return supersedePark(db, taskIdForExecution, fresh, latestTask.flowRunId, signal);
}

/** Supersede a user-pause or quiet-idle park with the agent's real signal (CAS on the park). */
async function supersedePark(
  db: Awaited<ReturnType<(typeof import('../../db'))['getDatabase']>>,
  taskId: string,
  fresh: NonNullable<Awaited<ReturnType<(typeof import('../../db/repos/tasks'))['getTaskById']>>>,
  flowRunId: string | null,
  signal: TaskSignalPayload,
) {
  const { parseResultRecord, updateTaskStatus } = await import('../../db/repos/tasks');
  const freshResult = parseResultRecord(fresh.result);
  const isQuietIdlePark =
    (freshResult.agentSignal as { state?: string } | undefined)?.state ===
    'missing_completion_signal';
  if (!freshResult.userPause && !isQuietIdlePark) return null;
  const supersede = resolveTaskSignalTransition(fresh, signal);
  const updated = await updateTaskStatus(db, taskId, supersede.status, {
    result: supersede.result,
    expectStatuses: ['needs_attention'],
  });
  if (updated && isQuietIdlePark && flowRunId) {
    const { unparkQuietIdleFlowRun } = await import('../../flows/task-completion-watcher');
    await unparkQuietIdleFlowRun(db, taskId, flowRunId);
  }
  return updated;
}

/**
 * Should a plan turn's quiet end SKIP the quiet-end marker? The marker means "may be waiting on
 * background work — defer the task transition to the wake/sweep machinery". A plan turn whose end
 * belongs to the PLAN machinery instead (card → plan_ready) must not carry it, or the renderer's
 * completion policy defers a transition nothing will ever re-trigger:
 * - a halted submission (ExitPlanMode, non-auto) — the card is the turn's terminal artifact;
 * - a plan-locked stop with NOTHING pending — plan-card paths that never set the halt (a follow-up
 *   amending the plan file without re-calling ExitPlanMode) end here, and with no pending work
 *   there is no wait to defer for;
 * - any non-Claude plan turn (`claudeTurn` null) — those providers have no wake pump, so a plan
 *   turn's quiet end never means "waiting"; their card/reply owns the transition. Revisit if
 *   Codex ever gains background waits.
 * A plan-locked stop WITH pending work keeps the marker — that is the held-drafting wait the wake
 * pump exists for.
 */
export function suppressQuietEndForPlanTurn(
  claudeTurn:
    | { planSubmissionHalt: () => boolean; planTerminalsLocked: boolean }
    | null
    | undefined,
  mode: string,
  pendingWork: unknown,
): boolean {
  if (!claudeTurn) return mode === 'plan';
  return claudeTurn.planSubmissionHalt() || (claudeTurn.planTerminalsLocked && !pendingWork);
}

/** Finalizes an execution-scoped signal before its provider context is cleared. */
export async function finalizeLinkedTaskSignalFromContext(params: {
  taskIdForExecution: string;
  executionContextId: string;
  shouldMarkQuietEnd: boolean;
  isAborted: () => boolean;
  subChatId: string;
  /** This turn submitted a plan, so an `awaiting_input` on record may be the DRAFTING phase's. */
  planSubmitted?: boolean;
  /** The plan machinery owns this turn's task transition ({@link suppressQuietEndForPlanTurn}) —
   * skip the quiet-end marker so the renderer's completion policy is not deferred. */
  planTerminal?: boolean;
  /** Flow lease settlement needs persistence failures; ordinary chats retain best-effort logging. */
  throwOnError?: boolean;
}): Promise<void> {
  const { taskIdForExecution, executionContextId, shouldMarkQuietEnd, isAborted, subChatId } =
    params;
  try {
    // fallow-ignore-next-line circular-dependency
    const { getLatestTaskSignal } = await import('../../mcp/dynamic-chat-server');
    const signal = getLatestTaskSignal(executionContextId);
    if (signal) {
      // The known asymmetry made observable: an auto-approve node that submitted a plan and then
      // ignored the Stop hook's chase settles on its drafting-phase question instead of the work it
      // actually did. The node still parks (so this is a wrong-park, not a hang), but the park text
      // is stale — capture it rather than let it look like a normal user-facing pause.
      if (params.planSubmitted && signal.state === 'awaiting_input') {
        const { captureMainMessage } = await import('../../sentry/init');
        captureMainMessage('Flow node parked on a stale pre-plan question', 'warning', {
          taskId: taskIdForExecution,
          subChatId,
        });
      }
      const persisted = await persistLinkedTaskSignal({ taskIdForExecution, signal });
      if (!persisted) await reportDroppedSignal(taskIdForExecution, signal, subChatId, params);
    } else if (shouldMarkQuietEnd && !params.planTerminal && !isAborted()) {
      await markLinkedTaskQuietEnd(taskIdForExecution, isAborted);
    }
  } catch (error) {
    if (!params.throwOnError) captureMainException(error, { surface: 'task-signal-finalization' });
    const log = (await import('electron-log')).default;
    log.error('[TaskSignal] Execution-context finalization failed', {
      subChatId,
      taskId: taskIdForExecution,
      error: error instanceof Error ? error.message : String(error),
    });
    if (params.throwOnError) throw error;
  }
}

/** A recorded signal the row refused must not vanish (sc-2771): a strict (flow) turn throws into
 * lease settlement, any other turn warns. An exact re-persist of an applied signal is not a drop. */
async function reportDroppedSignal(
  taskId: string,
  signal: TaskSignalPayload,
  subChatId: string,
  params: { throwOnError?: boolean },
): Promise<void> {
  const { getDatabase } = await import('../../db');
  const { getTaskById, parseResultRecord } = await import('../../db/repos/tasks');
  const fresh = await getTaskById(getDatabase(), taskId);
  // A wake-burst settle or question park already wrote this exact signal — applied, not dropped.
  if (fresh && isSameSignal(parseResultRecord(fresh.result).agentSignal, signal)) return;
  const status = fresh?.status ?? 'missing';
  const message = `Task signal dropped: ${signal.state} on task ${taskId} (status ${status})`;
  if (params.throwOnError) throw new Error(message);
  const { captureMainMessage } = await import('../../sentry/init');
  captureMainMessage('Task signal dropped at turn end', 'warning', {
    taskId,
    subChatId,
    state: signal.state,
    status,
  });
}

/** Same signal instance: `at` is stamped once per signal, and the stored state is normalized
 * (`completed` → `done`, see resolveTaskSignalTransition). */
function isSameSignal(stored: unknown, signal: TaskSignalPayload): boolean {
  if (typeof stored !== 'object' || stored === null) return false;
  const { state, at } = stored as { state?: unknown; at?: unknown };
  const expectedState = signal.state === 'completed' ? 'done' : signal.state;
  return at === signal.at && state === expectedState;
}

/**
 * Marks a quiet turn-end on the linked task: the stream ended (or the Stop hook allowed a stop)
 * with no explicit frink_task_signal and no abort. Result-only write — status stays `running`,
 * because the agent may be intentionally waiting on background work that re-invokes it later.
 * Nothing terminalizes here: the flows quiet-idle sweep parks the task only after the idle
 * ceiling elapses, and the renderer completion policy treats the marker as "defer to that sweep".
 * The marker needs no explicit clearing — any later signal supersedes it, and a resumed run's
 * fresh `startedAt` makes an older marker stale (the sweep ignores markers older than startedAt).
 * `isAborted` is checked right before the single atomic write: a duplicate-request turn aborts its
 * predecessor synchronously at entry, so the check stops a superseded turn's delayed marker from
 * landing on the new turn's row. The write patches only the marker key (json_set), so it can never
 * clobber a concurrent `result` writer such as the eager signal record.
 */
export async function markLinkedTaskQuietEnd(
  taskIdForExecution: string | null | undefined,
  isAborted?: () => boolean,
): Promise<boolean> {
  if (!taskIdForExecution) return false;
  if (isAborted?.()) return false;
  const { getDatabase } = await import('../../db');
  const { setQuietEndMarker } = await import('../../db/repos/task-parking/quiet-marker');
  const updated = await setQuietEndMarker(
    getDatabase(),
    taskIdForExecution,
    new Date().toISOString(),
  );
  return updated != null;
}

/**
 * Removes a prior turn's quiet-end marker at fresh-turn start. Running→running follow-ups skip the
 * park-resume scrub entirely, so without this the quiet-idle sweep could park a live re-invoked
 * turn on a stale marker. Returns `parked` when the task is (or was concurrently) taken out of
 * `running` — i.e. the sweep's park won the race against this turn's start — so the caller can
 * re-run its follow-up resume and un-park deterministically.
 */
export async function clearLinkedTaskQuietEnd(
  taskIdForExecution: string | null | undefined,
): Promise<'cleared' | 'none' | 'parked'> {
  try {
    if (!taskIdForExecution) return 'none';
    const { getDatabase } = await import('../../db');
    const { removeQuietEndMarker } = await import('../../db/repos/task-parking/quiet-marker');
    const { getTaskById } = await import('../../db/repos/tasks');
    const db = getDatabase();
    // Atomic json_remove of the marker key (never a whole-blob rewrite). Zero rows means either
    // no marker on a running row, or the task left `running` — a follow-up read labels which.
    const removed = await removeQuietEndMarker(db, taskIdForExecution);
    if (removed) return 'cleared';
    const latestTask = await getTaskById(db, taskIdForExecution);
    if (!latestTask) return 'none';
    return latestTask.status === 'running' ? 'none' : 'parked';
  } catch (error) {
    const log = (await import('electron-log')).default;
    log.error('[TaskSignal] Quiet-end marker clear failed', {
      taskId: taskIdForExecution,
      error: error instanceof Error ? error.message : String(error),
    });
    const { captureMainMessage } = await import('../../sentry/init');
    captureMainMessage('Quiet-end marker clear failed', 'warning', {
      taskId: taskIdForExecution ?? 'unknown',
    });
    return 'none';
  }
}

/**
 * Whether the execution context has recorded a frink_task_signal this turn (Stop-hook hasSignal).
 *
 * `requireTerminal` covers the ONE turn shape that spans two signal phases: an auto-approve plan
 * node may park with `awaiting_input` while DRAFTING, then submit its plan and implement in the
 * SAME turn. The context keeps only the latest signal and never clears it mid-turn, so that
 * drafting park would otherwise satisfy the implementation phase's mandatory terminal — the run
 * would stop unchased and persist the stale question over finished work. Callers pass the turn's
 * live `planSubmitted`, never a turn-start mode: a follow-up turn can re-enter plan mode mid-stream,
 * and only the boundary fact sees that. Post-plan the agent is told to finish on
 * done/partial/blocked/failed, so `awaiting_input` cannot settle it.
 */
export async function hasLatestTaskSignalFor(
  executionContextId: string | undefined,
  requireTerminal = false,
): Promise<boolean> {
  // Deliberate dynamic import: dynamic-chat-server → executor → here forms a static cycle,
  // broken at runtime by loading the server module lazily (same pattern as socket/client below).
  const { getLatestTaskSignal } = await import('../../mcp/dynamic-chat-server');
  const signal = getLatestTaskSignal(executionContextId);
  if (!signal) return false;
  // Same carve-out as refusePlanModeTerminalSignal: awaiting_input parks, every other state ends.
  return !requireTerminal || signal.state !== 'awaiting_input';
}

/** The tool refused a dead target and disarmed itself this turn; the Stop hook treats that as
 * settled, since chasing the agent only earns the same refusal. */
export async function isTaskSignalDisarmedFor(
  executionContextId: string | undefined,
): Promise<boolean> {
  // Same lazy load as hasLatestTaskSignalFor: dynamic-chat-server → executor → here is a cycle.
  const { isTaskSignalDisarmed } = await import('../../mcp/dynamic-chat-server');
  return isTaskSignalDisarmed(executionContextId);
}

/**
 * Stop-hook allow-time variant of {@link markLinkedTaskQuietEnd}: writes the marker only when the
 * turn is ending with no recorded signal and no abort. The executor calls it fire-and-forget from
 * the hook's onAllow so the marker lands before the stream fully closes — ahead of the renderer's
 * completion refetch, which would otherwise park the task the moment streaming ends. Never throws;
 * the executor's post-stream fallback write covers a failed eager attempt.
 */
export async function markQuietEndIfUnsignaled(
  executionContextId: string | undefined,
  isAborted: () => boolean,
  taskIdForExecution: string | null | undefined,
): Promise<void> {
  try {
    // Deliberately phase-BLIND (unlike the Stop hook's read): a drafting-phase park still counts as
    // "signalled" here, so a non-compliant two-phase turn parks on that stale ask rather than on a
    // quiet-end marker. Narrowing this needs room executor.ts does not currently have — see the PR.
    if (await hasLatestTaskSignalFor(executionContextId)) return;
    if (isAborted()) return;
    await markLinkedTaskQuietEnd(taskIdForExecution, isAborted);
  } catch (error) {
    const log = (await import('electron-log')).default;
    log.error('[TaskSignal] Quiet-end marker write failed', {
      taskId: taskIdForExecution,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Eager, result-only sibling of `persistLinkedTaskSignal`: records the agent signal into the
 * task `result` while keeping status `running`, so the terminal transition (and flow node
 * advance) is deferred to the agent's stream end. The renderer's completion detection still sees
 * the `agentSignal` (avoiding the needs_attention race) but does not act until the task is
 * terminal. The post-stream block in the executor performs the single terminal flip. Returns
 * whether the result write ran.
 */
export async function recordLinkedTaskSignal(params: {
  taskIdForExecution: string | null | undefined;
  signal: TaskSignalPayload;
}): Promise<boolean> {
  const { taskIdForExecution, signal } = params;
  if (!taskIdForExecution) return false;
  const { getDatabase } = await import('../../db');
  const { getTaskById, updateTaskResult } = await import('../../db/repos/tasks');
  const db = getDatabase();
  const latestTask = await getTaskById(db, taskIdForExecution);
  if (!latestTask || !canApplyTaskSignalForStatus(latestTask)) {
    return false;
  }
  // Reused only for the merged `result` shape (strips stale-failure meta, sets `agentSignal`);
  // `.status` is intentionally discarded — the terminal flip happens post-stream.
  const transition = resolveTaskSignalTransition(latestTask, signal);
  // Same CAS as persistLinkedTaskSignal: a park landing between read and write wins.
  const updated = await updateTaskResult(db, taskIdForExecution, transition.result, {
    expectStatuses: ['running', 'failed'],
  });
  return updated != null;
}

/**
 * `canUseTool` side of `frink_task_signal`: records the signal into the task result DURING the
 * stream, preventing a race with useTaskCompletionDetection (which fires when streaming ends and
 * defaults to needs_attention if no agentSignal is in the DB yet). Status stays `running` — the
 * terminal flip, and the flow node advance, defer to the post-stream block, so a node never
 * advances while its agent is still streaming the message that follows the signal.
 *
 * `awaiting_input` is recorded verbatim and pauses the flow even on an auto-approve plan node:
 * auto-approve advances via the plan card (ExitPlanMode -> flipToAgentModeForAutoApprove), never by
 * rewriting a genuine pause to `done`.
 *
 * Returns a canUseTool deny when plan mode refuses the state, else null (nothing to veto).
 */
export async function recordTaskSignalFromToolCall(params: {
  toolName: string;
  toolInput: unknown;
  signalTaskId: string;
  planTerminalsLocked: boolean;
  subChatId: string;
}): Promise<{ behavior: 'deny'; message: string } | null> {
  const { toolName, toolInput, signalTaskId, planTerminalsLocked, subChatId } = params;
  const { isFrinkTaskSignalToolName } = await import('./claude-task-signal-tool-name');
  if (!isFrinkTaskSignalToolName(toolName)) return null;

  const parsedSignal = parseTaskSignalInput(toolInput);
  if (!parsedSignal) return null;

  // Refuse BEFORE recording: a rejected terminal must leave no `agentSignal` on the row, else the
  // renderer's completion policy terminalizes it anyway and the stale marker makes the quiet-idle
  // sweep bail (expiredQuietMarker), stranding the run.
  const planRefusal = refusePlanModeTerminalSignal(parsedSignal.state, planTerminalsLocked);
  if (planRefusal) return { behavior: 'deny', message: planRefusal };

  try {
    const recorded = await recordLinkedTaskSignal({
      taskIdForExecution: signalTaskId,
      signal: parsedSignal,
    });
    // Advisory: the tool handler owns the agent-facing answer; the turn-end finalize owns the flip.
    if (!recorded) {
      const log = (await import('electron-log')).default;
      log.warn(
        '[Socket Executor] Task signal not recorded eagerly; task not in a signalable state',
        {
          subChatId,
          taskId: signalTaskId,
          state: parsedSignal.state,
        },
      );
    }
  } catch (error) {
    const log = (await import('electron-log')).default;
    log.error('[Socket Executor] Failed to persist task signal from canUseTool', {
      subChatId,
      taskId: signalTaskId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}
