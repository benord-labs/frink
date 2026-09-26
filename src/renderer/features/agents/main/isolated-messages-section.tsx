/* eslint-disable max-lines, max-lines-per-function */

import { Button } from '@benord-labs/frink-primitives';
import * as Sentry from '@sentry/electron/renderer';
import { useAtomValue } from 'jotai';
import { memo, useCallback, useEffect, useRef } from 'react';
import { userMessageIdsForSubChatAtomFamily } from '../stores/message-store';
import type { IsolatedChatSharedProps } from './active-chat/types';
import { areIsolatedChatSharedPropsEqual, IsolatedMessageGroup } from './isolated-message-group';

// ============================================================================
// ISOLATED MESSAGES SECTION (LAYER 3)
// ============================================================================
// Renders ALL message groups by subscribing to userMessageIdsForSubChatAtomFamily.
// Only re-renders when a new user message is added (new conversation turn).
// Each group independently subscribes to its own data via IsolatedMessageGroup.
//
// During streaming:
// - This component does NOT re-render (userMessageIds don't change)
// - Individual groups don't re-render (their user msg + assistant IDs don't change)
// - Only the AssistantMessageItem for the streaming message re-renders
// ============================================================================

type IsolatedMessagesSectionProps = IsolatedChatSharedProps & {
  // biome-ignore lint/style/useNamingConvention: Renders as a component
  UserBubbleComponent: React.ComponentType<{
    messageId: string;
    textContent: string;
    imageParts: Array<{ type: string; data?: { url?: string; [key: string]: unknown } }>;
    skipTextMentionBlocks?: boolean;
  }>;
  /** Load next page of older messages. No-op when streaming. */
  loadOlderMessages?: () => Promise<void>;
  /** Whether there are older messages to load. */
  hasOlderMessages?: boolean;
  /** True while a "load older" request is in flight. */
  isLoadingOlderMessages?: boolean;
  /** Error from load older (if any). Show retry when set. */
  loadOlderError?: Error | null;
  /** Scroll container ref for IntersectionObserver root and scroll preservation on prepend. */
  chatContainerRef?: React.RefObject<HTMLElement | null>;
  /** Current chat status; when streaming/submitted we do not call loadOlderMessages. */
  status?: string;
};

function areSectionPropsEqual(
  prev: IsolatedMessagesSectionProps,
  next: IsolatedMessagesSectionProps,
): boolean {
  return (
    prev.UserBubbleComponent === next.UserBubbleComponent &&
    areIsolatedChatSharedPropsEqual(prev, next) &&
    prev.loadOlderMessages === next.loadOlderMessages &&
    prev.hasOlderMessages === next.hasOlderMessages &&
    prev.isLoadingOlderMessages === next.isLoadingOlderMessages &&
    prev.loadOlderError === next.loadOlderError &&
    prev.chatContainerRef === next.chatContainerRef &&
    prev.status === next.status
  );
}

/** Resolves after two frames: one for React to commit the prepend, one for it to lay out. */
function nextLayout() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export const IsolatedMessagesSection = memo(function IsolatedMessagesSection({
  subChatId,
  chatId,
  taskId,
  isMobile,
  sandboxSetupStatus,
  stickyTopClass,
  sandboxSetupError,
  onRetrySetup,
  UserBubbleComponent,
  ToolCallComponent,
  MessageGroupWrapper,
  toolRegistry,
  showChatRetryControl,
  retryInFlight,
  onRetryChat,
  onCarryOnChat,
  chatRetryTooltipText,
  loadOlderMessages,
  hasOlderMessages = false,
  isLoadingOlderMessages = false,
  loadOlderError = null,
  chatContainerRef,
  status = 'ready',
}: IsolatedMessagesSectionProps) {
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const loadOlderInFlightRef = useRef(false);
  const isMountedRef = useRef(true);
  const hasUserScrolledUpRef = useRef(false);
  const lastScrollTopRef = useRef<number | null>(null);
  const prevSubChatIdRef = useRef(subChatId);

  // Per-subChat atoms: each subChat has its own independent message IDs atom.
  const userMsgIds = useAtomValue(userMessageIdsForSubChatAtomFamily(subChatId));

  const isStreaming = status === 'streaming' || status === 'submitted';

  const topIntentThreshold = 200;

  // Reset scroll-intent tracking when sub-chat changes.
  if (prevSubChatIdRef.current !== subChatId) {
    prevSubChatIdRef.current = subChatId;
    hasUserScrolledUpRef.current = false;
    lastScrollTopRef.current = null;
  }

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Require actual user upward scrolling before observer-driven pagination can fire.
  // This prevents mount-time observer intersections from draining history immediately.
  useEffect(() => {
    const container = chatContainerRef?.current;
    if (!container) return;

    const handleContainerScroll = () => {
      const currentScrollTop = container.scrollTop;
      const previousScrollTop = lastScrollTopRef.current;
      // Treat "user scrolled up" as meaningful only when moving upward
      // while approaching the top zone. This avoids false positives from
      // programmatic/clamped scroll adjustments during initialization.
      if (
        previousScrollTop !== null &&
        currentScrollTop < previousScrollTop - 1 &&
        currentScrollTop <= topIntentThreshold * 2
      ) {
        hasUserScrolledUpRef.current = true;
      }
      lastScrollTopRef.current = currentScrollTop;
    };

    handleContainerScroll();
    container.addEventListener('scroll', handleContainerScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleContainerScroll);
    };
  }, [chatContainerRef]);

  const handleLoadOlder = useCallback(async () => {
    if (!loadOlderMessages || isStreaming || loadOlderInFlightRef.current || !hasOlderMessages)
      return;
    if (!hasUserScrolledUpRef.current) return;

    // Top-intent gate: only load older when the user has actually scrolled near the top.
    // This prevents mount-time observer intersections from auto-draining the entire history
    // before the scroll owner has placed the viewport at the bottom.
    const container = chatContainerRef?.current;
    if (container && container.scrollTop > topIntentThreshold) return;

    const prevScrollTop = container?.scrollTop ?? 0;
    const prevScrollHeight = container?.scrollHeight ?? 0;
    loadOlderInFlightRef.current = true;
    try {
      await loadOlderMessages();
      await nextLayout();
      // Assign an absolute offset, never `+=`. The viewport inherits Chromium's default
      // overflow-anchor, which may already have compensated for the prepend; an absolute write
      // is idempotent against that, whereas a relative one would add the delta a second time
      // and drop the reader a full page. The cost is that the anchor is taken when the request
      // starts, so scrolling mid-fetch is overridden — see the tests for the pinned behaviour.
      // The mounted check stops a late frame moving a viewport this section no longer owns.
      if (isMountedRef.current && container) {
        container.scrollTop = prevScrollTop + (container.scrollHeight - prevScrollHeight);
      }
    } catch (error) {
      // No current producer rejects — useSubChatMessages.loadOlder catches internally and sets
      // loadOlderError. This guards the prop contract: a future rejecting producer would bypass
      // that hook, leaving loadOlderError null, so report here rather than fail silently.
      Sentry.captureException(error, {
        tags: { source: 'IsolatedMessagesSection.handleLoadOlder' },
        extra: { subChatId },
      });
    } finally {
      // Released only after the viewport has moved — until then the sentinel is still on
      // screen, and a second observer hit would page again against an already-grown height.
      loadOlderInFlightRef.current = false;
    }
  }, [loadOlderMessages, hasOlderMessages, isStreaming, chatContainerRef, subChatId]);

  useEffect(() => {
    if (
      !hasOlderMessages ||
      !loadOlderMessages ||
      !chatContainerRef?.current ||
      !loadMoreSentinelRef.current
    )
      return;
    const container = chatContainerRef.current;
    const sentinel = loadMoreSentinelRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (!entry?.isIntersecting || isStreaming) return;
        void handleLoadOlder();
      },
      { root: container, rootMargin: '150px 0px 0px 0px', threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasOlderMessages, loadOlderMessages, chatContainerRef, isStreaming, handleLoadOlder]);

  return (
    <>
      {hasOlderMessages && (
        <div
          ref={loadMoreSentinelRef}
          data-load-more-sentinel
          className="min-h-px w-full"
          aria-hidden
        />
      )}
      {isLoadingOlderMessages && (
        <div
          className="flex w-full items-center justify-center py-2 text-muted-foreground text-sm"
          aria-live="polite"
        >
          Loading older messages…
        </div>
      )}
      {loadOlderError && (
        <div
          className="flex w-full items-center justify-center gap-2 py-2 text-muted-foreground text-sm"
          role="alert"
        >
          <span>Couldn&apos;t load older messages.</span>
          {loadOlderMessages && (
            <Button
              variant="link"
              size="sm"
              onClick={() => void handleLoadOlder()}
              className="h-auto p-0 text-primary hover:underline"
            >
              Retry
            </Button>
          )}
        </div>
      )}
      {userMsgIds.map((userMsgId) => (
        <IsolatedMessageGroup
          key={userMsgId}
          userMsgId={userMsgId}
          subChatId={subChatId}
          chatId={chatId}
          taskId={taskId}
          isMobile={isMobile}
          sandboxSetupStatus={sandboxSetupStatus}
          stickyTopClass={stickyTopClass}
          sandboxSetupError={sandboxSetupError}
          onRetrySetup={onRetrySetup}
          UserBubbleComponent={UserBubbleComponent}
          ToolCallComponent={ToolCallComponent}
          MessageGroupWrapper={MessageGroupWrapper}
          toolRegistry={toolRegistry}
          showChatRetryControl={showChatRetryControl}
          retryInFlight={retryInFlight}
          onRetryChat={onRetryChat}
          onCarryOnChat={onCarryOnChat}
          chatRetryTooltipText={chatRetryTooltipText}
        />
      ))}
    </>
  );
}, areSectionPropsEqual);
