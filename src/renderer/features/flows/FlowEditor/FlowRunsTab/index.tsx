/**
 * The FlowEditor "Runs" tab — the single monitoring surface for a flow (n8n-style
 * master/detail). Left rail: compact selectable run/batch rows. Main pane: the selected
 * batch's stage DAG (BatchMonitor) or the selected run's detail (RunDetailPane) — the
 * newest run is auto-selected so the pane is never empty. Batch vocabulary only appears
 * once a batch actually exists. Stays mounted while hidden (CSS) so React Flow
 * viewports survive tab switches.
 */

import { Activity } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { trpc } from '../../../../lib/trpc';
import { cn } from '../../../../lib/utils';
import { BatchMonitor } from '../BatchMonitor';
import {
  FlowRunHistoryPanel,
  RunDetailPane,
  type ViewRunOnCanvasHandler,
} from '../FlowRunHistoryPanel';

type FlowRunsTabProps = {
  flowId: string;
  isVisible: boolean;
  /** The batch shown in the main pane (user selection, defaulted to the active batch). */
  selectedBatchId: string | null;
  /** The flow's persisted run target (graph.settings.currentBatchId). */
  activeBatchId: string | null;
  onSelectBatch: (batchId: string) => void;
  selectedStageId: string | null;
  onSelectStage: (stageId: string | null) => void;
  canvasOverlayRunId?: string;
  onViewRunOnCanvas: ViewRunOnCanvasHandler;
  /** Flip back to the Editor tab (used by "View on canvas"). */
  onRequestEditorTab: () => void;
  /** Glass shell class for the rail (passed in — the sidebar feature has no barrel). */
  railShellClassName: string;
};

type RunListRow = { id: string };

/**
 * The run driving the detail pane. An explicit selection wins while it still exists in the
 * loaded list (a vanished run falls back instead of pinning the pane to a dead id); with no
 * selection and no batch, the newest run is auto-selected so the pane is never empty.
 */
function resolveEffectiveRunId(
  selectedRunId: string | null,
  runs: RunListRow[] | undefined,
  selectedBatchId: string | null,
): string | null {
  const selectionStillListed =
    selectedRunId !== null && (!runs || runs.some((r) => r.id === selectedRunId));
  if (selectionStillListed) return selectedRunId;
  return selectedBatchId === null ? (runs?.[0]?.id ?? null) : null;
}

export function FlowRunsTab({
  flowId,
  isVisible,
  selectedBatchId,
  activeBatchId,
  onSelectBatch,
  selectedStageId,
  onSelectStage,
  canvasOverlayRunId,
  onViewRunOnCanvas,
  onRequestEditorTab,
  railShellClassName,
}: FlowRunsTabProps): ReactElement {
  // Explicit run selection; null = follow the default (batch monitor if a batch exists,
  // else the newest run — the pane is never empty when there is anything to show).
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // Same query key as the rail — deduped by react-query, feeds default selection + empty state.
  const { data: runs } = trpc.flows.listRuns.useQuery({ flowId, limit: 20 }, { staleTime: 30_000 });
  const effectiveRunId = resolveEffectiveRunId(selectedRunId, runs, selectedBatchId);
  const effectiveRun = runs?.find((run) => run.id === effectiveRunId);

  const handleSelectBatch = (batchId: string) => {
    setSelectedRunId(null);
    onSelectBatch(batchId);
  };

  return (
    <div className={cn('flex min-h-0 flex-1', !isVisible && 'hidden')}>
      <div className="flex shrink-0 flex-col overflow-hidden bg-transparent pr-1">
        <div
          className={cn(railShellClassName, 'h-full min-h-0 w-[300px] min-w-[300px] rounded-xl')}
        >
          <FlowRunHistoryPanel
            flowId={flowId}
            activeBatchId={activeBatchId ?? undefined}
            selectedBatchId={effectiveRunId === null ? selectedBatchId : null}
            onSelectBatch={handleSelectBatch}
            selectedRunId={effectiveRunId}
            onSelectRun={setSelectedRunId}
            canvasOverlayRunId={canvasOverlayRunId}
          />
        </div>
      </div>

      {effectiveRunId !== null ? (
        <RunDetailPane
          flowId={flowId}
          runId={effectiveRunId}
          runSummary={effectiveRun}
          onViewOnCanvas={(run) => {
            onViewRunOnCanvas(run);
            onRequestEditorTab();
          }}
          onBack={selectedBatchId !== null ? () => setSelectedRunId(null) : undefined}
          backLabel="Back to batch"
        />
      ) : selectedBatchId !== null ? (
        <BatchMonitor
          flowId={flowId}
          batchId={selectedBatchId}
          isActiveBatch={selectedBatchId === activeBatchId}
          isVisible={isVisible}
          selectedStageId={selectedStageId}
          onSelectStage={onSelectStage}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <Activity className="h-8 w-8 text-muted-foreground/30" aria-hidden />
          <p className="text-sm text-muted-foreground">No runs yet.</p>
          <p className="text-xs text-muted-foreground/60">
            Press Run to execute this flow — every run shows up here.
          </p>
        </div>
      )}
    </div>
  );
}
