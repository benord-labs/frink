import { TRPCError } from '@trpc/server';
import type { z } from 'zod';
import type {
  RecoveryKind,
  resumeRunInputSchema,
} from '../../../../../shared/types/flow-run/resume';
import { getDatabase } from '../../../db';
import { FlowVersionConflictError, getVersion } from '../../../db/repos/flow-versions';
import type { FlowRun } from '../../../db/schema';
import { toDbFlowRunSnapshot, toDbFlowRunWithNodeRuns } from '../../../flows/adapters';
import {
  TerminalResumeAdmissionError,
  TerminalResumeChatDeletedError,
} from '../../../flows/admission/terminal-resume';
import { flowRunAdmissionSnapshotsForRuns } from '../../../flows/admission/visibility';
import {
  getFlowRunWithNodeRuns,
  LocalEngineNotImplementedError,
  resumeFlowRun,
} from '../../../flows/engine';

export function mapEngineError(
  error: unknown,
  fallback?: { code: 'PRECONDITION_FAILED'; message: string },
): never {
  if (error instanceof LocalEngineNotImplementedError) {
    throw new TRPCError({ code: 'NOT_IMPLEMENTED', message: error.message, cause: error });
  }
  if (error instanceof FlowVersionConflictError) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: error.message,
      cause: error,
    });
  }
  if (fallback) throw new TRPCError({ ...fallback, cause: error });
  throw error;
}

export function flowStartResponse(db: ReturnType<typeof getDatabase>, run: FlowRun) {
  const snapshot = flowRunAdmissionSnapshotsForRuns(db, [run.id]).get(run.id);
  const dto = toDbFlowRunSnapshot(run, snapshot);
  if (dto.started_at === null && dto.status !== 'pending') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Flow run did not start (${dto.status}).`,
    });
  }
  return dto;
}

/** Resume a stopped step, then return the refreshed run; engine refusals map to tRPC codes. */
export async function resumeRunAndReload(input: z.infer<typeof resumeRunInputSchema>) {
  try {
    const { runId, action, nodeRunId, expectedSnapshot } = input;
    const kind = input.action === 'retry' ? input.kind : undefined;
    await resumeFlowRun(runId, action, nodeRunId, expectedSnapshot, kind);
    return await loadRunDetail(runId);
  } catch (e) {
    mapEngineError(e);
  }
}

async function loadRunDetail(runId: string) {
  const detail = await getFlowRunWithNodeRuns(runId);
  if (!detail) throw new TRPCError({ code: 'NOT_FOUND', message: 'Flow run not found' });
  const version = await getVersion(getDatabase(), detail.run.flowVersionId);
  return toDbFlowRunWithNodeRuns(detail.run, detail.nodeRuns, version?.graph ?? null);
}

/** Re-admit a settled run from its last unfinished step, refused unless that step still recovers
 * as `kind` (the label the user clicked): the run-level recovery and a stopped task's. */
export async function retryRunFromLastNode(
  db: ReturnType<typeof getDatabase>,
  run: Pick<FlowRun, 'id' | 'status'>,
  kind: RecoveryKind,
): Promise<void> {
  if (run.status !== 'failed' && run.status !== 'cancelled' && run.status !== 'completed') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Flow run is ${run.status}; retry requires a settled run — use Continue instead.`,
    });
  }
  if (!(await retrySettledFlowRun(db, run.id, kind))) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Flow run context unavailable; flow or version may have been deleted.',
    });
  }
}

async function retrySettledFlowRun(
  db: ReturnType<typeof getDatabase>,
  flowRunId: string,
  kind: RecoveryKind,
): Promise<boolean> {
  try {
    const { retryTerminalFlowRun } =
      await import('../../../flows/admission/terminal-resume/dispatcher');
    return await retryTerminalFlowRun(db, flowRunId, kind);
  } catch (error) {
    if (!(error instanceof TerminalResumeAdmissionError)) throw error;
    // The deleted-chat refusal is already plain copy for the user — no admission prefix.
    if (error instanceof TerminalResumeChatDeletedError) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message, cause: error });
    }
    mapEngineError(error, {
      code: 'PRECONDITION_FAILED',
      message: `Flow retry could not be admitted: ${error.message}`,
    });
  }
}
