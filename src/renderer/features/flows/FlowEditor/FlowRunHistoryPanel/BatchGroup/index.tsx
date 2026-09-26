/**
 * Collapsible batch group header for the FlowRunHistoryPanel rail.
 * Shows aggregate progress/status for one batch; children are the RunRow items.
 * Clicking the header selects the batch (drives the monitor pane) and expands its runs.
 */

import { Button } from '@benord-labs/frink-primitives';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { BatchSummary } from '../../../../../../shared/types/flows/flow-batch';
import { cn } from '../../../../../lib/utils';
import { formatRelativeTime } from '../../../../../lib/utils/format-time';

type BatchGroupProps = {
  summary: BatchSummary;
  /** 1-based ordinal derived from first_run_at ordering — "Batch 1" is oldest. */
  ordinal: number;
  /** Number of runs the parent has loaded for this batch (may be < summary.run_count). */
  visibleRunCount: number;
  /** This batch drives the monitor pane. */
  isSelected: boolean;
  /** This batch is the flow's persisted run target (graph.settings.currentBatchId). */
  isActiveBatch: boolean;
  onSelect: () => void;
  children: ReactNode;
};

export function BatchGroup({
  summary,
  ordinal,
  visibleRunCount,
  isSelected,
  isActiveBatch,
  onSelect,
  children,
}: BatchGroupProps) {
  const isActive = summary.active_count > 0;
  const [isExpanded, setIsExpanded] = useState(isActive);

  const progressText = buildProgressText(summary);
  const truncated = visibleRunCount < summary.run_count;

  return (
    <li className="border-b border-border/35 last:border-b-0">
      <Button
        variant="ghost"
        size="auto"
        className={cn(
          'w-full justify-start text-left font-normal flex gap-2.5 rounded-none px-3 py-2',
          isSelected && 'bg-primary/10 ring-1 ring-inset ring-primary/20 hover:bg-primary/10',
        )}
        onClick={() => {
          onSelect();
          // Selecting always reveals the runs; a second click on the selected batch toggles.
          setIsExpanded((prev) => (isSelected ? !prev : true));
        }}
        aria-expanded={isExpanded}
        aria-current={isSelected ? 'true' : undefined}
      >
        <BatchStatusIcon summary={summary} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-semibold text-foreground/80">Batch {ordinal}</span>
            {isActiveBatch && (
              <span className="rounded bg-primary/15 px-1 py-px text-[10px] font-medium text-primary">
                Active
              </span>
            )}
            <span className="text-[11px] text-muted-foreground/70">{progressText}</span>
          </div>
          {summary.first_run_at && (
            <span className="text-[11px] text-muted-foreground/50">
              Started {formatRelativeTime(summary.first_run_at)}
            </span>
          )}
        </div>
        {isExpanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" aria-hidden />
        )}
      </Button>
      {isExpanded && (
        <div>
          <ul className="ml-3 divide-y divide-border/35 border-l-2 border-border/30 pl-3">
            {children}
          </ul>
          {truncated && (
            <p className="px-3 py-1.5 text-[11px] italic text-muted-foreground/50">
              Showing {visibleRunCount} of {summary.run_count} runs
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function BatchStatusIcon({ summary }: { summary: BatchSummary }) {
  if (summary.active_count > 0) {
    return <Loader2 className="h-4 w-4 shrink-0 text-blue-500 animate-spin" aria-hidden />;
  }
  if (summary.errored_count > 0) {
    return <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />;
  }
  if (summary.completed_count === summary.run_count) {
    return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />;
  }
  return <CheckCircle2 className="h-4 w-4 shrink-0 text-muted-foreground/40" aria-hidden />;
}

function buildProgressText(summary: BatchSummary): string {
  const { run_count, completed_count, errored_count, active_count } = summary;
  if (active_count > 0) {
    return `${active_count} running · ${completed_count}/${run_count} done`;
  }
  if (errored_count > 0 && completed_count === run_count - errored_count) {
    return `${completed_count}/${run_count} completed · ${errored_count} failed`;
  }
  return `${completed_count}/${run_count} completed`;
}
