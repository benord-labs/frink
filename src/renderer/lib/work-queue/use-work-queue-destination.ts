import { useCallback, useRef } from 'react';
import { navigateFromWorkQueue } from './work-queue-navigation';

/**
 * Actions that act on chat surfaces absent from the transient destination, so the destination must
 * transfer first. Pure view chrome that the destination also renders (the unified sidebar) belongs
 * to the visible destination and stays out of this set. Exported so tests can pin the whole set
 * against destinations that must survive it.
 */
export const EXIT_HOTKEY_ACTIONS = new Set([
  'create-new-agent',
  'toggle-chat-search',
  'toggle-files',
  'file-search',
  'find-in-files',
  'close-all-editor-files',
  'toggle-editor-layout',
  'open-branch-picker',
  'open-branch-delete-picker',
  'new-agent-split',
  'close-split',
  'next-pane-group',
  'prev-pane-group',
  'next-pane',
  'prev-pane',
  'cycle-pane-layout',
  'grow-pane',
  'shrink-pane',
  'reset-pane-sizes',
  'reset-pane-zoom',
  'zoom-in-grow-pane',
  'zoom-out-shrink-pane',
  'zoom-pane-in',
  'zoom-pane-out',
]);
const DEFERRED_HOTKEY_ACTIONS = new Set([
  'close-split',
  'close-all-editor-files',
  'toggle-editor-layout',
  'open-branch-picker',
  'open-branch-delete-picker',
  'next-pane-group',
  'prev-pane-group',
]);

type Input = {
  isMobile: boolean;
  isSplitActive: boolean;
  setActiveOverlay: (overlay: null) => void;
  exitWorkQueueForNavigation: () => boolean;
  fillActivePane: (chatId: string) => void;
  selectChat: (chatId: string) => void;
  focusWorkQueueTrigger: () => void;
};

type ReturnValue = {
  closeOverlay: () => void;
  requestWorkQueueClose: () => void;
  navigateWorkQueueToChat: (chatId: string) => void;
  prepareForAgentsHotkey: (actionId: string) => boolean | Promise<boolean>;
};

type DestinationSettle = {
  actionIds: Set<string>;
  promise: Promise<boolean>;
};

function isUnavailableFocusTarget(element: HTMLElement): boolean {
  return element.closest('[aria-hidden="true"], [inert], [hidden]') !== null;
}

function focusMobileChatDestination(): void {
  const returnTarget = document.querySelector<HTMLElement>('[data-work-queue-return-target]');
  if (!returnTarget || isUnavailableFocusTarget(returnTarget)) return;

  const chatInput = Array.from(
    returnTarget.querySelectorAll<HTMLElement>('[data-chat-input="true"]'),
  ).find((input) => !isUnavailableFocusTarget(input));
  if (chatInput) {
    chatInput.focus();
    return;
  }

  returnTarget.focus();
}

/** Own destination transitions while keeping async callbacks current across renders. */
export function useWorkQueueDestination(input: Input): ReturnValue {
  const latestRef = useRef(input);
  const destinationSettleRef = useRef<DestinationSettle | null>(null);
  latestRef.current = input;

  const closeOverlay = useCallback(() => latestRef.current.setActiveOverlay(null), []);
  const requestWorkQueueClose = useCallback(() => {
    latestRef.current.setActiveOverlay(null);
    requestAnimationFrame(() => {
      if (latestRef.current.isMobile) {
        focusMobileChatDestination();
      } else {
        latestRef.current.focusWorkQueueTrigger();
      }
    });
  }, []);
  const navigateWorkQueueToChat = useCallback((chatId: string) => {
    const latest = latestRef.current;
    navigateFromWorkQueue({
      chatId,
      isMobile: latest.isMobile,
      isSplitActive: latest.isSplitActive,
      closeWorkQueue: () => latest.setActiveOverlay(null),
      fillActivePane: latest.fillActivePane,
      selectChat: latest.selectChat,
    });
  }, []);
  const prepareForAgentsHotkey = useCallback((actionId: string): boolean | Promise<boolean> => {
    if (!EXIT_HOTKEY_ACTIONS.has(actionId)) return true;

    const pendingSettle = destinationSettleRef.current;
    if (DEFERRED_HOTKEY_ACTIONS.has(actionId) && pendingSettle) {
      if (pendingSettle.actionIds.has(actionId)) return false;
      pendingSettle.actionIds.add(actionId);
      return pendingSettle.promise;
    }

    const latest = latestRef.current;
    if (!latest.exitWorkQueueForNavigation() || !DEFERRED_HOTKEY_ACTIONS.has(actionId)) return true;

    const destinationSettle = new Promise<boolean>((resolve) => {
      requestAnimationFrame(() => resolve(true));
    });
    destinationSettleRef.current = { actionIds: new Set([actionId]), promise: destinationSettle };
    void destinationSettle.then(() => {
      if (destinationSettleRef.current?.promise === destinationSettle) {
        destinationSettleRef.current = null;
      }
    });
    return destinationSettle;
  }, []);

  return {
    closeOverlay,
    requestWorkQueueClose,
    navigateWorkQueueToChat,
    prepareForAgentsHotkey,
  };
}
