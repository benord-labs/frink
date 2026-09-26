/**
 * Accept a finished task (done → completed) from anywhere a task row is rendered. A hook so
 * callers like the sidebar's ChatListItem can act directly instead of threading a handler
 * through several list layers. The complete proc also flips a flow run's sibling `done` rows,
 * so one click accepts the whole flow.
 */
import { toast } from 'sonner';
import { invalidateTaskQueries } from '../features/agents/main/active-chat/utils/task-query';
import { trpc } from '../lib/trpc';

export function useMarkTaskComplete(): (taskId: string) => void {
  const utils = trpc.useUtils();
  const mutation = trpc.tasks.complete.useMutation({
    onSuccess: () => invalidateTaskQueries(utils),
    onError: (error) => {
      toast.error('Could not mark task complete', {
        description: error.message || 'Please try again in a moment.',
      });
    },
  });
  return (taskId: string) => mutation.mutate({ taskId });
}
