import { keepPreviousData } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { MAX_HELD_RUNS_LISTED } from '../../../../shared/lib/flow-admission/constants';
import { trpc } from '../../trpc';
import { refreshWorkQueue, withPending } from '../approvals/use-work-queue-approvals';

const HELD_RUNS_PAGE_SIZE = 50;

/** Runs waiting for the user to press Start (the Work Queue Inbox), newest first, a page at a time. */
export function useHeldRuns() {
  const [limit, setLimit] = useState(HELD_RUNS_PAGE_SIZE);
  const { data, isPlaceholderData } = trpc.flows.workQueueHeldRuns.useQuery(
    { limit },
    {
      placeholderData: keepPreviousData,
      refetchInterval: 5000,
      refetchOnWindowFocus: true,
      structuralSharing: true,
    },
  );
  const runs = data?.runs ?? [];
  const total = data?.total ?? 0;
  return {
    runs,
    total,
    canLoadOlder: total > runs.length && runs.length < MAX_HELD_RUNS_LISTED,
    isLoadingOlder: isPlaceholderData,
    loadOlder: () => setLimit(Math.min(runs.length + HELD_RUNS_PAGE_SIZE, MAX_HELD_RUNS_LISTED)),
  };
}

export type HeldRun = ReturnType<typeof useHeldRuns>['runs'][number];

type HeldRunAction = 'start' | 'dismiss';

export type HeldRunActions = {
  start: (run: HeldRun) => void;
  dismiss: (run: HeldRun) => void;
  /** The action sent per run; that run's buttons stay disabled unless it fails. */
  pending: ReadonlyMap<string, HeldRunAction>;
};

/** Start runs a held run to the end; Dismiss cancels it while it still waits. 'stale' means another
 *  surface handled the run first. */
export function useHeldRunActions(): HeldRunActions {
  const utils = trpc.useUtils();
  const [pending, setPending] = useState<ReadonlyMap<string, HeldRunAction>>(new Map());
  const track = (runId: string, action: HeldRunAction | null) =>
    setPending((current) => withPending(current, runId, action));
  const settle = async (
    runId: string,
    stale: boolean,
    error: { message: string } | null,
    failureTitle: string,
  ) => {
    await refreshWorkQueue(utils);
    // A handled run's row can render once more before the refreshed list drops it; keep it disabled.
    if (error) {
      track(runId, null);
      toast.error(failureTitle, { description: error.message || 'Please try again.' });
    } else if (stale) {
      toast.info('Already handled', {
        description: 'This run was started or dismissed somewhere else.',
      });
    }
  };
  const start = trpc.flows.startHeldRun.useMutation({
    onSettled: (data, error, input) =>
      settle(input.run_id, data?.status === 'stale', error, 'Could not start the run'),
  });
  const dismiss = trpc.flows.dismissHeldRun.useMutation({
    onSettled: (data, error, input) =>
      settle(input.run_id, data?.status === 'stale', error, 'Could not dismiss the run'),
  });

  return {
    start: (run) => {
      track(run.flow_run_id, 'start');
      start.mutate({ run_id: run.flow_run_id });
    },
    dismiss: (run) => {
      track(run.flow_run_id, 'dismiss');
      dismiss.mutate({ run_id: run.flow_run_id });
    },
    pending,
  };
}
