import type { UIMessage } from 'ai';
import { useAtomValue, useSetAtom } from 'jotai';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { appStore } from '../../../../../lib/jotai-store';
// Read liveness from the dependency-free registry, not the transport's re-export — importing the
// transport here would drag trpc/Sentry into a leaf module (the reason that registry exists).
import {
  hasActiveTransport,
  observedRunAtomFamily,
} from '../../../../../lib/stores/active-transport-registry';
import { useIsPaneActive } from '../../../hooks/use-is-pane-active';
import { chatSearchCurrentMatchAtom } from '../../../search';
import {
  chatStatusAtom,
  remoteStreamingAtom,
  syncMessagesWithStatusAtom,
} from '../../../stores/message-store';
import { useStreamingStatusStore } from '../../../stores/streaming-status-store';

/**
 * Compute status to sync: treat stale "streaming"/"submitted" (no active transport) as "ready".
 *
 * An observed run overrides both directions. useChat reports "ready" for a wake burst — its own
 * stream closed when the arming turn ended — so without this the shimmer never runs and every
 * in-flight tool card renders as interrupted. `error` is never masked.
 *
 * `observedRun` is a PARAMETER, not an `appStore.get` inside: both callers below are effects, and
 * useChat's `status` does not change across a burst, so an internal read would leave the effect
 * that feeds the queue-processor's dispatch gate stale for the burst's whole life — the queue
 * would then dispatch a queued send on top of a live burst.
 */
export function getEffectiveStatus(
  status: string,
  subChatId: string,
  observedRun: boolean,
): 'ready' | 'streaming' | 'submitted' | 'error' {
  if (observedRun) {
    return status === 'error' ? 'error' : 'streaming';
  }
  if ((status === 'streaming' || status === 'submitted') && !hasActiveTransport(subChatId)) {
    return 'ready';
  }
  return status as 'ready' | 'streaming' | 'submitted' | 'error';
}

type Props = {
  isActive: boolean;
  subChatId: string;
  messages: UIMessage[];
  status: string;
};

export function MessageSyncManager({ isActive, subChatId, messages, status }: Props) {
  // Track the subChatId from the previous effect run so we can detect the transition
  // render where subChatId just changed but useChat still holds the previous chat's messages.
  const prevSubChatIdRef = useRef(subChatId);
  // Subscribed, not read imperatively: a burst flips this while useChat's own status sits still.
  const observedRun = useAtomValue(observedRunAtomFamily(subChatId));

  // Sync messages to Jotai store for isolated rendering.
  // Always sync (even when !isActive) so per-subChat atoms are populated
  // for all split view panes. Global atoms are only written when isActive.
  // Compute effectiveStatus at sync time so we read hasActiveTransport() fresh (module-level Map is not reactive).
  const syncMessages = useSetAtom(syncMessagesWithStatusAtom);
  useLayoutEffect(() => {
    const prevSubChatId = prevSubChatIdRef.current;
    prevSubChatIdRef.current = subChatId;

    // Guard: skip this render if subChatId just changed AND messages are non-empty.
    // On the transition render, useChat may still hold the previous chat's messages
    // (stale internal state). Syncing them would write the old chat's content into
    // the new subChatId's per-subChat atoms. The next render will have fresh messages.
    if (prevSubChatId !== subChatId && messages.length > 0) {
      return;
    }

    const effectiveStatus = getEffectiveStatus(status, subChatId, observedRun);
    syncMessages({ messages, status: effectiveStatus, subChatId, isActive });
    // When correction fires (stale streaming/submitted but no active transport), remoteStreamingAtom
    // may still be true from a previous mount, so syncMessagesWithStatusAtom skips updating
    // chatStatusAtom. Reset both so the UI shows "ready" instead of stuck "Thinking".
    if (
      isActive &&
      effectiveStatus === 'ready' &&
      (status === 'streaming' || status === 'submitted')
    ) {
      appStore.set(remoteStreamingAtom, false);
      appStore.set(chatStatusAtom, 'ready');
    }
  }, [messages, status, subChatId, syncMessages, isActive, observedRun]);

  // Sync status to global streaming status store for queue processing
  const setStreamingStatus = useStreamingStatusStore((s) => s.setStatus);
  useEffect(() => {
    const effectiveStatus = getEffectiveStatus(status, subChatId, observedRun);
    setStreamingStatus(subChatId, effectiveStatus);
  }, [subChatId, status, setStreamingStatus, observedRun]);

  return null;
}

export function useSearchScrollManager(
  chatContainerRef: React.RefObject<HTMLElement | null>,
  splitPaneIndex?: number,
) {
  const currentSearchMatch = useAtomValue(chatSearchCurrentMatchAtom);
  const searchScrollLockRef = useRef<number>(0);
  const isActivePane = useIsPaneActive(splitPaneIndex);

  useEffect(() => {
    if (!currentSearchMatch || !isActivePane) return;

    const container = chatContainerRef.current;
    if (!container) return;

    const currentLock = ++searchScrollLockRef.current;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (searchScrollLockRef.current !== currentLock) return;

          let targetElement: Element | null = container.querySelector('.search-highlight-current');

          if (!targetElement) {
            const selector = `[data-message-id="${currentSearchMatch.messageId}"][data-part-index="${currentSearchMatch.partIndex}"]`;
            targetElement = container.querySelector(selector);
          }

          if (targetElement) {
            const stickyParent = targetElement.closest('[data-user-message-id]');
            if (stickyParent) {
              const messageGroupWrapper = stickyParent.parentElement;
              if (messageGroupWrapper) {
                messageGroupWrapper.scrollIntoView({
                  behavior: 'smooth',
                  block: 'start',
                });
                return;
              }
            }

            targetElement.scrollIntoView({
              behavior: 'smooth',
              block: 'center',
            });
          }
        }, 50);
      });
    });
  }, [currentSearchMatch, chatContainerRef, isActivePane]);
}
