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
import { getFlowRun as getFlowRunRow, listActiveFlowRunIdsForChat } from '../db/repos/flow-runs';
import { listNodeRunsForFlowRun } from '../db/repos/node-runs';
import {
  type ChatOwnedFlowCancellation,
  cancelChatOwnedFlowWork,
  cancelChatOwnedFlowWorkForArchive,
  cancelExecutingFlowTasksForChats,
} from '../db/repos/task-queries/chat-flow-cleanup';
import type { FlowRun, NodeRun } from '../db/schema';
import { clearActiveFlowTaskForChat } from '../task-executor';
import { loadRunContext } from './advance';
import { dropStagedContinuation } from './admission/terminal-resume/continuation';
import { abortFlowRun } from './cancel-registry';
import { emitRunTerminal } from './event-emit';
import { type CancelRunOutcome, cancelRunCommand, cancelWorkQueueRunCommand } from './transitions';

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

function reportCommittedCancelStep(
  flowRunId: string,
  stage: 'terminal-event' | 'release',
  error: unknown,
): void {
  log.error('[FlowsEngine] post-cancel step failed', { flowRunId, stage, error });
  captureMainException(error, { surface: 'flow-cancel', stage });
}

async function emitCancelledFlowRun(flowRunId: string): Promise<void> {
  // Every caller emits after its Cancel committed; a failed delivery must not report it as failed.
  // The startup batch sweep settles the stage this event would have settled.
  try {
    const ctx = await loadRunContext(flowRunId);
    if (ctx) emitRunTerminal(ctx.meta, flowRunId, 'cancelled');
    else log.warn('[FlowsEngine] cancelFlowRun: run context unavailable', { flowRunId });
  } catch (error) {
    reportCommittedCancelStep(flowRunId, 'terminal-event', error);
  }
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
  await emitCancelledFlowRun(flowRunId);
  return updated;
}

/** Restrict a cancellation to this exact ticket, while it still waits in the queue. */
export type CancelQueuedOnly = { ticket: number };

async function dequeueFlowRun(flowRunId: string, queuedOnly: CancelQueuedOnly) {
  const run = await getFlowRunRow(getDatabase(), flowRunId);
  if (!run) return null;
  const admissionRuntime = await import('./admission/runtime');
  const dequeued = await admissionRuntime.cancelUndispatchedFlowAdmission(flowRunId, {
    states: ['queued'],
    ticket: queuedOnly.ticket,
  });
  return dequeuedFlowRun(flowRunId, run, dequeued);
}

/** One Cancel command: aborts in the commit's tick, then drains a dropped ticket and emits once. */
async function commitCancel<T extends CancelRunOutcome>(
  flowRunId: string,
  command: () => T | null,
  touched: (outcome: T) => boolean = (outcome) => outcome.cancelled,
) {
  const admissionRuntime = await import('./admission/runtime');
  const outcome = await admissionRuntime.transitionFlowRun(command, (result) => {
    if (!result || !touched(result)) return;
    abortFlowRun(flowRunId);
    dropStagedContinuation(flowRunId);
  });
  if (outcome?.droppedTicket) void admissionRuntime.drainFlowAdmissions().catch(() => undefined);
  if (outcome?.cancelled) await emitCancelledFlowRun(flowRunId);
  return outcome;
}

async function releaseFlowAdmission(flowRunId: string, ticket: number | null): Promise<void> {
  if (ticket === null) return;
  const admissionRuntime = await import('./admission/runtime');
  // The Cancel has committed. A slot left active or releasing is reconciled by an executing run's
  // dispatch cleanup or, for a parked or paused run, by startup recovery.
  await admissionRuntime
    .requestFlowAdmissionRelease(flowRunId, ticket)
    .catch((error) => reportCommittedCancelStep(flowRunId, 'release', error));
}

/**
 * Cancel an in-flight or pending flow run. A terminal run keeps its status; only its undispatched
 * ticket (a queued Retry) is dropped.
 *
 * `queuedOnly` makes the cancellation a dequeue: the run is left untouched unless its admission
 * is still queued, so work the scheduler has already claimed is never preempted by a stale click.
 */
export async function cancelFlowRun(
  flowRunId: string,
  options: { queuedOnly?: CancelQueuedOnly } = {},
): Promise<FlowRun | null> {
  if (options.queuedOnly) return dequeueFlowRun(flowRunId, options.queuedOnly);
  const outcome = await commitCancel(flowRunId, () =>
    cancelRunCommand(getDatabase(), flowRunId, { includeParked: false }),
  );
  if (outcome?.cancelled) await releaseFlowAdmission(flowRunId, outcome.liveTicket);
  return outcome?.run ?? null;
}

export async function cancelFlowRunForDeletion(flowRunId: string): Promise<void> {
  const outcome = await commitCancel(flowRunId, () =>
    cancelRunCommand(getDatabase(), flowRunId, { includeParked: true }),
  );
  await releaseFlowAdmission(flowRunId, outcome?.liveTicket ?? null);
}

/** Work Queue Cancel of a flow row (see cancelWorkQueueRunCommand); null when the run is missing. */
export async function cancelFlowRunFromWorkQueue(flowRunId: string, clickedTaskId: string) {
  const outcome = await commitCancel(
    flowRunId,
    () => cancelWorkQueueRunCommand(getDatabase(), flowRunId, clickedTaskId),
    (result) => result.touched,
  );
  if (outcome?.cancelled) await releaseFlowAdmission(flowRunId, outcome.liveTicket);
  return outcome;
}

async function finalizeChatOwnedFlowCancellation(
  flowRunId: string,
  cancelWork: () => ChatOwnedFlowCancellation,
): Promise<void> {
  const admissionRuntime = await import('./admission/runtime');
  const { outcome, droppedTicket, liveTicket } = await admissionRuntime.transitionFlowRun(
    cancelWork,
    (result) => {
      if (result.outcome !== 'cancelled') return;
      abortFlowRun(flowRunId);
      dropStagedContinuation(flowRunId);
    },
  );
  if (droppedTicket) void admissionRuntime.drainFlowAdmissions().catch(() => undefined);
  if (outcome !== 'cancelled') return;
  await emitCancelledFlowRun(flowRunId);
  await releaseFlowAdmission(flowRunId, liveTicket);
}

export async function cancelFlowRunForChatDeletion(
  flowRunId: string,
  chatIds: string[],
): Promise<void> {
  await finalizeChatOwnedFlowCancellation(flowRunId, () =>
    cancelChatOwnedFlowWork(getDatabase(), flowRunId, chatIds),
  );
}

async function cancelFlowRunForChatArchive(flowRunId: string, chatIds: string[]): Promise<void> {
  await finalizeChatOwnedFlowCancellation(flowRunId, () =>
    cancelChatOwnedFlowWorkForArchive(getDatabase(), flowRunId, chatIds),
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
