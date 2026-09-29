import { useAtom } from 'jotai';
import { AnimatePresence, motion } from 'motion/react';
import type { ReactElement } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { cn } from '../../../lib/utils';
import {
  DEFAULT_ANIMATION_DURATION,
  DEFAULT_MAX_WIDTH,
  DEFAULT_MIN_WIDTH,
  PANE_NARROW_PANEL_CLASS,
  PANE_NARROW_PANEL_MAX_MIN_WIDTH,
  PANE_WIDE_PANEL_CLASS,
} from './constants';
import { ResizableSidebarChrome } from './ResizableSidebarChrome';
import type { ResizableSidebarProps } from './types';
import { useAnimationLogic } from './useAnimationLogic';
import { useSidebarInteractions } from './useSidebarInteractions';
import { calculateExtendedHoverAreaStyle, calculateResizeHandleStyle } from './utils';

const PANE_PANEL_OPEN_EVENT = 'pane-panel-open';
const FOCUSABLE = 'input, textarea, select, button, [href], [tabindex]:not([tabindex="-1"])';

function isFocusLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

function focusFirstVisible(panel: HTMLElement): void {
  const target = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) =>
    el.checkVisibility?.(),
  );
  target?.focus({ preventScroll: true });
}

/** Compact comes from the CSS (the tier classes position the panel absolutely), never JS. */
function isCompactPanel(panel: HTMLElement): boolean {
  return getComputedStyle(panel).position === 'absolute';
}

/** A split pane shows at most one side panel. In a Compact pane the panel replaces the chat, so
 *  focus follows it in (on open, or when a resize hides the focused chat) and back on close. */
/** The panel currently marking each pane body open, so a closing panel never clears its successor. */
const paneBodyOwners = new WeakMap<HTMLElement, HTMLElement>();

function showOnePanelPerPane(
  panel: HTMLElement,
  tier: 'narrow' | 'wide',
  close: () => void,
): () => void {
  const paneBody = panel.closest<HTMLElement>('[data-pane-body]');
  if (!paneBody) return () => {};
  // Read before the style read below, which lets the browser blur the now-hidden chat.
  const returnFocusTo = document.activeElement;
  // Hides the chat behind a Compact panel (PANE_CHAT_BEHIND_PANEL_CLASS). An attribute, not
  // `:has()`: Chromium restyles the whole document for a non-subject `:has()` on every DOM change.
  paneBody.dataset.panePanelOpen = tier;
  paneBodyOwners.set(paneBody, panel);
  paneBody.dispatchEvent(new CustomEvent(PANE_PANEL_OPEN_EVENT, { detail: panel }));
  if (isCompactPanel(panel) && !panel.contains(returnFocusTo)) focusFirstVisible(panel);

  const closeWhenAnotherOpens = (event: Event): void => {
    if (event instanceof CustomEvent && event.detail !== panel) close();
  };
  // Only a blur caused by the chat being hidden, never one caused by clicking elsewhere.
  const followHiddenFocus = (event: Event): void => {
    const lost = event.target;
    if (!(event instanceof FocusEvent) || event.relatedTarget || !(lost instanceof Element)) return;
    requestAnimationFrame(() => {
      const hidden = lost.checkVisibility?.({ visibilityProperty: true }) === false;
      if (hidden && isFocusLost() && isCompactPanel(panel)) {
        focusFirstVisible(panel);
      }
    });
  };
  paneBody.addEventListener(PANE_PANEL_OPEN_EVENT, closeWhenAnotherOpens);
  paneBody.addEventListener('focusout', followHiddenFocus);
  return () => {
    paneBody.removeEventListener(PANE_PANEL_OPEN_EVENT, closeWhenAnotherOpens);
    paneBody.removeEventListener('focusout', followHiddenFocus);
    if (paneBodyOwners.get(paneBody) === panel) {
      paneBodyOwners.delete(paneBody);
      delete paneBody.dataset.panePanelOpen;
    }
    if (!(returnFocusTo instanceof HTMLElement) || !paneBody.contains(returnFocusTo)) return;
    // Whatever the tier was on open: the chat may stay hidden until the panel leaves the DOM,
    // so restore on the next frame, and only if focus was lost with the panel.
    requestAnimationFrame(() => {
      if (isFocusLost() || panel.contains(document.activeElement)) {
        returnFocusTo.focus({ preventScroll: true });
      }
    });
  };
}

export function ResizableSidebar({
  isOpen,
  onClose,
  widthAtom,
  minWidth = DEFAULT_MIN_WIDTH,
  maxWidth = DEFAULT_MAX_WIDTH,
  side,
  closeShortcutId,
  animationDuration = DEFAULT_ANIMATION_DURATION,
  children,
  className = '',
  initialWidth = 0,
  exitWidth = 0,
  dataAttributes,
  disableClickToClose = false,
  showResizeTooltip = false,
  style,
  preserveChildrenWhenClosed = false,
}: ResizableSidebarProps): ReactElement | null {
  const [sidebarWidth, setSidebarWidth] = useAtom(widthAtom);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  // Written after commit, not during render (same contract as useWindowEvent).
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const { shouldAnimate } = useAnimationLogic({
    isOpen,
    animationDuration,
  });

  const interactions = useSidebarInteractions({
    isOpen,
    sidebarWidth,
    setSidebarWidth,
    minWidth,
    maxWidth,
    side,
    disableClickToClose,
    onClose,
    sidebarRef,
  });

  const currentWidth = interactions.localWidth ?? sidebarWidth;

  const resizeHandleStyle = useMemo(() => calculateResizeHandleStyle(side), [side]);
  const extendedHoverAreaStyle = useMemo(() => calculateExtendedHoverAreaStyle(side), [side]);

  const dataProps = useMemo(
    () =>
      dataAttributes
        ? Object.fromEntries(
            Object.entries(dataAttributes).map(([key, value]) => [`data-${key}`, value]),
          )
        : {},
    [dataAttributes],
  );

  const paneTier = minWidth <= PANE_NARROW_PANEL_MAX_MIN_WIDTH ? 'narrow' : 'wide';
  const paneTierClass = paneTier === 'narrow' ? PANE_NARROW_PANEL_CLASS : PANE_WIDE_PANEL_CLASS;
  const collapsedPreserve = preserveChildrenWhenClosed && !isOpen;
  const effectiveMinWidth = collapsedPreserve ? 0 : minWidth;
  const chromeDisabled = collapsedPreserve;

  // Layout effect: it must see the chat's focus before the browser blurs the hidden chat.
  useLayoutEffect(() => {
    const panel = sidebarRef.current;
    if (!isOpen || !panel) return;
    return showOnePanelPerPane(panel, paneTier, () => onCloseRef.current?.());
  }, [isOpen, paneTier]);

  useLayoutEffect(() => {
    if (!preserveChildrenWhenClosed || isOpen) return;
    const root = sidebarRef.current;
    if (!root) return;
    const active = document.activeElement;
    if (active instanceof Node && root.contains(active) && active instanceof HTMLElement) {
      active.blur();
    }
  }, [isOpen, preserveChildrenWhenClosed]);

  const sidebarChrome = (
    <ResizableSidebarChrome
      interactions={interactions}
      side={side}
      closeShortcutId={closeShortcutId}
      disableClickToClose={disableClickToClose}
      showResizeTooltip={showResizeTooltip}
      chromeDisabled={chromeDisabled}
      extendedHoverAreaStyle={extendedHoverAreaStyle}
      resizeHandleStyle={resizeHandleStyle}
    >
      {children}
    </ResizableSidebarChrome>
  );

  if (preserveChildrenWhenClosed) {
    return (
      <motion.div
        ref={sidebarRef}
        initial={false}
        animate={{
          width: isOpen ? currentWidth : 0,
          opacity: isOpen ? 1 : 0,
        }}
        transition={{
          duration: interactions.isResizing ? 0 : animationDuration,
          ease: [0.4, 0, 0.2, 1],
        }}
        className={cn(
          'bg-transparent flex flex-col text-xs h-full relative',
          paneTierClass,
          className,
        )}
        style={{
          minWidth: effectiveMinWidth,
          overflow: 'hidden',
          ...style,
        }}
        inert={collapsedPreserve ? true : undefined}
        aria-hidden={collapsedPreserve ? true : undefined}
        data-pane-panel={isOpen ? paneTier : undefined}
        {...dataProps}
        data-testid="preserved-child-shell"
      >
        {sidebarChrome}
      </motion.div>
    );
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={sidebarRef}
          initial={
            !shouldAnimate
              ? {
                  width: currentWidth,
                  opacity: 1,
                }
              : {
                  width: initialWidth,
                  opacity: 0,
                }
          }
          animate={{
            width: currentWidth,
            opacity: 1,
          }}
          exit={{
            width: exitWidth,
            opacity: 0,
          }}
          transition={{
            duration: interactions.isResizing ? 0 : animationDuration,
            ease: [0.4, 0, 0.2, 1],
          }}
          className={cn(
            'bg-transparent flex flex-col text-xs h-full relative',
            paneTierClass,
            className,
          )}
          style={{ minWidth, overflow: 'hidden', ...style }}
          data-pane-panel={paneTier}
          {...dataProps}
        >
          {sidebarChrome}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
