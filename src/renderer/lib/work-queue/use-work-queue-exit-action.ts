import { useCallback, useRef } from 'react';

type WorkQueueActionWrapper = <Args extends unknown[], Result>(
  action: (...args: Args) => Result,
) => (...args: Args) => Result;

/**
 * Decorate destination actions so the transient destination standing in front of chat (Work Queue,
 * or the Flows dashboard when the caller opts in) exits before their effects run.
 */
export function useWorkQueueExitAction(exitDestination: () => void): WorkQueueActionWrapper {
  const exitDestinationRef = useRef(exitDestination);
  const wrappersRef = useRef(new WeakMap<object, unknown>());
  exitDestinationRef.current = exitDestination;

  return useCallback(<Args extends unknown[], Result>(action: (...args: Args) => Result) => {
    const cached = wrappersRef.current.get(action);
    if (cached) return cached as (...args: Args) => Result;

    const wrapped = (...args: Args): Result => {
      exitDestinationRef.current();
      return action(...args);
    };
    wrappersRef.current.set(action, wrapped);
    return wrapped;
  }, []);
}
