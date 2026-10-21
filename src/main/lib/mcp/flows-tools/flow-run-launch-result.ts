import type { DbFlowRun } from '../../flows/mcp-cloud-shim';

type LaunchRun = DbFlowRun & {
  batchId?: string | null;
  flowRunId?: string;
};

/** `heldByWaitingRuns`: slots held by paused runs waiting on the user, named when a run queues. */
const waitingNote = (held: number): string =>
  held > 0 ? ` ${held} ${held === 1 ? 'slot is' : 'slots are'} held by runs waiting on the user.` : '';

export function buildFlowRunLaunchResult(flowId: string, run: LaunchRun, heldByWaitingRuns = 0) {
  const queued = run.started_at === null && run.status === 'pending';
  const started = typeof run.started_at === 'string';
  const queuePosition = run.admission_state === 'queued' ? (run.queue_position ?? null) : null;
  const common = {
    flowId,
    flowRunId: run.flowRunId ?? run.id,
    batchId: run.batchId ?? run.batch_id ?? null,
    runStatus: run.status,
    admissionState: run.admission_state ?? null,
  };

  if (!queued && !started) {
    return {
      isError: true,
      body: {
        success: false,
        ...common,
        status: 'not_started',
        queuePosition: null,
        message: `Flow run did not start (${run.status}).`,
      },
    };
  }

  return {
    isError: false,
    body: {
      success: true,
      ...common,
      status: queued ? 'queued' : 'started',
      queuePosition,
      message: queued
        ? `Flow run queued${queuePosition == null ? '' : ` at position #${queuePosition}`}.${waitingNote(heldByWaitingRuns)} The user can monitor progress in the Flows page → Run history.`
        : 'Flow run started. The user can monitor progress in the Flows page → Run history.',
    },
  };
}
