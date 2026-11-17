import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

type AttentionSelection = {
  promoteTask: (taskId: string) => void;
  selectTask: (taskId: string) => void;
  selectedTaskId: string | null;
  spotlightActionRef: RefObject<HTMLButtonElement | null>;
};

export function useAttentionSelection(tasks: ReadonlyArray<{ id: string }>): AttentionSelection {
  const [requestedTaskId, setRequestedTaskId] = useState<string | null>(null);
  const focusPromotedTaskRef = useRef(false);
  const spotlightActionRef = useRef<HTMLButtonElement>(null);
  const requestedTaskExists = tasks.some((task) => task.id === requestedTaskId);
  const selectedTaskId = requestedTaskExists ? requestedTaskId : (tasks[0]?.id ?? null);

  // Pin what the spotlight shows, so an item arriving on a later poll never replaces it uninvited.
  useEffect(() => {
    if (requestedTaskExists) return;
    setRequestedTaskId(selectedTaskId);
  }, [requestedTaskExists, selectedTaskId]);

  useLayoutEffect(() => {
    if (!focusPromotedTaskRef.current) return;
    focusPromotedTaskRef.current = false;
    spotlightActionRef.current?.focus();
  });

  const selectTask = useCallback((taskId: string) => {
    setRequestedTaskId(taskId);
  }, []);

  const promoteTask = useCallback((taskId: string) => {
    focusPromotedTaskRef.current = true;
    setRequestedTaskId(taskId);
  }, []);

  return { promoteTask, selectTask, selectedTaskId, spotlightActionRef };
}
