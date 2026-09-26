/**
 * Custom React Flow node for a batch stage in the full-width Monitor canvas.
 * Larger card (200×72px) with progress bar, workstream accent, and status pill.
 * Read-only — no edge editing handles.
 */

import type { Node, NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import { memo, type ReactElement, useEffect, useRef } from 'react';
import type { BatchStageDetail } from '../../../../../../shared/types/flows/flow-batch';
import { cn } from '../../../../../lib/utils';
import { getWorkstreamColor } from '../../FlowRunHistoryPanel/BatchReportPanel/BatchPlanCanvas/workstream-colors';
import {
  formatProgress,
  getStatusPill,
} from '../../FlowRunHistoryPanel/BatchReportPanel/stage-status-styles';
import { MONITOR_NODE_HEIGHT, MONITOR_NODE_WIDTH } from './constants';

export type BatchMonitorStageNodeData = {
  stage: BatchStageDetail;
  isSelected: boolean;
  onSelect: (stageId: string | null) => void;
};

type BatchMonitorStageRfNode = Node<BatchMonitorStageNodeData, 'batchMonitorStage'>;

/** Members waiting on a person, or null. Reads "blocked" once every started member waits (pending ones
 * have not started, hence the subtraction): nothing else can finish until someone answers. */
export function attentionPillLabel(stage: BatchStageDetail): string | null {
  const waiting = stage.attention_count;
  if (waiting === 0) return null;
  const started = stage.active_count - stage.pending_count;
  const count = `${waiting} ${waiting === 1 ? 'needs' : 'need'} input`;
  return waiting === started ? `blocked · ${count}` : count;
}

function BatchMonitorStageNodeInner({ data }: NodeProps<BatchMonitorStageRfNode>): ReactElement {
  const { stage, isSelected, onSelect } = data;
  const pill = getStatusPill(stage.status);
  const attentionLabel = attentionPillLabel(stage);
  const label = stage.name ?? `Stage ${stage.stage_number}`;
  const primaryWorkstream = stage.workstream_ids.map((w) => w.trim()).find((w) => w.length > 0);
  const progressRatio = stage.run_count > 0 ? stage.completed_count / stage.run_count : 0;
  const progressLabel = formatProgress(stage.completed_count, stage.run_count);
  const isComplete = stage.run_count > 0 && stage.completed_count === stage.run_count;

  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(clickTimerRef.current), []);

  const handleClick = () => {
    clearTimeout(clickTimerRef.current);
    clickTimerRef.current = setTimeout(() => onSelect(isSelected ? null : stage.id), 200);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          clearTimeout(clickTimerRef.current);
          onSelect(isSelected ? null : stage.id);
        }
      }}
      aria-pressed={isSelected}
      title={primaryWorkstream ? `Workstream: ${primaryWorkstream}` : label}
      style={{
        width: MONITOR_NODE_WIDTH,
        height: MONITOR_NODE_HEIGHT,
        pointerEvents: 'all',
        ...(primaryWorkstream ? { borderLeftColor: getWorkstreamColor(primaryWorkstream) } : {}),
      }}
      className={cn(
        'group relative flex flex-col justify-between rounded border bg-card px-2.5 py-2 cursor-pointer transition-colors text-left',
        primaryWorkstream && 'border-l-[3px]',
        isSelected
          ? 'border-primary/50 ring-1 ring-primary/30 bg-primary/4'
          : 'border-border/50 hover:border-border hover:bg-muted/30',
      )}
    >
      {/* Top row: stage number + needs-input pill + status pill */}
      <div className="flex items-center justify-between gap-1 min-w-0">
        <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[9px] tabular-nums font-medium text-muted-foreground/70 leading-tight">
          {stage.stage_number}
        </span>
        <div className="flex items-center gap-1 min-w-0">
          {attentionLabel && (
            <span className="truncate rounded bg-[hsl(var(--status-warning)/0.15)] px-1.5 py-px text-[9px] font-medium text-warning leading-tight">
              {attentionLabel}
            </span>
          )}
          <span
            className={cn(
              'inline-flex items-center gap-0.5 rounded px-1.5 py-px text-[9px] font-medium leading-tight whitespace-nowrap shrink-0',
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
        </div>
      </div>

      {/* Stage name */}
      <div
        className="truncate text-[11px] text-foreground/80 leading-tight font-medium"
        title={label}
      >
        {label}
      </div>

      {/* Progress bar + label */}
      <div className="flex items-center gap-1.5">
        <div className="flex-1 h-1 rounded-full bg-muted/60 overflow-hidden">
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
        <span
          className={cn(
            'text-[9px] tabular-nums leading-tight shrink-0',
            isComplete ? 'text-[hsl(var(--status-online-text))]' : 'text-muted-foreground/60',
          )}
        >
          {progressLabel}
        </span>
      </div>

      {/* Hidden handles — required by React Flow but not interactive. */}
      <Handle
        type="target"
        position={Position.Top}
        className="opacity-0! pointer-events-none! w-2! h-2! min-w-0! min-h-0!"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="opacity-0! pointer-events-none! w-2! h-2! min-w-0! min-h-0!"
      />
    </div>
  );
}

export const BatchMonitorStageNode = memo(BatchMonitorStageNodeInner);
