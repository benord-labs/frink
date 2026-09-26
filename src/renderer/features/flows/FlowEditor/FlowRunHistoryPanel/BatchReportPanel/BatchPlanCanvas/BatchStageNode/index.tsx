/**
 * Custom React Flow node for a single batch stage in the DAG canvas.
 *
 * Compact card (140×52px) showing: stage number badge, name, status pill, run progress.
 *
 * Interactions:
 * - Single-click (debounced 200ms): select/deselect stage → filters run list below.
 * - Double-click or ExternalLink icon click: navigate to stage's latest agent chat.
 *   Navigation is delegated to `onOpenChat` (provided by parent canvas, which owns the
 *   dirty-state guard). No Jotai atoms in this component to avoid mass re-renders.
 */

import { Button } from '@benord-labs/frink-primitives';
import type { Node, NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import { ExternalLink } from 'lucide-react';
import { memo, type ReactElement, useEffect, useRef } from 'react';
import { cn } from '../../../../../../../lib/utils';
import { formatProgress, getStatusPill } from '../../stage-status-styles';
import type { BatchStageNodeData } from '../build-batch-plan-graph';
import { BATCH_NODE_HEIGHT, BATCH_NODE_WIDTH } from '../constants';
import { getWorkstreamColor } from '../workstream-colors';

type BatchStageRfNode = Node<BatchStageNodeData, 'batchStage'>;

function BatchStageNodeInner({ data }: NodeProps<BatchStageRfNode>): ReactElement {
  const { stage, isSelected, onSelect, onOpenChat } = data;
  const pill = getStatusPill(stage.status);
  const isComplete = stage.run_count > 0 && stage.completed_count === stage.run_count;
  const progress = formatProgress(stage.completed_count, stage.run_count);
  const label = stage.name ?? `Stage ${stage.stage_number}`;
  const primaryWorkstream = stage.workstream_ids.map((w) => w.trim()).find((w) => w.length > 0);

  const { sourceEditable = false, targetEditable = false } = data;

  // Click/double-click disambiguation: 200ms debounce so double-click doesn't
  // first fire two single-click selections before navigating.
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Cancel any pending debounce timer on unmount to avoid calling onSelect with a stale stage id.
  useEffect(() => () => clearTimeout(clickTimerRef.current), []);

  const handleClick = () => {
    clearTimeout(clickTimerRef.current);
    clickTimerRef.current = setTimeout(() => onSelect(isSelected ? null : stage.id), 200);
  };

  const handleDoubleClick = () => {
    // Only cancel the pending single-click timer when navigation will actually occur.
    // If there is no chat to open, the single-click timer should fire normally.
    if (stage.latest_chat_id && onOpenChat) {
      clearTimeout(clickTimerRef.current);
      onOpenChat(stage.latest_chat_id);
    }
  };

  const handleIconClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    clearTimeout(clickTimerRef.current);
    if (stage.latest_chat_id && onOpenChat) onOpenChat(stage.latest_chat_id);
  };

  const handleIconKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.stopPropagation();
      e.preventDefault();
      if (stage.latest_chat_id && onOpenChat) onOpenChat(stage.latest_chat_id);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          clearTimeout(clickTimerRef.current);
          onSelect(isSelected ? null : stage.id);
        }
      }}
      aria-pressed={isSelected}
      title={primaryWorkstream ? `Workstream: ${primaryWorkstream}` : undefined}
      style={{
        width: BATCH_NODE_WIDTH,
        height: BATCH_NODE_HEIGHT,
        // borderLeftColor is dynamic — only inline style can carry it.
        // border-l-[3px] Tailwind class sets width; borderLeftColor sets color.
        // Using borderLeftColor inline avoids the border shorthand overriding all sides.
        ...(primaryWorkstream ? { borderLeftColor: getWorkstreamColor(primaryWorkstream) } : {}),
      }}
      className={cn(
        'group relative flex flex-col justify-between rounded border bg-card px-2 py-1.5 cursor-pointer transition-colors text-left',
        primaryWorkstream && 'border-l-[3px]',
        isSelected
          ? 'border-primary/50 ring-1 ring-primary/30 bg-primary/4'
          : 'border-border/50 hover:border-border hover:bg-muted/30',
      )}
    >
      {/* Top row: stage number + status pill + (optional) chat icon */}
      <div className="flex items-center justify-between gap-1 min-w-0">
        <span className="shrink-0 rounded bg-muted px-1 py-px text-[9px] tabular-nums font-medium text-muted-foreground/70 leading-tight">
          {stage.stage_number}
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-0.5 rounded px-1 py-px text-[8px] font-medium leading-tight whitespace-nowrap flex-1 min-w-0',
            pill.className,
          )}
        >
          {pill.dotClassName && (
            <span className={cn('h-1 w-1 rounded-full shrink-0', pill.dotClassName)} aria-hidden />
          )}
          {pill.label}
        </span>
        {stage.latest_chat_id && onOpenChat && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            tabIndex={0}
            onClick={handleIconClick}
            onKeyDown={handleIconKeyDown}
            className="opacity-0 group-hover:opacity-100 shrink-0 rounded p-px transition-opacity focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-primary"
            aria-label="Open agent chat"
            title="Open agent chat"
          >
            <ExternalLink className="h-2.5 w-2.5" aria-hidden />
          </Button>
        )}
      </div>

      {/* Stage name */}
      <div className="truncate text-[10px] text-foreground/80 leading-tight" title={label}>
        {label}
      </div>

      {/* Progress */}
      <div
        className={cn(
          'text-[9px] tabular-nums leading-tight',
          isComplete ? 'text-[hsl(var(--status-online-text))]' : 'text-muted-foreground/50',
        )}
      >
        {progress}
      </div>

      {/* React Flow handles — interactive when editing mode is active for this stage.
          Target (top): only pending stages accept new deps.
          Source (bottom): any non-failed/cancelled stage can be a dependency source. */}
      <Handle
        type="target"
        position={Position.Top}
        className={cn(
          'w-2! h-2! min-w-0! min-h-0!',
          targetEditable
            ? 'opacity-0! hover:opacity-100! bg-primary! border-primary/50! transition-opacity'
            : 'opacity-0! pointer-events-none!',
        )}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className={cn(
          'w-2! h-2! min-w-0! min-h-0!',
          sourceEditable
            ? 'opacity-0! hover:opacity-100! bg-primary! border-primary/50! transition-opacity'
            : 'opacity-0! pointer-events-none!',
        )}
      />
    </div>
  );
}

export const BatchStageNode = memo(BatchStageNodeInner);
