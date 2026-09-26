import { Button } from '@benord-labs/frink-primitives';
import { Loader2, Square } from 'lucide-react';
import type { DbFlowRun } from '../../../../../../shared/types/flow-run';
import { cn } from '../../../../../lib/utils';
import { formatRelativeTime } from '../../../../../lib/utils/format-time';
import type { FlowLoopProgress } from '../../../atoms';
import { LoopIterationBadge } from '../../../LoopIterationBadge';
import {
  FlowRunStatusIcon,
  flowRunDisplayStatus,
  isLiveFlowAdmissionState,
} from '../../FlowRunStatusIcon';
import { formatDuration } from '../format-duration';
import { RunStatusLabel } from '../RunStatusLabel';

type RunRowProps = {
  run: DbFlowRun;
  loopProgress?: FlowLoopProgress | null;
  isSelected: boolean;
  isCanvasOverlayRow: boolean;
  onSelect: () => void;
  onStopRun: (runId: string) => void;
  stopPending: boolean;
};

const STOPPABLE_RUN_STATUSES = new Set(['running', 'paused']);

function runTimeLabels(run: DbFlowRun, queued: boolean) {
  const relativeTime = (timestamp: string | null | undefined) =>
    timestamp ? formatRelativeTime(timestamp) : null;
  if (queued) {
    const label = relativeTime(run.admission_requested_at);
    const queuedLabel = label ? `Queued ${label}` : null;
    return { timeLabel: queuedLabel, detailTimeLabel: queuedLabel };
  }
  const timeLabel = relativeTime(run.started_at);
  return { timeLabel, detailTimeLabel: timeLabel ? `Started ${timeLabel}` : null };
}

function runDurationMs(run: DbFlowRun, queued: boolean): number | null {
  if (queued || !run.started_at || !run.completed_at) return null;
  return new Date(run.completed_at).getTime() - new Date(run.started_at).getTime();
}

export function runPresentation(run: DbFlowRun) {
  const displayStatus = flowRunDisplayStatus(
    run.status,
    run.active_task_status,
    run.admission_state,
  );
  const queued = displayStatus === 'queued';
  const recoveryBlocked =
    isLiveFlowAdmissionState(run.admission_state) && run.admission_state !== 'claimed';
  return {
    displayStatus,
    recoveryStatus: recoveryBlocked ? null : displayStatus,
    durationMs: runDurationMs(run, queued),
    ...runTimeLabels(run, queued),
    timeClassName: queued ? 'text-foreground' : 'text-muted-foreground/50',
    detailTimeClassName: queued ? 'text-foreground' : 'text-muted-foreground/60',
    liveMode: queued ? ('polite' as const) : undefined,
    liveAtomic: queued || undefined,
    queueSuffix: queued && run.queue_position != null ? ` · #${run.queue_position}` : '',
    canStop: queued || STOPPABLE_RUN_STATUSES.has(run.status),
    stopAriaLabel: queued ? 'Cancel queued run' : 'Stop this run',
    stopLabel: queued ? 'Cancel' : 'Stop',
  };
}

export function RunRow({
  run,
  loopProgress,
  isSelected,
  isCanvasOverlayRow,
  onSelect,
  onStopRun,
  stopPending,
}: RunRowProps) {
  const presentation = runPresentation(run);

  return (
    <li>
      <div className="flex items-center">
        <Button
          variant="ghost"
          className={cn(
            'flex h-auto min-w-0 flex-1 justify-start gap-2.5 rounded-none px-3 py-2 text-left font-normal',
            isSelected && 'bg-primary/10 ring-1 ring-inset ring-primary/20 hover:bg-primary/10',
            !isSelected && isCanvasOverlayRow && 'bg-muted/40',
          )}
          onClick={onSelect}
          aria-current={isSelected ? 'true' : undefined}
        >
          <FlowRunStatusIcon status={presentation.displayStatus} size="md" labelled={false} />
          <div
            className="flex-1 min-w-0"
            role={presentation.liveMode ? 'status' : undefined}
            aria-live={presentation.liveMode}
            aria-atomic={presentation.liveAtomic}
          >
            <div className="flex items-center gap-2 min-w-0">
              <RunStatusLabel
                status={presentation.displayStatus}
                suffix={presentation.queueSuffix}
              />
              {loopProgress && (
                <LoopIterationBadge
                  loopIteration={loopProgress.loopIteration}
                  loopTotalCount={loopProgress.loopTotalCount}
                  variant="panel"
                />
              )}
              {presentation.durationMs != null && (
                <span className="text-[11px] text-muted-foreground/50">
                  {formatDuration(presentation.durationMs)}
                </span>
              )}
            </div>
            {presentation.timeLabel && (
              <span className={cn('text-[11px]', presentation.timeClassName)}>
                {presentation.timeLabel}
              </span>
            )}
          </div>
        </Button>
        {presentation.canStop && (
          <div className="pr-3 shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 text-[11px] text-muted-foreground hover:text-destructive"
              disabled={stopPending}
              aria-label={presentation.stopAriaLabel}
              onClick={(event) => {
                event.stopPropagation();
                onStopRun(run.id);
              }}
            >
              {stopPending ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              ) : (
                <Square className="h-2.5 w-2.5 fill-current" aria-hidden />
              )}
              {presentation.stopLabel}
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}
