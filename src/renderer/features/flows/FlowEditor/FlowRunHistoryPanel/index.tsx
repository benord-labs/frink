/* eslint-disable max-lines, max-lines-per-function */
/**
 * Runs rail + run detail pane for the FlowEditor Runs tab (master/detail, n8n-style).
 * The rail lists batch groups + runs as compact selectable rows; the selected run's
 * detail (steps, recovery actions) renders in the big main pane via RunDetailPane —
 * never inline in the rail. The rail owns the flow's batch socket subscription
 * (sole subscriber — BatchMonitor and RunDetailPane rely on its invalidations).
 */

import { TRPCClientError } from '@trpc/client';
import { useAtomValue } from 'jotai';
import { Loader2, RotateCcw, XCircle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { DbFlowRun, DbFlowRunWithNodeRuns } from '../../../../../shared/types/flow-run';
import { trpc } from '../../../../lib/trpc';
import { isDesktopApp } from '../../../../lib/utils/platform';
import { flowLoopProgressAtomFamily } from '../../atoms';
import { shouldPollFlowAdmission, shouldShowPausedActions } from '../FlowRunStatusIcon';
import { BatchGroup } from './BatchGroup';
import {
  createNodeBurstRefreshScheduler,
  handleFlowExecutionSocketEvent,
  NODE_BURST_DEBOUNCE_MS,
} from './flow-run-history-socket-refresh';
import { NodeRunList } from './node-run-list';
import { PausedRunActions } from './PausedRunActions';
import { RecoverInterruptedAction } from './RecoverInterruptedAction';
import { RunDetailHeader } from './RunDetailHeader';
import { RunRow, runPresentation } from './RunRow';
import { buildRunHistoryBatchView } from './run-history-batch-view';

/** Same window as `listRuns` so `listBatches` returns API summaries for batches in the visible run list (fewer synthetic fallbacks in `buildRunHistoryBatchView`). */
const FLOW_RUN_HISTORY_PAGE_SIZE = 20;

/** Handler painting node statuses on the flow canvas from run detail. */
export type ViewRunOnCanvasHandler = (run: DbFlowRunWithNodeRuns) => void;

type FlowRunHistoryPanelProps = {
  flowId: string;
  /** The flow's persisted run target (graph.settings.currentBatchId) — gets the "Active" chip. */
  activeBatchId?: string;
  /** The batch driving the main monitor pane. */
  selectedBatchId: string | null;
  onSelectBatch: (batchId: string) => void;
  /** The run driving the main detail pane. */
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  /** When set, the matching row is highlighted as driving the canvas overlay. */
  canvasOverlayRunId?: string;
};

export function FlowRunHistoryPanel({
  flowId,
  activeBatchId,
  selectedBatchId,
  onSelectBatch,
  selectedRunId,
  onSelectRun,
  canvasOverlayRunId,
}: FlowRunHistoryPanelProps) {
  const utils = trpc.useUtils();
  const selectedRunIdRef = useRef(selectedRunId);
  selectedRunIdRef.current = selectedRunId;

  const cancelRunMutation = trpc.flows.cancelRun.useMutation({
    onSuccess: (_data, variables) => {
      const wasQueued = runs?.some(
        (run) => run.id === variables.runId && run.admission_state === 'queued',
      );
      toast.success(wasQueued ? 'Queued run cancelled' : 'Run stopped');
      void utils.flows.listRuns.invalidate({ flowId });
      void utils.flows.listBatches.invalidate({ flowId });
      void utils.flows.listBatchRuns.invalidate({ flowId });
      void utils.flows.listBatchStages.invalidate({ flowId });
      void utils.flows.list.invalidate();
      void utils.flows.get.invalidate({ id: flowId });
      void utils.flows.getRun.invalidate({ runId: variables.runId });
    },
    onError: (err, variables) => {
      if (err instanceof TRPCClientError && err.data?.code === 'CONFLICT') {
        toast.info('Run already finished');
        void utils.flows.listRuns.invalidate({ flowId });
        void utils.flows.listBatches.invalidate({ flowId });
        void utils.flows.listBatchRuns.invalidate({ flowId });
        void utils.flows.listBatchStages.invalidate({ flowId });
        void utils.flows.list.invalidate();
        void utils.flows.get.invalidate({ id: flowId });
        void utils.flows.getRun.invalidate({ runId: variables.runId });
        return;
      }
      toast.error(err.message || 'Could not stop run');
    },
  });

  const loopProgress = useAtomValue(flowLoopProgressAtomFamily(flowId));

  const {
    data: runs,
    isLoading,
    isError,
  } = trpc.flows.listRuns.useQuery(
    { flowId, limit: FLOW_RUN_HISTORY_PAGE_SIZE },
    {
      staleTime: 30_000,
      refetchInterval: (query) =>
        query.state.data?.some((run) => shouldPollFlowAdmission(run.status, run.admission_state))
          ? 5_000
          : false,
      refetchIntervalInBackground: false,
    },
  );

  const { data: batchSummaries } = trpc.flows.listBatches.useQuery(
    { flowId, limit: FLOW_RUN_HISTORY_PAGE_SIZE },
    { staleTime: 30_000 },
  );

  const { batched, unbatched, batchedRunsMap, ordinalMap } = (() => {
    if (!runs) {
      return {
        batched: [],
        unbatched: [],
        batchedRunsMap: new Map<string, DbFlowRun[]>(),
        ordinalMap: new Map<string, number>(),
      };
    }
    return buildRunHistoryBatchView(runs, batchSummaries);
  })();

  // Coalesce socket-driven refetches: node_* bursts debounce listRuns + getRun;
  // run lifecycle events invalidate immediately.
  useEffect(() => {
    if (!isDesktopApp()) return;
    if (!window.desktopApi?.onSocketFlowExecutionEvent) return;

    const invalidateListRuns = () => void utils.flows.listRuns.invalidate({ flowId });
    const invalidateGetRun = (runId: string) => void utils.flows.getRun.invalidate({ runId });
    const invalidateListBatches = () => void utils.flows.listBatches.invalidate({ flowId });
    const invalidateListBatchRuns = () => void utils.flows.listBatchRuns.invalidate({ flowId });
    const invalidateListBatchStages = () => void utils.flows.listBatchStages.invalidate({ flowId });

    const scheduler = createNodeBurstRefreshScheduler({
      delayMs: NODE_BURST_DEBOUNCE_MS,
      getExpandedRunId: () => selectedRunIdRef.current,
      invalidateListRuns,
      invalidateGetRun,
      invalidateListBatches,
      invalidateListBatchRuns,
      invalidateListBatchStages,
    });

    const unsubscribe = window.desktopApi.onSocketFlowExecutionEvent((event) => {
      handleFlowExecutionSocketEvent(event, {
        panelFlowId: flowId,
        expandedRunId: selectedRunIdRef.current,
        scheduler,
        invalidateListRuns,
        invalidateGetRun,
        invalidateListBatches,
        invalidateListBatchRuns,
        invalidateListBatchStages,
      });
    });

    return () => {
      scheduler.flush();
      unsubscribe();
    };
  }, [flowId, utils]);

  const runRow = (run: DbFlowRun) => (
    <RunRow
      key={run.id}
      run={run}
      loopProgress={run.status === 'running' ? loopProgress : undefined}
      isSelected={selectedRunId === run.id}
      isCanvasOverlayRow={canvasOverlayRunId === run.id}
      onSelect={() => onSelectRun(run.id)}
      onStopRun={(runId) => cancelRunMutation.mutate({ runId })}
      stopPending={cancelRunMutation.isPending && cancelRunMutation.variables?.runId === run.id}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-transparent">
      <div className="flex shrink-0 items-center justify-between border-b border-border/40 px-3 pb-2.5 pt-3">
        <h2 className="text-sm font-semibold leading-tight text-foreground">Runs</h2>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {isLoading && (
          <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading…
          </div>
        )}
        {isError && (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <XCircle className="h-7 w-7 text-destructive/50" aria-hidden />
            <p className="text-sm text-muted-foreground">Could not load run history.</p>
            <p className="text-xs text-muted-foreground/60">Check your connection and try again.</p>
          </div>
        )}
        {!isLoading && !isError && (!runs || runs.length === 0) && (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <RotateCcw className="h-7 w-7 text-muted-foreground/30" aria-hidden />
            <p className="text-sm text-muted-foreground">No runs yet.</p>
            <p className="text-xs text-muted-foreground/60">Run the flow to see history here.</p>
          </div>
        )}
        {runs && runs.length > 0 && (
          <ul className="divide-y divide-border/35">
            {batched.map((summary) => {
              const batchRuns = batchedRunsMap.get(summary.batch_id) ?? [];
              const ordinal = ordinalMap.get(summary.batch_id) ?? 1;
              return (
                <BatchGroup
                  key={summary.batch_id}
                  summary={summary}
                  ordinal={ordinal}
                  visibleRunCount={batchRuns.length}
                  isSelected={selectedBatchId === summary.batch_id && selectedRunId === null}
                  isActiveBatch={activeBatchId === summary.batch_id}
                  onSelect={() => onSelectBatch(summary.batch_id)}
                >
                  {batchRuns.map(runRow)}
                </BatchGroup>
              );
            })}
            {unbatched.map(runRow)}
          </ul>
        )}
      </div>
    </div>
  );
}

type RunDetailPaneProps = {
  flowId: string;
  runId: string;
  /** Lightweight list snapshot; keeps queue metadata fresh without polling full node output. */
  runSummary?: DbFlowRun;
  /** Paint node statuses on the flow canvas (terminal runs only). */
  onViewOnCanvas?: ViewRunOnCanvasHandler;
  /** Clear the run selection (back to the batch view). Omitted when there is nothing to go back to. */
  onBack?: () => void;
  /** Label for the back target (e.g. "Batch 2"). */
  backLabel?: string;
};

/**
 * The Runs tab's main-pane detail for one selected run: meta header, step list, and
 * recovery actions (approve/retry/skip, restart-interruption Continue/Retry, view on canvas).
 */
export function RunDetailPane({
  flowId,
  runId,
  runSummary,
  onViewOnCanvas,
  onBack,
  backLabel,
}: RunDetailPaneProps) {
  const utils = trpc.useUtils();
  const { data: detail, isLoading } = trpc.flows.getRun.useQuery({ runId }, { staleTime: 30_000 });

  const resumeRunMutation = trpc.flows.resumeRun.useMutation({
    onError: (err) => {
      toast.error(err.message || 'Could not resume run');
    },
    // Awaited (also after a refusal), so the actions stay disabled until the refetched run lands.
    onSettled: (_data, _err, variables) =>
      Promise.all([
        utils.flows.listRuns.invalidate({ flowId }),
        utils.flows.listBatches.invalidate({ flowId }),
        utils.flows.listBatchRuns.invalidate({ flowId }),
        utils.flows.listBatchStages.invalidate({ flowId }),
        utils.flows.getRun.invalidate({ runId: variables.runId }),
      ]),
  });

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading run…
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
        This run is no longer available.
      </div>
    );
  }

  const visibleDetail = runSummary?.id === detail.id ? { ...detail, ...runSummary } : detail;
  const presentation = runPresentation(visibleDetail);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <RunDetailHeader
        runId={runId}
        run={visibleDetail}
        presentation={presentation}
        onViewOnCanvas={onViewOnCanvas}
        onBack={onBack}
        backLabel={backLabel}
      />

      {/* Steps + recovery actions */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-4 pb-4 pt-2">
        <NodeRunList
          flowRunId={visibleDetail.id}
          graph={visibleDetail.graph}
          nodeRuns={visibleDetail.nodeRuns}
        />
        {shouldShowPausedActions(
          visibleDetail.status,
          visibleDetail.active_task_status,
          visibleDetail.admission_state,
        ) && (
          <PausedRunActions
            detail={visibleDetail}
            // Settles once onSettled's refetch lands; a failure is already toasted by onError.
            onResumeRun={(request) =>
              resumeRunMutation.mutateAsync({ runId: visibleDetail.id, ...request }).then(
                () => undefined,
                () => undefined,
              )
            }
            resumePending={resumeRunMutation.isPending}
            pendingResumeAction={
              resumeRunMutation.isPending ? resumeRunMutation.variables?.action : undefined
            }
            pendingResumeNodeRunId={
              resumeRunMutation.isPending ? resumeRunMutation.variables?.nodeRunId : undefined
            }
          />
        )}
        {presentation.recoveryStatus === 'cancelled' && (
          <RecoverInterruptedAction flowId={flowId} run={visibleDetail} />
        )}
      </div>
    </div>
  );
}
