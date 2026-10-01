import { Button } from '@benord-labs/frink-primitives';
import { Pause, Play } from 'lucide-react';
import { useId } from 'react';
import { toast } from 'sonner';
import { trpc } from '../../../../lib/trpc';

export function QueuePauseControl() {
  const descriptionId = useId();
  const utils = trpc.useUtils();
  const query = trpc.flows.getAdmissionSettings.useQuery(undefined, {
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  });
  const mutation = trpc.flows.updateAdmissionSettings.useMutation({
    onSuccess: (settings) => {
      utils.flows.getAdmissionSettings.setData(undefined, settings);
      void utils.flows.getAdmissionSettings.invalidate();
      void utils.flows.workQueueAdmissions.invalidate();
      void utils.tasks.workQueueOverviewCounts.invalidate();
    },
    onError: (error) => {
      toast.error('Could not change queue execution', { description: error.message });
    },
  });
  const paused = query.data?.queue_paused === true;
  const Icon = paused ? Play : Pause;

  if (!query.data && query.isError) {
    return (
      <Button type="button" variant="secondary" size="sm" onClick={() => void query.refetch()}>
        Retry queue controls
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span role="status" className="text-xs text-muted-foreground">
        {paused ? 'Queue paused' : ''}
      </span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-7 border-border/50 px-2 text-xs"
        disabled={!query.data || mutation.isPending}
        aria-busy={query.isLoading || mutation.isPending}
        aria-describedby={descriptionId}
        title="Pause queued Flow runs on this machine. Active work continues."
        onClick={() => mutation.mutate({ queue_paused: !paused })}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {paused ? 'Resume queue' : 'Pause queue'}
      </Button>
      <span id={descriptionId} className="sr-only">
        Pauses queued Flow runs on this machine until you resume, including after restarting Frink.
        Active work continues.
      </span>
    </div>
  );
}
