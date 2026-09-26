import { atom } from 'jotai';
import { activeOverlayAtom } from '../atoms';

/** Atomically claim a task navigation only while Work Queue is the live destination owner. */
export const claimWorkQueueTaskNavigationAtom = atom(null, (get, set): boolean => {
  if (get(activeOverlayAtom) !== 'workqueue') return false;
  set(activeOverlayAtom, null);
  return true;
});

type Input = {
  chatId: string;
  isMobile: boolean;
  isSplitActive: boolean;
  closeWorkQueue: () => void;
  fillActivePane: (chatId: string) => void;
  selectChat: (chatId: string) => void;
};

/** Close the destination first, then route using the current responsive split-view state. */
export function navigateFromWorkQueue({
  chatId,
  isMobile,
  isSplitActive,
  closeWorkQueue,
  fillActivePane,
  selectChat,
}: Input): void {
  closeWorkQueue();
  if (!isMobile && isSplitActive) fillActivePane(chatId);
  else selectChat(chatId);
}
