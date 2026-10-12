/**
 * Run-state + run actions for ONE flow batch — any batch, not just the flow's active one.
 * Consumed by the FlowEditor header FlowRunButton (the single run-action surface,
 * targeting the batch the user is looking at) so every surface derives identical state and shares
 * the same query invalidations. Recovering a batch that has already run is per-member (Continue /
 * Retry in each run's chat); this hook only starts never-run batches.
 */

import { useCallback, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { trpc } from '../trpc';
import { batchStartedMessage } from '../utils/flow-run-dispatch';
import {
  type BatchRunState,
  deriveBatchRunState,
  type StageRunCounts,
} from '../utils/batch-run-state';

export type BatchRunActions = {
  /** null when no batch — the caller renders the plain single-run path. */
  runState: BatchRunState | null;
  /** The batch has planned-but-never-dispatched root stages → "Start Batch" label. */
  hasDeferredRoots: boolean;
  isPending: boolean;
  /** Start (or advance) this batch's root stages. `hadUnsavedChanges` only shapes the toast copy. */
  startBatch: (hadUnsavedChanges?: boolean) => void;
};

type TrpcUtils = ReturnType<typeof trpc.useUtils>;

type BatchActionResult = { started: boolean; reason?: string };

type DeferredStageRow = StageRunCounts & {
  // biome-ignore lint/style/useNamingConvention: mirrors the snake_case BatchStageDetail (tRPC/DB) shape
  depends_on_stage_numbers: number[];
};

function invalidateBatchQueries(utils: TrpcUtils, flowId: string): void {
  void utils.flows.listBatches.invalidate({ flowId });
  void utils.flows.listBatchRuns.invalidate({ flowId });
  void utils.flows.listBatchStages.invalidate({ flowId });
  void utils.flows.list.invalidate();
}

/** The server's un-startable `reason` codes in the user's words; anything else falls back. */
function noStartCopy(reason: string | undefined, fallback: string): string {
  if (reason === 'no-stages-defined') return 'No batch stages are planned yet.';
  if (reason === 'no-root-stages')
    return 'Every stage depends on another — no root stage to start.';
  if (reason === 'all-roots-started') return 'Every root stage has already started.';
  return fallback;
}

/** Shared mutation success handler: same toast shape + invalidations, differing only in copy. */
function batchActionSuccess(
  utils: TrpcUtils,
  flowId: string,
  emptyMsg: string,
  runSingle: (hadUnsavedChanges: boolean) => void,
  hadUnsavedChanges: () => boolean,
) {
  return (result: BatchActionResult): void => {
    // The server owns the stage-existence check, so routing on its answer is atomic — a client-side
    // pre-check can always be overtaken by an agent or another window planning the first stage.
    // The unsaved-edits notice rides on the outcome toast, so a no-op or fallback never shows it twice.
    if (result.started) toast.success(batchStartedMessage(hadUnsavedChanges()));
    else if (result.reason === 'no-stages-defined') runSingle(hadUnsavedChanges());
    else toast.info(noStartCopy(result.reason, emptyMsg));
    invalidateBatchQueries(utils, flowId);
  };
}

/** True when the batch has planned-but-never-dispatched root stages. */
function hasDeferredRootStages(stages: DeferredStageRow[]): boolean {
  return stages.some(
    (s) => s.status === 'pending' && s.depends_on_stage_numbers.length === 0 && s.run_count > 0,
  );
}

export function useBatchRunActions(
  flowId: string,
  batchId: string | null,
  runSingle: (hadUnsavedChanges: boolean) => void,
): BatchRunActions {
  const utils = trpc.useUtils();
  const enabled = batchId !== null;

  // Same cadence as the pre-refactor header query: cheap poll to catch deferred roots settling.
  const { data: stagesData } = trpc.flows.listBatchStages.useQuery(
    { flowId, batchId: batchId ?? '' },
    {
      enabled,
      staleTime: 10_000,
      refetchInterval: enabled ? 10_000 : false,
      refetchIntervalInBackground: false,
    },
  );

  // Resolved-empty means "no batch yet"; absent data (loading or errored) must NOT collapse to the
  // same answer — a single run against a real batch renders {{trigger.*}} literally.
  const runState = useMemo(() => {
    if (!batchId) return null;
    if (stagesData?.stages?.length === 0) return null;
    return deriveBatchRunState(stagesData?.stages ?? []);
  }, [batchId, stagesData]);

  // Captured per startBatch call; one start is in flight at a time (the Run button and hotkey
  // both gate on isPending), so the flag read in onSuccess belongs to that call.
  const hadUnsavedChangesRef = useRef(false);
  const startBatchMutation = trpc.flows.startBatch.useMutation({
    onSuccess: batchActionSuccess(
      utils,
      flowId,
      'Nothing was queued—root stages may already be running or another tab started this batch.',
      runSingle,
      () => hadUnsavedChangesRef.current,
    ),
    onError: (err) => toast.error(err.message || 'Could not start batch'),
  });

  const startBatch = useCallback(
    (hadUnsavedChanges = false) => {
      if (!batchId) return;
      hadUnsavedChangesRef.current = hadUnsavedChanges;
      startBatchMutation.mutate({ flowId, batchId });
    },
    [batchId, flowId, startBatchMutation],
  );

  return {
    runState,
    hasDeferredRoots: enabled && hasDeferredRootStages(stagesData?.stages ?? []),
    isPending: startBatchMutation.isPending,
    startBatch,
  };
}
