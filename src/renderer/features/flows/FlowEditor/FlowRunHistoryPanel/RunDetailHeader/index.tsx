import { Button } from '@benord-labs/frink-primitives';
import { ChevronLeft, Eye } from 'lucide-react';
import type { DbFlowRunWithNodeRuns } from '../../../../../../shared/types/flow-run';
import { cn } from '../../../../../lib/utils';
import { FlowRunStatusIcon } from '../../FlowRunStatusIcon';
import { formatDuration } from '../format-duration';
import type { runPresentation } from '../RunRow';
import { RunStatusLabel } from '../RunStatusLabel';
import { shouldPaintExpandedRunOnCanvas } from '../should-paint-expanded-run-on-canvas';

type RunDetailHeaderProps = {
  /** The selected run id; a stale `run` row for another id never paints on the canvas. */
  runId: string;
  run: DbFlowRunWithNodeRuns;
  presentation: ReturnType<typeof runPresentation>;
  onViewOnCanvas?: (run: DbFlowRunWithNodeRuns) => void;
  onBack?: () => void;
  backLabel?: string;
};

/** The run detail pane's meta header: back button, live status, timing, View on canvas. */
export function RunDetailHeader({
  runId,
  run,
  presentation,
  onViewOnCanvas,
  onBack,
  backLabel,
}: RunDetailHeaderProps) {
  return (
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
        {onViewOnCanvas && shouldPaintExpandedRunOnCanvas(runId, run) && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-6 gap-1 text-[11px]"
            onClick={() => onViewOnCanvas(run)}
          >
            <Eye className="h-3 w-3" aria-hidden />
            View on canvas
          </Button>
        )}
      </div>
    </div>
  );
}
