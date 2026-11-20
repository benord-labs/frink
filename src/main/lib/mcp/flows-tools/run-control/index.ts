/** The Work Queue row's Carry on / Retry, typed reply and Cancel for an agent: it gets no more than
 *  the row offers a person. */

import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { flowRowRecovery } from '../../../../../shared/lib/task-recovery/menu-gate';
import type { RecoveryKind } from '../../../../../shared/types/flow-run/resume';
import { getDatabase } from '../../../db';
import { getFlowRun } from '../../../db/repos/flow-runs';
import { getQueueTaskRowForRun, type TaskWithProjectRow } from '../../../db/repos/task-queries';
import { linkedFlowRunIds } from '../../../db/repos/task-queries/linked-flow-runs';
import { flowRuns, subChats } from '../../../db/schema';
import { isCancellableRunStatus } from '../../../flows/transitions/run-rows';
import { MobileApiError } from '../../../mobile/domain/errors';
import { type McpToolResult, toolResult } from '../../tool-result';
import { localIdField, parseAndAcquire, runControlLimiter } from '../gating/session-call-limiters';

const continueRunSchema = z.object({
  runId: localIdField('runId'),
  nodeRunId: localIdField('nodeRunId').optional(),
  message: z.string().trim().min(1).max(10000).optional(),
});
const cancelRunSchema = z.object({ runId: localIdField('runId') });

const LIMIT_MESSAGE =
  'Run control limit reached (20 continue/cancel calls per session). Ask the user to finish the rest in the Work Queue.';
const NOT_OFFERED =
  'The Work Queue offers no Continue for this run. It may be waiting on a person (an Approval, a plan review or a Start), still running, finished, or its retry may repeat what the step already did. Ask the user to handle it in the Work Queue.';
const NEEDS_REPLY =
  'This step is waiting for a reply. Call again with message: what the step should know to carry on.';
const NOT_WAITING_FOR_REPLY =
  'This run is not waiting for a reply. Call again without message, or ask the user.';
const SECRET_REQUEST =
  'This step is waiting for a secret, which only the user can enter in its form. Ask the user.';

export type RunControlContext = { executionId?: string; sessionId?: string };
type ContinueArgs = z.infer<typeof continueRunSchema>;
type StoppedRow = TaskWithProjectRow & {
  recoveryKind?: RecoveryKind;
  confirmSideEffects: boolean;
  recoveryNodeRunId?: string;
};

const CHANGED =
  'The step is busy, running or changed since you inspected it. Inspect the run again with frink_flows_get_run, and wait while it runs.';

/** The refusal reworded for an agent: the shared paths word theirs for a person at a screen. */
function errorText(error: unknown): string {
  if (error instanceof MobileApiError) {
    return error.status === 404 ? "The step's chat is gone (deleted or archived)." : CHANGED;
  }
  if (error instanceof TRPCError && (error.code === 'PRECONDITION_FAILED' || error.code === 'CONFLICT'))
    return CHANGED;
  return error instanceof Error ? error.message : String(error);
}

/** Any live run the calling chat takes part in, not only its newest. */
function isCallersRun(runId: string, sessionId: string): boolean {
  const db = getDatabase();
  const linked = linkedFlowRunIds(db, 'subChatId', sessionId, { currentLanesOnly: true });
  const row = db
    .select({ id: flowRuns.id })
    .from(flowRuns)
    .where(
      and(
        eq(flowRuns.id, runId),
        inArray(flowRuns.status, ['pending', 'running', 'paused']),
        inArray(flowRuns.id, linked),
      ),
    )
    .get();
  return Boolean(row);
}

/** The run being acted on, or the refusal: an unknown run, or the calling chat's own run. */
async function resolveTargetRun(runId: string, sessionId: string | undefined) {
  const db = getDatabase();
  const run = await getFlowRun(db, runId);
  if (!run) return { refusal: toolResult(`Flow run ${runId} not found.`, true) };
  if (sessionId && isCallersRun(runId, sessionId)) {
    return {
      refusal: toolResult(
        'This is your own run. Report your outcome with frink_task_signal instead.',
        true,
      ),
    };
  }
  return { run };
}

/** The run's Work Queue row with the recovery the queue shows on it. */
async function stoppedRowForRun(runId: string): Promise<StoppedRow | null> {
  const db = getDatabase();
  const queued = await getQueueTaskRowForRun(db, runId);
  if (!queued) return null;
  const { withStoppedTaskRecoveries } = await import('../../../trpc/routers/tasks-subchat');
  const [row] = await withStoppedTaskRecoveries(db, [queued]);
  return row ?? null;
}

function resultRecord(result: unknown): Record<string, unknown> {
  return typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
}

const isSecretPark = (result: unknown) =>
  Boolean(resultRecord(resultRecord(result).agentSignal).secretRequest);

/** The typed reply a person sends from the step's chat, guarded on the step still waiting. */
async function replyToRun(row: StoppedRow, args: ContinueArgs): Promise<McpToolResult> {
  const subChatId = resultRecord(row.result).subChatId;
  if (row.effectiveStatus !== 'needs_attention' || typeof subChatId !== 'string') {
    return toolResult(NOT_WAITING_FOR_REPLY, true);
  }
  const subChat = getDatabase()
    .select({ chatId: subChats.chatId })
    .from(subChats)
    .where(eq(subChats.id, subChatId))
    .get();
  if (!subChat) return toolResult(NOT_WAITING_FOR_REPLY, true);
  const { sendMobileMessage } = await import('../../../mobile/domain/chat');
  await sendMobileMessage(
    { chatId: subChat.chatId, subChatId, requestId: randomUUID(), text: args.message ?? '' },
    { expectedFlowTaskId: row.id },
  );
  return toolResult(JSON.stringify({ runId: args.runId, outcome: 'replied' }));
}

/** The Work Queue's Carry on / Retry, pinned to the step it was offered on. */
async function recoverRun(row: StoppedRow, runId: string): Promise<McpToolResult> {
  // An agent cannot give the side-effect confirm, so such a Retry is never offered to it.
  const kind = flowRowRecovery(row, row.effectiveStatus, false);
  if (!kind) return toolResult(row.status === 'needs_attention' ? NEEDS_REPLY : NOT_OFFERED, true);
  const { tasksRouter } = await import('../../../trpc/routers/tasks');
  const { outcome } = await tasksRouter.createCaller({ getWindow: () => null }).recover({
    taskId: row.id,
    kind,
    recoveryNodeRunId: row.recoveryNodeRunId,
  });
  return toolResult(JSON.stringify({ runId, kind, outcome }));
}

export async function handleContinueRun(
  args: Record<string, unknown>,
  context: RunControlContext,
): Promise<McpToolResult> {
  const { data, refusal } = parseAndAcquire(
    continueRunSchema,
    args,
    context.executionId,
    runControlLimiter,
    LIMIT_MESSAGE,
  );
  if (refusal) return refusal;
  const target = await resolveTargetRun(data.runId, context.sessionId);
  if (target.refusal) return target.refusal;
  const row = await stoppedRowForRun(data.runId);
  if (!row) return toolResult(NOT_OFFERED, true);
  if (isSecretPark(row.result)) return toolResult(SECRET_REQUEST, true);
  if (data.nodeRunId !== undefined && data.nodeRunId !== (row.recoveryNodeRunId ?? row.nodeRunId)) {
    return toolResult(
      'That step is no longer the one to continue. Inspect the run again with frink_flows_get_run.',
      true,
    );
  }
  const { executionReady } = await import('../../../mobile/domain/context');
  if (!executionReady()) {
    return toolResult('Frink has no open window to run the step in. Ask the user to open it.', true);
  }
  try {
    return data.message ? await replyToRun(row, data) : await recoverRun(row, data.runId);
  } catch (error) {
    return toolResult(`Could not continue the run: ${errorText(error)}`, true);
  }
}

/** A finished run the Work Queue's Cancel still acts on: a queued Retry, or a restart interruption. */
async function leavesWorkToCancel(row: TaskWithProjectRow | null): Promise<boolean> {
  if (!row?.flowRunId) return false;
  if (row.effectiveStatus === 'interrupted') return true;
  const { hasQueuedResume } = await import('../../../trpc/routers/tasks-recovery');
  return hasQueuedResume(row.flowRunId);
}

export async function handleCancelRun(
  args: Record<string, unknown>,
  context: RunControlContext,
): Promise<McpToolResult> {
  const { data, refusal } = parseAndAcquire(
    cancelRunSchema,
    args,
    context.executionId,
    runControlLimiter,
    LIMIT_MESSAGE,
  );
  if (refusal) return refusal;
  const target = await resolveTargetRun(data.runId, context.sessionId);
  if (target.refusal) return target.refusal;
  const db = getDatabase();
  const row = await getQueueTaskRowForRun(db, data.runId);
  if (!isCancellableRunStatus(target.run.status) && !(await leavesWorkToCancel(row))) {
    return toolResult(`This run has already finished (${target.run.status}).`, true);
  }
  try {
    if (row) {
      const { cancelWorkQueueTask } = await import('../../../tasks/cancel-work-queue-task');
      const { task, reason } = await cancelWorkQueueTask(db, row.id);
      if (!task) return toolResult(`Could not cancel the run (${reason ?? 'unknown'}).`, true);
    } else {
      // No task yet (a held or never-dispatched run): the run itself is all there is to stop.
      const { cancelFlowRun } = await import('../../../flows/engine');
      await cancelFlowRun(data.runId);
    }
  } catch (error) {
    return toolResult(`Could not cancel the run: ${errorText(error)}`, true);
  }
  const after = await getFlowRun(db, data.runId);
  return toolResult(JSON.stringify({ runId: data.runId, status: after?.status ?? 'cancelled' }));
}
