/* eslint-disable max-lines, max-lines-per-function */
/**
 * Runs rail + run detail pane for the FlowEditor Runs tab (master/detail, n8n-style).
 * The rail lists batch groups + runs as compact selectable rows; the selected run's
 * detail (steps, recovery actions) renders in the big main pane via RunDetailPane —
 * never inline in the rail. The rail owns the flow's batch socket subscription
 * (sole subscriber — BatchMonitor and RunDetailPane rely on its invalidations).
 */

import { Button } from '@benord-labs/frink-primitives';
import { TRPCClientError } from '@trpc/client';
import { useAtomValue } from 'jotai';
import { ChevronLeft, Eye, Loader2, RotateCcw, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { DbFlowRun, DbFlowRunWithNodeRuns } from '../../../../../shared/types/flow-run';
import { trpc } from '../../../../lib/trpc';
import { cn } from '../../../../lib/utils';
import { isDesktopApp } from '../../../../lib/utils/platform';
import { flowLoopProgressAtomFamily } from '../../atoms';
import {
  FlowRunStatusIcon,
  shouldPollFlowAdmission,
  shouldShowPausedActions,
} from '../FlowRunStatusIcon';
import { BatchGroup } from './BatchGroup';
import {
  createNodeBurstRefreshScheduler,
  handleFlowExecutionSocketEvent,
  NODE_BURST_DEBOUNCE_MS,
} from './flow-run-history-socket-refresh';
import { formatDuration } from './format-duration';
import { NodeRunList } from './node-run-list';
import { PausedRunActions } from './PausedRunActions';
import { RunRow, runPresentation } from './RunRow';
import { RunStatusLabel } from './RunStatusLabel';
import { findRestartInterruptedNodeRun } from './restart-interruption';
import { buildRunHistoryBatchView } from './run-history-batch-view';
import { shouldPaintExpandedRunOnCanvas } from './should-paint-expanded-run-on-canvas';

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
 * recovery actions (approve/retry/skip, restart-interruption re-run, view on canvas).
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
    onSuccess: (_data, variables) => {
      void utils.flows.listRuns.invalidate({ flowId });
      void utils.flows.listBatches.invalidate({ flowId });
      void utils.flows.listBatchRuns.invalidate({ flowId });
      void utils.flows.listBatchStages.invalidate({ flowId });
      void utils.flows.getRun.invalidate({ runId: variables.runId });
    },
    onError: (err) => {
      toast.error(err.message || 'Could not resume run');
    },
  });

  const rerunRunMutation = trpc.flows.rerunRun.useMutation({
    onSuccess: (_data, variables) => {
      toast.success('Re-running from the interrupted step');
      void utils.flows.listRuns.invalidate({ flowId });
      void utils.flows.list.invalidate();
      void utils.flows.get.invalidate({ id: flowId });
      void utils.flows.getRun.invalidate({ runId: variables.runId });
    },
    onError: (err) => {
      toast.error(err.message || 'Could not re-run flow');
    },
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
      {/* Run meta header */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border/30 px-4 py-2.5">
        {onBack && (
          <>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-7 gap-1 pl-1.5 pr-2.5 text-xs shrink-0"
              onClick={onBack}
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
              {backLabel ?? 'Go back'}
            </Button>
            <div className="w-px h-4 bg-border/60 shrink-0" aria-hidden />
          </>
        )}
        <div
          className="flex min-w-0 items-center gap-3"
          role={presentation.liveMode ? 'status' : undefined}
          aria-live={presentation.liveMode}
          aria-atomic={presentation.liveAtomic}
        >
          <FlowRunStatusIcon status={presentation.displayStatus} size="md" labelled={false} />
          <RunStatusLabel status={presentation.displayStatus} suffix={presentation.queueSuffix} />
          {presentation.detailTimeLabel && (
            <span className={cn('text-[11px]', presentation.detailTimeClassName)}>
              {presentation.detailTimeLabel}
            </span>
          )}
          {presentation.durationMs != null && (
            <span className="text-[11px] text-muted-foreground/60">
              · {formatDuration(presentation.durationMs)}
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {onViewOnCanvas && shouldPaintExpandedRunOnCanvas(runId, visibleDetail) && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-6 gap-1 text-[11px]"
              onClick={() => onViewOnCanvas(visibleDetail)}
            >
              <Eye className="h-3 w-3" aria-hidden />
              View on canvas
            </Button>
          )}
        </div>
      </div>

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
            onResumeRun={(action, nodeRunId) =>
              resumeRunMutation.mutate({ runId: visibleDetail.id, action, nodeRunId })
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
          <RerunInterruptedAction
            detail={visibleDetail}
            onRerunRun={(rid) => rerunRunMutation.mutate({ runId: rid })}
            rerunPending={rerunRunMutation.isPending}
          />
        )}
      </div>
    </div>
  );
}

type RerunInterruptedActionProps = {
  detail: DbFlowRunWithNodeRuns;
  onRerunRun: (runId: string) => void;
  rerunPending: boolean;
};

/**
 * "Re-run from previous node" for a run cancelled by an app restart. Renders only when the run
 * carries the restart marker (findRestartInterruptedNodeRun) — never for a user-initiated cancel.
 * A two-step inline confirm warns that side-effecting steps re-run from scratch (the work up to
 * here is preserved on the same run; the interrupted node and everything after it re-execute).
 */
function RerunInterruptedAction({ detail, onRerunRun, rerunPending }: RerunInterruptedActionProps) {
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  // Move focus to the confirm button on swap (the trigger unmounts → focus would drop to body,
  // WCAG 2.4.3), and back to the trigger on cancel.
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
    else if (wasConfirming.current) triggerRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);
  const interrupted = findRestartInterruptedNodeRun(detail.nodeRuns);
  if (!interrupted) return null;

  const nodeLabel =
    detail.graph?.nodes.find((n) => n.id === interrupted.node_id)?.label ?? interrupted.block_type;

  return (
    <div className="mt-2 space-y-1.5 border-t border-border/35 pt-2">
      {confirming ? (
        <div className="space-y-1.5" role="alert">
          <p className="text-[11px] text-muted-foreground">
            Re-runs <span className="font-medium text-foreground">{nodeLabel}</span> and the steps
            after it. Side-effecting steps (commands, requests) run again from scratch; an agent
            continues in its existing worktree.
          </p>
          <div className="flex items-center gap-1.5">
            <Button
              ref={confirmRef}
              type="button"
              size="sm"
              variant="secondary"
              className="h-6 gap-1 text-[11px]"
              disabled={rerunPending}
              onClick={() => onRerunRun(detail.id)}
            >
              {rerunPending ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              ) : (
                <RotateCcw className="h-3 w-3" aria-hidden />
              )}
              Confirm re-run
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 text-[11px] text-muted-foreground"
              disabled={rerunPending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          ref={triggerRef}
          type="button"
          size="sm"
          variant="secondary"
          className="h-6 gap-1 text-[11px]"
          onClick={() => setConfirming(true)}
        >
          <RotateCcw className="h-3 w-3" aria-hidden />
          Re-run from previous node
        </Button>
      )}
    </div>
  );
}
