import { toast } from 'sonner';
import { trpc } from '../../trpc';

type RecoverOptions = NonNullable<Parameters<typeof trpc.tasks.recover.useMutation>[0]>;

/** tasks.recover, saying so when a paused run that gave its slot up must wait for a free one. */
export function useRecoverTaskMutation(options: RecoverOptions = {}) {
  return trpc.tasks.recover.useMutation({
    ...options,
    onSuccess: (...args) => {
      if (args[0].outcome === 'queued') {
        toast.info('Queued to resume', { description: 'It starts when a slot frees up.' });
      }
      return options.onSuccess?.(...args);
    },
  });
}
