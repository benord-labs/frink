import { useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';

/** Starts a Flow step that is waiting for the user; the executor runs it in the step's own chat.
 * `starting` latches on the click itself and holds through success, so a double click sends one. */
export function useStartWaitingTask() {
  const utils = trpc.useUtils();
  const [starting, setStarting] = useState(false);
  const mutation = trpc.tasks.startWaiting.useMutation({
    // Not returned, so a caller awaiting the start does not also wait for these refetches.
    onSuccess: () => void utils.tasks.invalidate(),
    onError: (error) => toast.error("Couldn't start this step", { description: error.message }),
  });
  const start = async (taskId: string) => {
    setStarting(true);
    try {
      await mutation.mutateAsync({ taskId });
      return true;
    } catch {
      setStarting(false); // the error toast above already told the user
      return false;
    }
  };
  return { starting, start };
}
