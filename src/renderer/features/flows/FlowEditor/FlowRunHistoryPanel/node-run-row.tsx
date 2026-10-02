import { Button } from '@benord-labs/frink-primitives';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { memo } from 'react';
import { SUPERSEDED_NODE_STATUS } from '../../../../../shared/types/flow';
import type { DbNodeRun } from '../../../../../shared/types/flow-run';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../components/ui/tooltip';
import { cn } from '../../../../lib/utils';
import { formatDuration } from './format-duration';
import { NodeRunDetail } from './NodeRunDetail';
import { NodeRunStatusIcon } from './node-run-status-icon';
import { getNodeRunTooltipText } from './node-run-tooltip';
import { usePeriodicNow } from './use-periodic-now';
import { wallDurationMs } from './wall-duration-ms';

type NodeRunRowProps = {
  nr: DbNodeRun;
  title: string;
  /** Secondary label when it differs from title; omit when redundant (see `flowNodeRunDisplay`). */
  kind?: string;
  /** Resolved entrypoint path for custom nodes (absolute). */
  customEntrypointPath?: string | null;
  nodeLabelById: ReadonlyMap<string, string>;
  laneTotal: number | undefined;
  isExpanded: boolean;
  onToggleNode: (nodeRunId: string) => void;
};

function NodeRunRowInner({
  nr,
  title,
  kind,
  customEntrypointPath,
  nodeLabelById,
  laneTotal,
  isExpanded,
  onToggleNode,
}: NodeRunRowProps) {
  const dur = wallDurationMs(nr.started_at, nr.completed_at);
  const isRunning = nr.status === 'running';
  const now = usePeriodicNow(isRunning);
  const tooltipText = getNodeRunTooltipText(nr, isRunning ? now : undefined);
  const skippedLine =
    nr.status === 'skipped' || nr.status === 'cancelled' || nr.status === SUPERSEDED_NODE_STATUS
      ? 'text-muted-foreground/40 line-through'
      : 'text-foreground';
  const laneNumber = nr.lane_index != null ? nr.lane_index + 1 : undefined;
  const detailRegionId = `flow-node-run-detail-${nr.id}`;

  return (
    <li className="rounded-sm">
      <Tooltip delayDuration={200}>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="auto"
            className="w-full justify-start text-left font-normal flex min-w-0 gap-2 rounded-sm px-0.5 py-0.5 text-xs"
            aria-expanded={isExpanded}
            aria-controls={isExpanded ? detailRegionId : undefined}
            onClick={() => onToggleNode(nr.id)}
          >
            <NodeRunStatusIcon status={nr.status} />
            <span className={cn('flex-1 min-w-0 truncate', skippedLine)}>
              {title}
              {kind != null ? (
                <span className="text-muted-foreground/55">{` · ${kind}`}</span>
              ) : null}
            </span>
            {dur != null && dur >= 0 && (
              <span className="text-[10px] text-muted-foreground/40 shrink-0 tabular-nums">
                {formatDuration(dur)}
              </span>
            )}
            {isExpanded ? (
              <ChevronDown className="h-2.5 w-2.5 shrink-0 text-muted-foreground/50" aria-hidden />
            ) : (
              <ChevronRight className="h-2.5 w-2.5 shrink-0 text-muted-foreground/50" aria-hidden />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-[280px]">
          <p className="whitespace-pre-wrap wrap-break-word">{tooltipText}</p>
        </TooltipContent>
      </Tooltip>
      {isExpanded ? (
        <div id={detailRegionId} role="region" aria-label={`${title} step details`}>
          <NodeRunDetail
            nodeRun={nr}
            laneNumber={laneNumber}
            laneTotal={laneTotal}
            customEntrypointPath={customEntrypointPath}
            nodeLabelById={nodeLabelById}
          />
        </div>
      ) : null}
    </li>
  );
}

export const NodeRunRow = memo<NodeRunRowProps>(NodeRunRowInner);
