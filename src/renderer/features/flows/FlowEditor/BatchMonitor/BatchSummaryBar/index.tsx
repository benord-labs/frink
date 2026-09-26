import type { ReactElement } from 'react';
import type { BatchSummary } from '../../../../../../shared/types/flows/flow-batch';
import { formatRelativeTime } from '../../../../../lib/utils/format-time';

type BatchSummaryBarProps = {
  batchSummary: BatchSummary;
  ordinal: number;
};

export function BatchSummaryBar({ batchSummary, ordinal }: BatchSummaryBarProps): ReactElement {
  return (
    <div className="flex items-center gap-3 border-b border-border/30 px-4 py-2.5 shrink-0 flex-wrap">
      <span className="text-xs font-semibold text-foreground/80">Batch {ordinal}</span>
      <div className="flex items-center gap-2 text-[11px] flex-wrap">
        <span className="text-muted-foreground">
          <span className="text-[hsl(var(--status-online-text))] font-medium">
            {batchSummary.completed_count}
          </span>
          <span className="text-muted-foreground/60">/{batchSummary.run_count} completed</span>
        </span>
        {batchSummary.active_count > 0 && (
          <span className="text-primary font-medium">· {batchSummary.active_count} active</span>
        )}
        {batchSummary.errored_count > 0 && (
          <span className="text-destructive font-medium">
            · {batchSummary.errored_count} failed
          </span>
        )}
        {batchSummary.last_activity_at && (
          <span className="text-muted-foreground/50">
            · {formatRelativeTime(batchSummary.last_activity_at)}
          </span>
        )}
      </div>
    </div>
  );
}
