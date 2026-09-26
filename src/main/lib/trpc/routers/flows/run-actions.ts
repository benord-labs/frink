import { TRPCError } from '@trpc/server';
import type { getDatabase } from '../../../db';
import { FlowVersionConflictError } from '../../../db/repos/flow-versions';
import type { FlowRun } from '../../../db/schema';
import { toDbFlowRunSnapshot } from '../../../flows/adapters';
import { TerminalResumeAdmissionError } from '../../../flows/admission/terminal-resume';
import { flowRunAdmissionSnapshotsForRuns } from '../../../flows/admission/visibility';
import { LocalEngineNotImplementedError } from '../../../flows/engine';

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

export async function retrySettledFlowRun(
  db: ReturnType<typeof getDatabase>,
  flowRunId: string,
): Promise<boolean> {
  try {
    const { retryTerminalFlowRun } =
      await import('../../../flows/admission/terminal-resume/dispatcher');
    return await retryTerminalFlowRun(db, flowRunId);
  } catch (error) {
    if (!(error instanceof TerminalResumeAdmissionError)) throw error;
    mapEngineError(error, {
      code: 'PRECONDITION_FAILED',
      message: `Flow retry could not be admitted: ${error.message}`,
    });
  }
}
