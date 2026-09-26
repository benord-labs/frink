/**
 * Stage detail panel for the Batch Monitor view.
 * Shows stage name, status, progress bar, and a paginated run list.
 * Clicking a run opens an inline run detail view with customization options (sc-645).
 */

import { Button } from '@benord-labs/frink-primitives';
import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactElement, useEffect, useState } from 'react';
import type { BatchStageDetail } from '../../../../../../shared/types/flows/flow-batch';
import type { BatchStageRunRow } from '../../../../../../shared/types/flow';
import { cn } from '../../../../../lib/utils';
import {
  formatProgress,
  getStatusPill,
} from '../../FlowRunHistoryPanel/BatchReportPanel/stage-status-styles';
import { RunDetailPanel } from './RunDetailPanel';
import { StageRunList } from './StageRunList';

type StageDetailPanelProps = {
  flowId: string;
  batchId: string;
  stage: BatchStageDetail;
  stages: BatchStageDetail[];
  onClose: () => void;
};

export function StageDetailPanel({
  flowId,
  batchId,
  stage,
  stages,
  onClose,
}: StageDetailPanelProps): ReactElement {
  const pill = getStatusPill(stage.status);
  const label = stage.name ?? `Stage ${stage.stage_number}`;
  const progressRatio = stage.run_count > 0 ? stage.completed_count / stage.run_count : 0;
  const progressLabel = formatProgress(stage.completed_count, stage.run_count);
  const isComplete = stage.run_count > 0 && stage.completed_count === stage.run_count;

  const [selectedRun, setSelectedRun] = useState<BatchStageRunRow | null>(null);
  const [selectedRunIndex, setSelectedRunIndex] = useState(0);

  useEffect(() => {
    setSelectedRun(null);
    setSelectedRunIndex(0);
  }, [stage.id, batchId]);

  const handleRunSelect = (run: BatchStageRunRow, index: number) => {
    setSelectedRun(run);
    setSelectedRunIndex(index);
  };

  const handleReassigned = (sourceStageId: string, _targetStageId: string) => {
    if (sourceStageId === stage.id) setSelectedRun(null);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-border/60 px-4 py-3 shrink-0">
        <div className="flex flex-col gap-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[10px] tabular-nums bg-muted rounded px-1.5 py-px text-muted-foreground/70 shrink-0">
              {stage.stage_number}
            </span>
            <h2 className="text-sm font-semibold text-foreground truncate" title={label}>
              {label}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-medium',
                pill.className,
              )}
            >
              {pill.dotClassName && (
                <span
                  className={cn('h-1.5 w-1.5 rounded-full shrink-0', pill.dotClassName)}
                  aria-hidden
                />
              )}
              {pill.label}
            </span>
            <span
              className={cn(
                'text-[11px] tabular-nums',
                isComplete ? 'text-[hsl(var(--status-online-text))]' : 'text-muted-foreground/60',
              )}
            >
              {progressLabel} runs
            </span>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="Close stage detail"
          onClick={onClose}
          iconOnly
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>

      {/* Progress bar */}
      <div className="px-4 py-2 border-b border-border/30 shrink-0">
        <div className="h-1.5 rounded-full bg-muted/60 overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-300',
              isComplete
                ? 'bg-emerald-500'
                : stage.status === 'failed'
                  ? 'bg-destructive/60'
                  : 'bg-primary/60',
            )}
            style={{ width: `${progressRatio * 100}%` }}
          />
        </div>
      </div>

      {/* Run list / run detail — animated swap */}
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden relative">
        <AnimatePresence initial={false} mode="wait">
          {selectedRun ? (
            <motion.div
              key={`run-detail-${selectedRun.id}`}
              className="absolute inset-0"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
            >
              <RunDetailPanel
                flowId={flowId}
                run={selectedRun}
                runIndex={selectedRunIndex}
                stages={stages}
                currentStageId={stage.id}
                onBack={() => setSelectedRun(null)}
                onReassigned={handleReassigned}
              />
            </motion.div>
          ) : (
            <motion.div
              key="run-list"
              className="absolute inset-0 flex flex-col"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
            >
              <div className="px-4 py-2 shrink-0">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  Runs
                </span>
              </div>
              <StageRunList
                flowId={flowId}
                batchId={batchId}
                stageId={stage.id}
                onRunSelect={handleRunSelect}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
