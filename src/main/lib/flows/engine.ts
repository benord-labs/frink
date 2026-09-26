/**
 * Local flow execution engine — module hub. Implementation lives in
 * sibling files (advance.ts, start.ts, resume.ts, dispatch/, scheduler.ts).
 * This file wires together the public API consumed by the tRPC router.
 *
 * What works locally:
 * - startFlowRun: insert flow_run + first node_run, dispatch, walk graph.
 * - advanceFlowRun: persist node output, emit events, pick next node.
 * - cancelFlowRun: abort in-flight controllers, mark cancelled.
 * - resumeFlowRun: approve / retry / skip from a paused node.
 * - getFlowRunWithNodeRuns: hydrate run + nodes for the renderer.
 *
 * Block coverage today: trigger nodes, start_task, run_command, custom_node,
 * http_request, condition, approval, end. Deferred: agent (Claude SDK),
 * chat_reply (renderer chat session), fan_out parallel/sequential lanes.
 * See migration-to-flows-local/PHASE2_DEFERRED.md.
 */

import log from 'electron-log';
import { captureMainException } from '../sentry/init';
import { getDatabase } from '../db';
import {
  getFlowRun as getFlowRunRow,
  listActiveFlowRunIdsForChat,
  setFlowRunStatus,
} from '../db/repos/flow-runs';
import { cancelRemainingNodeRunsForRun, listNodeRunsForFlowRun } from '../db/repos/node-runs';
import {
  cancelChatOwnedFlowWork,
  cancelChatOwnedFlowWorkForArchive,
  cancelExecutingFlowTasksForChats,
} from '../db/repos/task-queries/chat-flow-cleanup';
import { cancelFlowLinkedTasks } from '../db/repos/tasks';
import type { FlowRun, NodeRun } from '../db/schema';
import { clearActiveFlowTaskForChat } from '../task-executor';
import { loadRunContext } from './advance';
import {
  abortFlowRun,
  withFlowRunCancellation,
  withFlowRunCancellationGuard,
} from './cancel-registry';
import { emitRunTerminal } from './event-emit';

export class LocalEngineNotImplementedError extends Error {
  constructor(detail: string) {
    super(`Local flow engine: ${detail} not yet implemented`);
    this.name = 'LocalEngineNotImplementedError';
  }
}

export { rerunFlowRunFromInterruption, resumeFlowRun } from './resume';
export { startFlowRun } from './start';

const TERMINAL_FLOW_STATUSES = new Set<FlowRun['status']>(['completed', 'failed', 'cancelled']);

function isTerminalFlowRun(run: FlowRun): boolean {
  return TERMINAL_FLOW_STATUSES.has(run.status);
}

function shouldPreserveTerminalRun(
  initialRun: FlowRun,
  currentRun: FlowRun,
  hasPromotedAdmission: boolean,
): boolean {
  return isTerminalFlowRun(initialRun) && (!hasPromotedAdmission || isTerminalFlowRun(currentRun));
}

async function cancellationAdmissionState(
  flowRunId: string,
  queuedOnly?: CancelQueuedOnly,
): Promise<{
  cancelledBeforeDispatch: boolean;
  hasPromotedAdmission: boolean;
}> {
  const admissionRuntime = await import('./admission/runtime');
  const cancelledBeforeDispatch = await admissionRuntime.cancelUndispatchedFlowAdmission(
    flowRunId,
    queuedOnly && { states: ['queued'], ticket: queuedOnly.ticket },
  );
  // A dequeue returns through `dequeuedFlowRun` before promotion is ever read, so asking for it
  // would spend a query on a value nobody consumes.
  const hasPromotedAdmission = queuedOnly
    ? false
    : await admissionRuntime.hasPromotedFlowAdmission(flowRunId);
  return { cancelledBeforeDispatch, hasPromotedAdmission };
}

async function emitCancelledFlowRun(flowRunId: string): Promise<void> {
  const ctx = await loadRunContext(flowRunId);
  if (ctx) emitRunTerminal(ctx.meta, flowRunId, 'cancelled');
  else log.warn('[FlowsEngine] cancelFlowRun: run context unavailable', { flowRunId });
}

/**
 * A dequeue's entire effect lands in the admission transaction: cancelling a queued start
 * terminalizes the run it never dispatched, and a queued resume leaves its finished run untouched.
 * Nothing is left for the engine to write, so this path deliberately reads the outcome instead of
 * imposing one — a replacement admission promoted onto the same run while the clicked ticket was
 * being cancelled keeps its work, because no run status, node run or task is written here.
 *
 * The terminal event still fires for the run the transaction did cancel: it is the only live driver
 * of batch stage advancement.
 */
async function dequeuedFlowRun(
  flowRunId: string,
  run: FlowRun,
  cancelledBeforeDispatch: boolean,
): Promise<FlowRun | null> {
  if (!cancelledBeforeDispatch) return null;
  const updated = (await getFlowRunRow(getDatabase(), flowRunId)) ?? run;
  // Only for a run THIS dequeue terminalized. A queued resume's run was already terminal and has
  // already emitted its own terminal event; emitting again would settle its batch stage twice.
  if (isTerminalFlowRun(run) || updated.status !== 'cancelled') return updated;
  // A replacement admission enqueued between that cancellation and this emit owns the run now — a
  // retry racing the removal. Its own terminal event settles the batch stage when it finishes;
  // emitting here would settle the stage while that replacement is still waiting to run.
  const admissionRuntime = await import('./admission/runtime');
  if (await admissionRuntime.hasLiveFlowAdmission(flowRunId)) return updated;
  // The dequeue has committed. A failed delivery must not report the removal as failed — the
  // startup batch sweep is the backstop for the stage this event would have settled.
  await emitCancelledFlowRun(flowRunId).catch((error) => {
    log.error('[FlowsEngine] dequeue terminal event failed', { flowRunId, error });
    captureMainException(error, { surface: 'flow-dequeue', stage: 'terminal-event' });
  });
  return updated;
}

/** Restrict a cancellation to this exact ticket, while it still waits in the queue. */
export type CancelQueuedOnly = { ticket: number };

/**
 * Cancel an in-flight or pending flow run. Idempotent — calling on an already
 * terminal run is a no-op aside from event emission.
 *
 * `queuedOnly` makes the cancellation a dequeue: the run is left untouched unless its admission
 * is still queued, so work the scheduler has already claimed is never preempted by a stale click.
 */
export async function cancelFlowRun(
  flowRunId: string,
  options: { queuedOnly?: CancelQueuedOnly } = {},
): Promise<FlowRun | null> {
  const db = getDatabase();
  const run = await getFlowRunRow(db, flowRunId);
  if (!run) return null;
  const { cancelledBeforeDispatch, hasPromotedAdmission } = await cancellationAdmissionState(
    flowRunId,
    options.queuedOnly,
  );
  if (options.queuedOnly) return dequeuedFlowRun(flowRunId, run, cancelledBeforeDispatch);
  const currentRun = (await getFlowRunRow(db, flowRunId)) ?? run;
  // Already terminal — a PURE no-op, deliberately: `resumeInterruptedFlowInPlace` unparks a revived
  // run by flipping its node_run to `running` BEFORE its flow_run, so a concurrent call here reads
  // `cancelled` while the driving task is live. Only a promoted admission proves a terminal read
  // became a newly-running retry that this cancellation must stop.
  if (shouldPreserveTerminalRun(run, currentRun, hasPromotedAdmission)) {
    return currentRun;
  }

  let updated: FlowRun | null = currentRun;
  if (cancelledBeforeDispatch) {
    updated = await getFlowRunRow(db, flowRunId);
    if (!updated) return run;
  }
  if (!cancelledBeforeDispatch || updated.status !== 'cancelled') {
    // Status first so the polling watcher cannot emit a second terminal event during task sweep.
    updated = await withFlowRunCancellation(flowRunId, () =>
      setFlowRunStatus(db, flowRunId, 'cancelled', { completedAt: new Date() }),
    );
    if (!updated) return run;

    // Terminalize the node runs too, mirroring advanceFlowRun's own cancelled branch. The
    // in-process node whose controller we just aborted returns WITHOUT writing a status —
    // dispatchAndAdvance deliberately leaves terminal state to this function rather than
    // racing it into 'failed' (see its catch). Without this the run reads 'cancelled' while
    // its active node_run stays 'running' forever.
    await cancelRemainingNodeRunsForRun(db, flowRunId);

    await cancelFlowLinkedTasks(db, flowRunId);
  }

  await emitCancelledFlowRun(flowRunId);
  return updated;
}

export async function cancelFlowRunForDeletion(flowRunId: string): Promise<void> {
  await cancelFlowRun(flowRunId);
  await cancelFlowLinkedTasks(getDatabase(), flowRunId, true);
  const admissionRuntime = await import('./admission/runtime');
  await admissionRuntime.requestFlowAdmissionRelease(flowRunId);
}

async function finalizeChatOwnedFlowCancellation(
  flowRunId: string,
  cancelWork: () => ReturnType<typeof cancelChatOwnedFlowWork>,
): Promise<void> {
  const outcome = await withFlowRunCancellationGuard(flowRunId, cancelWork);
  if (outcome !== 'cancelled') return;
  const admissionRuntime = await import('./admission/runtime');
  await admissionRuntime.requestFlowAdmissionRelease(flowRunId);
  await emitCancelledFlowRun(flowRunId);
}

export async function cancelFlowRunForChatDeletion(
  flowRunId: string,
  chatIds: string[],
): Promise<void> {
  await finalizeChatOwnedFlowCancellation(flowRunId, () =>
    cancelChatOwnedFlowWork(getDatabase(), flowRunId, chatIds, () => abortFlowRun(flowRunId)),
  );
}

async function cancelFlowRunForChatArchive(flowRunId: string, chatIds: string[]): Promise<void> {
  await finalizeChatOwnedFlowCancellation(flowRunId, () =>
    cancelChatOwnedFlowWorkForArchive(getDatabase(), flowRunId, chatIds, () =>
      abortFlowRun(flowRunId),
    ),
  );
}

async function cancelFlowRunsForChatImpl(chatId: string, failOnError: boolean): Promise<void> {
  const db = getDatabase();
  let flowRunIds: string[];
  try {
    flowRunIds = await listActiveFlowRunIdsForChat(db, chatId);
  } catch (error) {
    if (failOnError) throw error;
    log.warn('[FlowsEngine] cancelFlowRunsForChat lookup failed', { chatId, error });
    return;
  }
  for (const flowRunId of flowRunIds) {
    try {
      if (failOnError) await cancelFlowRunForChatDeletion(flowRunId, [chatId]);
      else await cancelFlowRunForChatArchive(flowRunId, [chatId]);
    } catch (error) {
      if (failOnError) throw error;
      log.warn('[FlowsEngine] cancelFlowRunsForChat failed', { chatId, flowRunId, error });
    }
  }
  try {
    cancelExecutingFlowTasksForChats(db, [chatId]);
  } catch (error) {
    if (failOnError) throw error;
    log.warn('[FlowsEngine] cancelFlowRunsForChat task cleanup failed', { chatId, error });
  }
  clearActiveFlowTaskForChat(chatId);
}

export async function cancelFlowRunsForChat(chatId: string): Promise<void> {
  return cancelFlowRunsForChatImpl(chatId, false);
}

export async function cancelFlowRunsForChatOrThrow(chatId: string): Promise<void> {
  return cancelFlowRunsForChatImpl(chatId, true);
}

export async function getFlowRunWithNodeRuns(
  flowRunId: string,
): Promise<{ run: FlowRun; nodeRuns: NodeRun[] } | null> {
  const db = getDatabase();
  const run = await getFlowRunRow(db, flowRunId);
  if (!run) return null;
  const nodeRuns = await listNodeRunsForFlowRun(db, flowRunId);
  return { run, nodeRuns };
}
