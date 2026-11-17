import { trpc } from '../../../../lib/trpc';
import { useAwaitingApprovals } from '../../../../lib/work-queue/approvals/use-work-queue-approvals';

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
  const approvalCount = useAwaitingApprovals().length;

  return {
    inbox: overviewQuery.data?.inbox ?? fallback.inbox,
    queued: admissionsQuery.data?.length ?? overviewQuery.data?.queued ?? fallback.queued,
    review: (overviewQuery.data?.review ?? fallback.review) + approvalCount,
    running: overviewQuery.data?.running ?? fallback.running,
  };
}
