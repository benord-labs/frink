import { toast } from 'sonner';
import { trpc } from '../../trpc';
import { recoveryWaitToast } from '../admission-wait-copy';

type RecoverOptions = NonNullable<Parameters<typeof trpc.tasks.recover.useMutation>[0]>;

/** tasks.recover, saying so when a paused run that gave its slot up must wait for a free one. */
export function useRecoverTaskMutation(options: RecoverOptions = {}) {
  return trpc.tasks.recover.useMutation({
    ...options,
    onSuccess: (...args) => {
      const title = recoveryWaitToast(args[0].outcome);
      if (title) toast.info(title, { description: 'It starts when a slot frees up.' });
      return options.onSuccess?.(...args);
    },
  });
}
