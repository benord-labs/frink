import { memo, type ReactElement, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '../../../../lib/trpc';
import { type QueuedAdmission, QueuedAdmissionsView } from '../QueuedAdmissionsView';

type MoveResult = {
  status: 'moved' | 'unchanged' | 'stale' | 'priority_mismatch';
};

const STALE_QUEUE_TOAST = {
  title: 'Queued work already started',
  description: 'The queue was refreshed. Nothing was removed.',
};

export const QueuedAdmissions = memo(function QueuedAdmissions(): ReactElement | null {
  const utils = trpc.useUtils();
  const [announcement, setAnnouncement] = useState('');
  const query = trpc.flows.workQueueAdmissions.useQuery(undefined, {
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
    structuralSharing: true,
  });
  const mutation = trpc.flows.moveWorkQueueAdmission.useMutation();
  const removeMutation = trpc.flows.cancelWorkQueueAdmission.useMutation();
  const rows: QueuedAdmission[] = useMemo(
    () =>
      (query.data ?? []).map((row) => ({
        flowName: row.flow_name,
        isBatchMember: row.is_batch_member,
        priorityClass: row.priority_class,
        projectName: row.project_name,
        ticket: row.ticket,
      })),
    [query.data],
  );
  const refreshQueueViews = useCallback(
    () =>
      Promise.all([
        utils.flows.workQueueAdmissions.invalidate(),
        utils.tasks.workQueueOverviewCounts.invalidate(),
        // Removing a queued resume un-hides that run's tasks in the Overview lanes.
        utils.tasks.listPaginated.invalidate(),
      ]),
    [
      utils.flows.workQueueAdmissions,
      utils.tasks.listPaginated,
      utils.tasks.workQueueOverviewCounts,
    ],
  );
  const move = useCallback(
    async (ticket: number, targetTicket: number, targetPosition: number) => {
      let result: MoveResult;
      try {
        // biome-ignore lint/style/useNamingConvention: Flows retain their raw snake_case API contract.
        result = await mutation.mutateAsync({ ticket, target_ticket: targetTicket });
      } catch (error) {
        toast.error('Could not reorder the queue', {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
        await query.refetch();
        return;
      }

      await refreshQueueViews();
      if (result.status === 'moved') {
        const item = rows.find((row) => row.ticket === ticket);
        const group = item?.priorityClass === 'resume' ? 'Resuming' : 'Starting';
        setAnnouncement(
          `${item?.flowName ?? 'Queued flow'} moved to position ${targetPosition + 1} in ${group}.`,
        );
        return;
      }
      if (result.status !== 'unchanged') {
        toast.error('Queue order changed', {
          description: 'The queued work was refreshed. Try the move again.',
        });
      }
    },
    [mutation, query, refreshQueueViews, rows],
  );

  /** True only when the row is really gone — the view uses that to decide whether to take focus. */
  const remove = useCallback(
    async (admission: QueuedAdmission): Promise<boolean> => {
      let status: 'removed' | 'stale';
      try {
        ({ status } = await removeMutation.mutateAsync({ ticket: admission.ticket }));
      } catch (error) {
        toast.error('Could not remove the queued work', {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
        await query.refetch();
        return false;
      }

      await refreshQueueViews();
      if (status === 'stale') {
        toast.info(STALE_QUEUE_TOAST.title, { description: STALE_QUEUE_TOAST.description });
        await query.refetch();
        return false;
      }
      setAnnouncement(`${admission.flowName} removed from the queue.`);
      return true;
    },
    [query, refreshQueueViews, removeMutation],
  );

  return (
    <QueuedAdmissionsView
      announcement={announcement}
      error={query.isError}
      loading={query.isLoading}
      moving={mutation.isPending || removeMutation.isPending}
      onMove={move}
      onRemove={remove}
      onRetry={() => void query.refetch()}
      rows={rows}
    />
  );
});
