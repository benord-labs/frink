import { trpc } from '../../../../lib/trpc';

type WorkQueueOverviewCounts = {
  inbox: number;
  queued: number;
  review: number;
  running: number;
};

export function useWorkQueueOverviewCounts(
  fallback: WorkQueueOverviewCounts,
): WorkQueueOverviewCounts {
  const overviewQuery = trpc.tasks.workQueueOverviewCounts.useQuery(undefined, {
    refetchInterval: 5000,
    structuralSharing: true,
  });
  const admissionsQuery = trpc.flows.workQueueAdmissions.useQuery(undefined, {
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
    structuralSharing: true,
  });

  return {
    inbox: overviewQuery.data?.inbox ?? fallback.inbox,
    queued: admissionsQuery.data?.length ?? overviewQuery.data?.queued ?? fallback.queued,
    review: overviewQuery.data?.review ?? fallback.review,
    running: overviewQuery.data?.running ?? fallback.running,
  };
}
