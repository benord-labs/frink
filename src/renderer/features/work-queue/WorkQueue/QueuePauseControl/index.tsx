import { Button } from '@benord-labs/frink-primitives';
import { Pause } from 'lucide-react';
import { type ReactElement, useId } from 'react';
import { useQueuePause } from '../../../../lib/work-queue/use-queue-pause';

/** Header entry point for pausing. Once paused, the overview banner owns the state and Resume. */
export function QueuePauseControl(): ReactElement | null {
  const descriptionId = useId();
  const { loadFailed, paused, ready, retry, saving, setPaused } = useQueuePause();

  if (loadFailed) {
    return (
      <Button type="button" variant="secondary" size="sm" onClick={retry}>
        Retry queue controls
      </Button>
    );
  }
  if (paused) return null;

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-7 border-border/50 px-2 text-xs"
        disabled={!ready || saving}
        aria-busy={!ready || saving}
        aria-describedby={descriptionId}
        title="Pause queued Flow runs on this machine. Active work continues."
        onClick={() => setPaused(true)}
      >
        <Pause className="h-3.5 w-3.5" aria-hidden />
        Pause queue
      </Button>
      <span id={descriptionId} className="sr-only">
        Pauses queued Flow runs on this machine until you resume, including after restarting Frink.
        Active work continues.
      </span>
    </>
  );
}
