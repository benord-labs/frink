import type { DbFlowRun } from '../../flows/mcp-cloud-shim';

type LaunchRun = DbFlowRun & {
  batchId?: string | null;
  flowRunId?: string;
};

export function buildFlowRunLaunchResult(flowId: string, run: LaunchRun) {
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
        ? `Flow run queued${queuePosition == null ? '' : ` at position #${queuePosition}`}. The user can monitor progress in the Flows page → Run history.`
        : 'Flow run started. The user can monitor progress in the Flows page → Run history.',
    },
  };
}
