/**
 * Starts the flow's latest SAVED version; `hadUnsavedChanges` (captured at dispatch) shapes the toast.
 */

import { useCallback } from 'react';
import { toast } from 'sonner';
import { trpc } from '../trpc';
import { runStartedMessage } from '../utils/flow-run-dispatch';

export function useSingleFlowRun(flowId: string): {
  startSingleRun: (hadUnsavedChanges: boolean) => void;
  isPending: boolean;
} {
  const utils = trpc.useUtils();
  const runMutation = trpc.flows.startRun.useMutation({
    onSuccess: () => {
      void utils.flows.listRuns.invalidate({ flowId });
      void utils.flows.listBatches.invalidate({ flowId });
      void utils.flows.listBatchRuns.invalidate({ flowId });
      void utils.flows.list.invalidate();
    },
    onError: (err) => {
      toast.error(err.message || 'Could not start run');
    },
  });

  const { mutate } = runMutation;
  const startSingleRun = useCallback(
    (hadUnsavedChanges: boolean) => {
      mutate(
        { flowId, triggerContext: null },
        {
          onSuccess: (run) => {
            toast.success(
              runStartedMessage({
                status: run.status,
                versionNumber: run.version_number,
                hadUnsavedChanges,
              }),
            );
          },
        },
      );
    },
    [flowId, mutate],
  );

  return { startSingleRun, isPending: runMutation.isPending };
}
