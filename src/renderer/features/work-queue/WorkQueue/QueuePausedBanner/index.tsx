import { Button } from '@benord-labs/frink-primitives';
import { Pause, Play } from 'lucide-react';
import type { ReactElement } from 'react';
import { useQueuePause } from '../../../../lib/work-queue/use-queue-pause';

/** Leads the Overview while the queue is paused, so the state and its Resume sit above the work.
 * Uses the activity-row anatomy (machined plate, title over description), not a generic alert. */
export function QueuePausedBanner(): ReactElement | null {
  const { paused, saving, setPaused } = useQueuePause();
  if (!paused) return null;

  return (
    <div
      role="status"
      className="glass-card mb-4 flex shrink-0 items-center gap-3 rounded-xl border border-border/70 px-3 py-2.5"
    >
      <span className="activity-row-leading flex size-9 shrink-0 items-center justify-center rounded-[10px] text-warning-fg">
        <Pause className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-medium text-ink">Queue paused</span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-fg">
          Queued flows won't start until you resume. Active work keeps running.
        </span>
      </span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-7 shrink-0 border-border/50 px-2 text-xs"
        disabled={saving}
        aria-busy={saving}
        onClick={() => setPaused(false)}
      >
        <Play className="size-3.5" aria-hidden />
        Resume queue
      </Button>
    </div>
  );
}
