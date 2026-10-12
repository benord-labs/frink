import type { ReactElement } from 'react';
import { toast } from 'sonner';
import { trpc } from '../../../../lib/trpc';
import { InterruptedRunsPanel, type RecoverItem } from './InterruptedRunsPanel';

type Props = {
  /** Reloads the queue's lanes once the whole batch is done, not per run. */
  onRecovered: () => void;
};

/** The interrupted-runs panel wired to the queue: its list, its bulk recovery, one refresh after. */
export function InterruptedRunsBanner({ onRecovered }: Props): ReactElement | null {
  const utils = trpc.useUtils();
  const query = trpc.tasks.interruptedRuns.useQuery();
  const mutation = trpc.tasks.recoverInterrupted.useMutation({
    onSettled: () => {
      void utils.tasks.interruptedRuns.invalidate();
      void utils.tasks.listCounts.invalidate();
      void utils.tasks.workQueueOverviewCounts.invalidate();
      onRecovered();
    },
  });
  const recover = async (items: RecoverItem[]) => {
    try {
      return await mutation.mutateAsync({ items });
    } catch (error) {
      toast.error('Could not continue the interrupted runs', {
        description: error instanceof Error ? error.message : 'Please try again in a moment.',
      });
      return null;
    }
  };
  return <InterruptedRunsPanel runs={query.data ?? []} onContinueAll={recover} />;
}
