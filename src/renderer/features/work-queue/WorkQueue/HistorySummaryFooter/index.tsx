import { Button, Separator } from '@benord-labs/frink-primitives';
import { ArrowRight, Check, History } from 'lucide-react';
import type { ReactElement, RefObject } from 'react';

type Props = {
  cancelledCount: number;
  completedCount: number;
  historyButtonRef: RefObject<HTMLButtonElement | null>;
  onViewHistory: () => void;
};

export function HistorySummaryFooter({
  cancelledCount,
  completedCount,
  historyButtonRef,
  onViewHistory,
}: Props): ReactElement | null {
  const historyCount = completedCount + cancelledCount;
  if (historyCount <= 0) return null;

  const summary =
    completedCount > 0
      ? `${completedCount} task${completedCount === 1 ? '' : 's'} reviewed and shipped${cancelledCount > 0 ? ` · ${cancelledCount} cancelled` : ''}`
      : `${cancelledCount} cancelled task${cancelledCount === 1 ? '' : 's'} in history`;
  const summaryClassName = `min-w-0 truncate text-xs ${completedCount > 0 ? 'text-[hsl(var(--status-online-text))]' : 'text-muted-foreground'}`;
  return (
    <section aria-label="Task history" className="shrink-0">
      <Separator />
      <div className="flex min-w-0 items-center gap-2 pt-3">
        {completedCount > 0 ? (
          <Check className="size-3.5 shrink-0 text-[hsl(var(--status-online-text))]" aria-hidden />
        ) : (
          <History className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className={summaryClassName}>{summary}</span>
        <Button
          ref={historyButtonRef}
          type="button"
          variant="ghost"
          size="xs"
          onClick={onViewHistory}
          className="ml-auto shrink-0 text-muted-foreground"
          aria-label="View task history"
        >
          View history
          <ArrowRight className="size-3" aria-hidden />
        </Button>
      </div>
    </section>
  );
}
