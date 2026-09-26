/**
 * Batch monitor — the main pane of the Runs tab for one selected batch: summary toolbar +
 * stage DAG canvas + stage detail panel, plus the batch-plan tools that act on the plan
 * itself (save/load stage templates, edit stage dependencies). Run actions live in the
 * FlowEditor header (the single run-action surface, targeting the selected batch).
 * Socket refresh is owned by the always-mounted FlowRunHistoryPanel rail (sole
 * subscriber); this component only reads the shared queries it invalidates.
 */

import { Button } from '@benord-labs/frink-primitives';
import { GitFork } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactElement, useState } from 'react';
import type { BatchStageDetail, BatchSummary } from '../../../../../shared/types/flows/flow-batch';
import { trpc } from '../../../../lib/trpc';
import { cn } from '../../../../lib/utils';
import {
  BatchPlanCanvas,
  LoadTemplatePicker,
  SaveTemplatePopover,
} from '../FlowRunHistoryPanel/BatchReportPanel';
import { BatchDagCanvas } from './BatchDagCanvas';
import { BatchSummaryBar } from './BatchSummaryBar';
import { StageDetailPanel } from './StageDetailPanel';

type BatchMonitorProps = {
  flowId: string;
  batchId: string;
  /** True when this batch is the flow's persisted run target. */
  isActiveBatch: boolean;
  /** Controls CSS visibility — both canvases stay mounted. */
  isVisible: boolean;
  selectedStageId: string | null;
  onSelectStage: (stageId: string | null) => void;
};

/** 1-based position of this batch in chronological order (1 = oldest). */
function computeBatchOrdinal(batchSummaries: BatchSummary[] | undefined, batchId: string): number {
  if (!batchSummaries) return 1;
  const sorted = [...batchSummaries].sort((a, b) => {
    if (!a.first_run_at) return 1;
    if (!b.first_run_at) return -1;
    return new Date(a.first_run_at).getTime() - new Date(b.first_run_at).getTime();
  });
  return sorted.findIndex((b) => b.batch_id === batchId) + 1;
}

type BatchToolbarProps = {
  flowId: string;
  batchSummary: BatchSummary | undefined;
  ordinal: number;
  isActiveBatch: boolean;
  stages: BatchStageDetail[];
  isStagesError: boolean;
  hasEditableStages: boolean;
  planEdit: boolean;
  onTogglePlanEdit: () => void;
};

/** Summary line + Active chip + batch-plan tools (templates, Edit plan). Always rendered
 * so a planned/never-run batch (no summary row yet) still exposes its plan tools. */
function BatchToolbar({
  flowId,
  batchSummary,
  ordinal,
  isActiveBatch,
  stages,
  isStagesError,
  hasEditableStages,
  planEdit,
  onTogglePlanEdit,
}: BatchToolbarProps): ReactElement {
  return (
    <div className="flex items-center gap-2 shrink-0 border-b border-border/30 pr-3">
      <div className="flex-1 min-w-0">
        {batchSummary ? (
          <BatchSummaryBar batchSummary={batchSummary} ordinal={ordinal} />
        ) : (
          <div className="flex items-center gap-3 px-4 py-2.5">
            <span className="text-xs font-semibold text-foreground/80">Batch</span>
            <span className="text-[11px] text-muted-foreground/60">not started yet</span>
          </div>
        )}
      </div>
      {isActiveBatch && (
        <span className="rounded bg-primary/15 px-1.5 py-px text-[10px] font-medium text-primary shrink-0">
          Active
        </span>
      )}
      {stages.length === 0 && !isStagesError && <LoadTemplatePicker flowId={flowId} />}
      {stages.length > 1 && <SaveTemplatePopover flowId={flowId} stages={stages} />}
      {hasEditableStages && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            'h-7 gap-1 text-xs shrink-0',
            planEdit ? 'text-foreground bg-muted' : 'text-muted-foreground hover:text-foreground',
          )}
          title="Edit dependencies between pending stages"
          aria-pressed={planEdit}
          onClick={onTogglePlanEdit}
        >
          <GitFork className="h-3 w-3" aria-hidden />
          Edit plan
        </Button>
      )}
    </div>
  );
}

export function BatchMonitor({
  flowId,
  batchId,
  isActiveBatch,
  isVisible,
  selectedStageId,
  onSelectStage,
}: BatchMonitorProps): ReactElement {
  const utils = trpc.useUtils();
  const [planEdit, setPlanEdit] = useState(false);

  const {
    data: stagesData,
    isError: isStagesError,
    isFetching: isStagesFetching,
    refetch: refetchStages,
  } = trpc.flows.listBatchStages.useQuery({ flowId, batchId }, { staleTime: 30_000 });

  const { data: batchSummaries } = trpc.flows.listBatches.useQuery(
    { flowId, limit: 50 },
    { staleTime: 30_000 },
  );

  const stages: BatchStageDetail[] = stagesData?.stages ?? [];
  const isStagesLoading = !isStagesError && stagesData === undefined && isStagesFetching;
  const batchSummary = batchSummaries?.find((s) => s.batch_id === batchId);
  const selectedStage = stages.find((s) => s.id === selectedStageId) ?? null;

  // Stage dependencies are only editable while the target stage is pending — on a
  // batch with nothing pending the plan editor is a no-op, so don't offer it.
  const hasEditableStages = stages.length > 1 && stages.some((s) => s.status === 'pending');
  const showPlanEditor = planEdit && hasEditableStages;

  return (
    <div className={cn('flex flex-col flex-1 min-h-0', !isVisible && 'hidden')}>
      <BatchToolbar
        flowId={flowId}
        batchSummary={batchSummary}
        ordinal={computeBatchOrdinal(batchSummaries, batchId)}
        isActiveBatch={isActiveBatch}
        stages={stages}
        isStagesError={isStagesError}
        hasEditableStages={hasEditableStages}
        planEdit={planEdit}
        onTogglePlanEdit={() => setPlanEdit((v) => !v)}
      />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {showPlanEditor ? (
          <BatchPlanCanvas
            stages={stages}
            selectedStageId={selectedStageId}
            onSelectStage={onSelectStage}
            flowId={flowId}
            batchId={batchId}
            onSaveSuccess={() => void utils.flows.listBatchStages.invalidate({ flowId })}
            className="h-full flex-1"
          />
        ) : (
          <BatchDagCanvas
            stages={stages}
            selectedStageId={selectedStageId}
            onSelectStage={onSelectStage}
            isStagesError={isStagesError}
            isStagesLoading={isStagesLoading}
            onStagesRetry={() => void refetchStages()}
            isVisible={isVisible}
          />
        )}

        <AnimatePresence>
          {selectedStage && !showPlanEditor && (
            <motion.div
              key="stage-detail-panel"
              className="flex shrink-0 flex-col overflow-hidden border-l border-border/60"
              initial={{ width: 0 }}
              animate={{ width: 380 }}
              exit={{ width: 0 }}
              transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
            >
              <div className="flex h-full w-[380px] min-w-[380px] flex-col">
                <StageDetailPanel
                  flowId={flowId}
                  batchId={batchId}
                  stage={selectedStage}
                  stages={stages}
                  onClose={() => onSelectStage(null)}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
