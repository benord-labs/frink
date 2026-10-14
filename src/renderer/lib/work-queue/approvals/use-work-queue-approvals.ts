import { useState } from 'react';
import { toast } from 'sonner';
import { openFlowRunAtom } from '../../atoms';
import { appStore } from '../../jotai-store';
import { trpc } from '../../trpc';

/** Runs waiting on an Approval step, polled like the rest of the Work Queue. */
export function useAwaitingApprovals() {
  const { data } = trpc.flows.workQueueApprovals.useQuery(undefined, {
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
    structuralSharing: true,
  });
  return data ?? [];
}

/** A live Flow run waiting on its Approval step, one per run; `nodeRunId` is null when several wait. */
export type AwaitingApproval = ReturnType<typeof useAwaitingApprovals>[number];

type ApprovalAction = 'approve' | 'cancel';
type TrpcUtils = ReturnType<typeof trpc.useUtils>;

export type ApprovalActions = {
  approve: (gate: AwaitingApproval) => void;
  cancel: (gate: AwaitingApproval) => void;
  openRun: (gate: AwaitingApproval) => void;
  /** The action in flight per run; only that run's buttons wait on it. */
  pending: ReadonlyMap<string, ApprovalAction>;
};

/** Refreshes the queue, then explains a refusal: a gate gone from the refreshed list was handled elsewhere. */
async function settleApprovalAction(
  utils: TrpcUtils,
  runId: string,
  error: { message: string } | null,
  failureTitle: string,
): Promise<void> {
  await Promise.all([
    utils.flows.invalidate(),
    utils.tasks.listPaginated.invalidate(),
    utils.tasks.workQueueOverviewCounts.invalidate(),
    utils.tasks.listCounts.invalidate(),
  ]);
  if (!error) return;
  if (utils.flows.workQueueApprovals.getData()?.some((gate) => gate.flowRunId === runId)) {
    toast.error(failureTitle, { description: error.message || 'Please try again.' });
    return;
  }
  toast.info('Already handled', {
    description: 'This approval was answered, or its run stopped, somewhere else.',
  });
}

function withPending(
  current: ReadonlyMap<string, ApprovalAction>,
  runId: string,
  action: ApprovalAction | null,
): ReadonlyMap<string, ApprovalAction> {
  const next = new Map(current);
  if (action) next.set(runId, action);
  else next.delete(runId);
  return next;
}

/** Approve through the Runs panel's own resume, or cancel the run as its Stop does. */
export function useApprovalActions(): ApprovalActions {
  const utils = trpc.useUtils();
  const [pending, setPending] = useState<ReadonlyMap<string, ApprovalAction>>(new Map());
  const track = (runId: string, action: ApprovalAction | null) =>
    setPending((current) => withPending(current, runId, action));
  const settle = (runId: string, error: { message: string } | null, failureTitle: string) =>
    settleApprovalAction(utils, runId, error, failureTitle).finally(() => track(runId, null));
  const resume = trpc.flows.resumeRun.useMutation({
    onSettled: (_data, error, { runId }) => settle(runId, error, 'Could not approve'),
  });
  const cancelRun = trpc.flows.cancelRun.useMutation({
    onSettled: (_data, error, { runId }) => settle(runId, error, 'Could not cancel the run'),
  });

  return {
    approve: (gate) => {
      if (!gate.nodeRunId) return;
      track(gate.flowRunId, 'approve');
      resume.mutate({ runId: gate.flowRunId, action: 'approve', nodeRunId: gate.nodeRunId });
    },
    cancel: (gate) => {
      track(gate.flowRunId, 'cancel');
      cancelRun.mutate({ runId: gate.flowRunId });
    },
    openRun: (gate) =>
      appStore.set(openFlowRunAtom, { flowId: gate.flowId, runId: gate.flowRunId }),
    pending,
  };
}
