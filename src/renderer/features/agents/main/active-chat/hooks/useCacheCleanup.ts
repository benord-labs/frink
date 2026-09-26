import { useEffect, useLayoutEffect } from 'react';
import { clearSubChatCaches } from '../../../stores/message-store';
import { useStreamingStatusStore } from '../../../stores/streaming-status-store';

type WindowWithCacheCleanups = Window & {
  __pendingCacheCleanups?: Map<string, number>;
};

/**
 * Hook to manage cache cleanup for sub-chats.
 * Uses delayed cleanup to avoid clearing caches during temporary unmount/remount
 * (e.g., React StrictMode, HMR, single→split pane layout changes).
 * Never clears caches while the chat is streaming — the response must reach its spawn point.
 */
export const useCacheCleanup = (subChatId: string) => {
  useEffect(() => {
    const currentSubChatId = subChatId;
    return () => {
      const timeoutId = setTimeout(() => {
        // Don't clear caches while the chat is streaming — the in-flight response
        // must be able to reach the chat that spawned it, even after navigation.
        const streamingStatus = useStreamingStatusStore.getState().getStatus(currentSubChatId);
        if (streamingStatus === 'streaming' || streamingStatus === 'submitted') {
          return;
        }
        clearSubChatCaches(currentSubChatId);
      }, 100);

      const windowWithCleanups = window as WindowWithCacheCleanups;
      windowWithCleanups.__pendingCacheCleanups =
        windowWithCleanups.__pendingCacheCleanups || new Map();
      windowWithCleanups.__pendingCacheCleanups.set(
        currentSubChatId,
        timeoutId as unknown as number,
      );
    };
  }, [subChatId]);

  // Cancel pending cleanup on remount with the same subChatId.
  // useLayoutEffect fires before paint (faster than useEffect) to beat the 100ms timer
  // during single→split pane transitions where paint can take >100ms.
  useLayoutEffect(() => {
    const windowWithCleanups = window as WindowWithCacheCleanups;
    const pendingCleanups = windowWithCleanups.__pendingCacheCleanups;
    if (pendingCleanups?.has(subChatId)) {
      clearTimeout(pendingCleanups.get(subChatId));
      pendingCleanups.delete(subChatId);
    }
  }, [subChatId]);
};
