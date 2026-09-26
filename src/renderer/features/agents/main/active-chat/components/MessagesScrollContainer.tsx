import type { ReactElement, ReactNode } from 'react';
import { memo, useCallback, useLayoutEffect, useRef } from 'react';
import type { StickToBottomInstance } from 'use-stick-to-bottom';
import { FlowTriggerCardFallback } from './FlowTriggerCardFallback';

type Props = {
  /** The chat's single scroll owner, created by useStickToBottom in ChatViewInner. */
  instance: StickToBottomInstance;
  /** True when this sub-chat is the one its pane is showing. Drives the re-pin below. */
  isActive: boolean;
  /** Populated with the scroll viewport on attach, for consumers that only read the element. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** This sub-chat's id — constant for the component's lifetime (see the note below). */
  subChatId: string;
  /** The chat's pinned task, threaded to the trigger-card fallback (its query key). */
  pinnedTaskId: string | null;
  children: ReactNode;
};

/**
 * MessagesScrollContainer — owns the chat's scroll viewport and its content column.
 *
 * Scroll strategy: exactly one owner. `useStickToBottom` follows the bottom by observing the
 * CONTENT element's height and refuses to treat a resize-induced scroll as user intent — the
 * property that makes it safe under `content-visibility: auto` message groups, whose reported
 * height changes as groups are laid out. Nothing here infers user intent from scrollTop deltas.
 *
 * LIFETIME: there is one of these per sub-chat, not one per pane. ChatTabsRenderer keys each
 * ChatViewInner by subChatId, so switching sub-chat unmounts this component and remounts a fresh
 * one whose scroll state starts at the bottom. `subChatId` therefore never changes underneath us,
 * and no effect here needs to react to it — a switch cannot carry the previous sub-chat's scroll
 * position across, because it cannot reuse this instance.
 */
export const MessagesScrollContainer = memo(function MessagesScrollContainer({
  instance,
  isActive,
  containerRef,
  subChatId,
  pinnedTaskId,
  children,
}: Props): ReactElement {
  const heightObserverRef = useRef<ResizeObserver | null>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  // `instance` itself is a fresh object literal every render; its members are not. `state` is a
  // useMemo([]) and both refs are useCallback([]), so destructuring here gives the hooks below
  // genuinely stable dependencies — depending on `instance` would re-run them on every render.
  const { state, scrollRef, contentRef } = instance;

  /**
   * Re-pin to the bottom, but only when the viewport was already following it — a user who
   * scrolled up is never yanked back down.
   *
   * Writes through `state.scrollTop` rather than the element: that setter records
   * `ignoreScrollToTop`, so the scroll event this produces is not mistaken for a user scroll.
   */
  const pinToBottom = useCallback(() => {
    if (!state.isAtBottom) return;
    state.scrollTop = state.targetScrollTop;
  }, [state]);

  /**
   * The scroll element needs two things: the hook's scrollRef, and a ResizeObserver publishing
   * its height as `--chat-container-height` (read by the last message group's min-height).
   *
   * That observer also closes a gap in the hook: it observes only the content element, so a
   * change to the VIEWPORT's height that leaves content height untouched — dragging a split
   * divider on a long chat — records no resize, and the browser's downward scrollTop clamp is
   * then read as the user scrolling up, silently ending auto-scroll. Re-pinning here supplies
   * the missing signal.
   *
   * Both dependencies are stable, so this runs on mount/unmount only. An unstable callback would
   * run null→element on every render, cancelling in-flight animations and tearing the observer
   * down mid-load.
   */
  const attachContainer = useCallback(
    (el: HTMLElement | null) => {
      scrollRef(el);
      containerRef.current = el;

      heightObserverRef.current?.disconnect();
      heightObserverRef.current = null;
      if (!el) return;

      // Pin on every delivery, the first included: the layout-effect pin below runs before ChatDock
      // writes its reserve, so the first delivery is what lifts the last message above the stack.
      const observer = new ResizeObserver((entries) => {
        const height = entries[0]?.contentRect.height ?? 0;
        el.style.setProperty('--chat-container-height', `${height}px`);
        pinToBottom();
      });
      observer.observe(el);
      heightObserverRef.current = observer;
    },
    [scrollRef, containerRef, pinToBottom],
  );

  // Land at the bottom before paint on mount, and again when this sub-chat becomes the visible one
  // in its pane. On mount the hook's scroll state is fresh (at-bottom), so this is the initial pin;
  // the hook's own `initial` pass runs from its first ResizeObserver callback, which awaits a frame,
  // so without this the first painted frame shows the top of the thread.
  useLayoutEffect(() => {
    if (!isActive) return;
    pinToBottom();
  }, [isActive, pinToBottom]);

  // The column's bottom padding is ChatDock's reserve. Its change reaches this observer in the
  // frame it is written; the hook follows a frame later, once a grown stack hides the last message.
  useLayoutEffect(() => {
    const column = columnRef.current;
    if (!column) return;
    let reserve: number | undefined;
    const observer = new ResizeObserver(([entry]) => {
      const padding = Math.round(
        entry.borderBoxSize[0].blockSize - entry.contentBoxSize[0].blockSize,
      );
      // Growth under an unchanged reserve is new output: leave it to the hook's animated follow.
      if (padding === reserve) return;
      reserve = padding;
      // A press in the thread may be a drag-selection, which the hook's follow waits out.
      if (scrollRef.current?.matches(':active')) return;
      pinToBottom();
    });
    observer.observe(column, { box: 'border-box' });
    return () => observer.disconnect();
  }, [scrollRef, pinToBottom]);

  return (
    <div
      ref={attachContainer}
      // `overscroll-y-contain` suppresses macOS rubber-band bounce, whose negative wheel deltas
      // the hook would read as a deliberate scroll up.
      //
      // Keep `overflow-y-auto` as the only overflow class. The hook's wheel handler walks up from
      // the event target and requires the first ancestor whose computed `overflow` SHORTHAND is
      // "auto"/"scroll" to be this element. Adding e.g. `overflow-x-hidden` makes the shorthand
      // "hidden auto", the walk overshoots to the pane's own scroller, and wheel-to-release
      // silently stops working.
      //
      // `z-0` keeps transcript z-indices (sticky headers) under ChatDock's stack. The scroll
      // padding keeps search jumps and keyboard focus clear of that stack.
      className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain w-full relative z-0 scroll-pb-(--chat-dock-height) allow-text-selection outline-hidden"
      tabIndex={-1}
      data-chat-container
    >
      {/* Same column as ChatInputArea: outer px-2, inner max-w-2xl (padding not on the capped box — avoids narrow thread vs composer). */}
      <div ref={contentRef} className="px-2 -mb-4">
        {/* The padding reserves ChatDock's stack plus a gap. Padding, not a spacer: message groups
            must stay the column's trailing children (MessageGroup). */}
        <div
          ref={columnRef}
          className="mx-auto w-full max-w-2xl space-y-4 pb-[calc(var(--chat-dock-height)+1.5rem)]"
        >
          {/* Failed-first-run safety net: a flow task that fails before its prompt is sent leaves
              the sub-chat with no persisted message. Render the trigger card from the task so the
              run is never a blank pane. Self-hides once a real message exists. */}
          <FlowTriggerCardFallback subChatId={subChatId} pinnedTaskId={pinnedTaskId} />
          {children}
        </div>
      </div>
    </div>
  );
});
