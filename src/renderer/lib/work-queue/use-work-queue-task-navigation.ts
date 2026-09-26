import { useStore } from 'jotai';
import { useCallback, useEffect, useRef } from 'react';
import { activeOverlayAtom } from '../atoms';
import { claimWorkQueueTaskNavigationAtom } from './work-queue-navigation';

type ReturnValue = {
  ownsTaskNavigation: () => boolean;
  navigateToChatIfOwned: (chatId: string) => boolean;
};

/** Gate async task navigation by both its originating mount and the live destination owner. */
export function useWorkQueueTaskNavigation(
  onNavigateToChat: (chatId: string) => void,
): ReturnValue {
  const store = useStore();
  const ownsTaskNavigationRef = useRef(true);
  useEffect(() => {
    ownsTaskNavigationRef.current = true;
    return () => {
      ownsTaskNavigationRef.current = false;
    };
  }, []);
  const ownsTaskNavigation = useCallback(
    () => ownsTaskNavigationRef.current && store.get(activeOverlayAtom) === 'workqueue',
    [store],
  );
  const navigateToChatIfOwned = useCallback(
    (chatId: string): boolean => {
      if (!ownsTaskNavigation() || !store.set(claimWorkQueueTaskNavigationAtom)) {
        return false;
      }
      onNavigateToChat(chatId);
      return true;
    },
    [onNavigateToChat, ownsTaskNavigation, store],
  );
  return { ownsTaskNavigation, navigateToChatIfOwned };
}
