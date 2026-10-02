import { toast } from 'sonner';
import { trpc } from '../trpc';

/**
 * The machine-wide queue pause. The header Pause button and the paused banner each call this; they
 * share one query cache entry, so either surface flips the other as soon as the save lands.
 */
export function useQueuePause() {
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

  return {
    loadFailed: !query.data && query.isError,
    /** `null` until the setting loads (or after a failed first load): neither state is known. */
    paused: query.data ? query.data.queue_paused : null,
    ready: Boolean(query.data),
    retry: () => void query.refetch(),
    saving: mutation.isPending,
    setPaused: (paused: boolean) => mutation.mutate({ queue_paused: paused }),
  };
}
