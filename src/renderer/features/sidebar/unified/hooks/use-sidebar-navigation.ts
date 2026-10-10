/* eslint-disable max-lines, max-lines-per-function */
/**
 * Keyboard navigation for the unified sidebar tree.
 *
 * Attaches a keydown listener to the tree container ref:
 * - ArrowDown / ArrowUp: traverse visible sidebar items (codebases + chats)
 * - Enter: select focused chat (or toggle codebase expand/collapse)
 * - ArrowRight: expand codebase folder
 * - ArrowLeft: collapse codebase, or jump to parent codebase from a chat
 * - Escape: blur sidebar, return focus to chat input
 * - Home / End: jump to first / last visible item
 *
 * Performance: items are cached in a ref and invalidated via MutationObserver
 * (avoids querySelectorAll on every keystroke). The focus ring is applied
 * imperatively via classList, skipping React re-renders in child components.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { focusChatInput } from '@/lib/focus-chat-input';
import { scrollTreeItemIntoView } from '@/lib/tree-navigation';

type SidebarItemInfo = {
  id: string;
  type: 'codebase' | 'chat';
  element: HTMLElement;
};

type SidebarNavigationCallbacks = {
  /** Called when Enter is pressed on a chat item */
  onSelectChat: (chatId: string) => void;
  /** Called when Enter or ArrowRight is pressed on a codebase to expand it */
  onToggleCodebase: (codebaseKey: string) => void;
  /** Check if a codebase is currently expanded */
  isCodebaseExpanded: (codebaseKey: string) => boolean;
  /** Whether a drag-and-drop operation is in progress (suppresses keyboard nav) */
  isDragging?: boolean;
  /** Currently active chat ID — used to focus the active chat on Cmd+; instead of the first item */
  selectedChatId?: string | null;
  /** Esc / Delete while chats are multi-selected. Returns true when it consumed the key. */
  onSelectionKey?: (action: 'clear' | 'delete') => boolean;
};

const FOCUS_RING_CLASSES = ['ring-2', 'ring-ring/50'];

/**
 * Query all visible sidebar items from the DOM in document order.
 * Not merged with shared getVisibleTreeItems because sidebar items need the extra `type` field.
 */
/** The chat destination's surface, mounted for chat and Work Queue but never for Flows. */
const CHAT_SURFACE_SELECTOR = '[data-work-queue-return-target]';

export function getVisibleItems(container: HTMLElement): SidebarItemInfo[] {
  const elements = Array.from(container.querySelectorAll<HTMLElement>('[data-sidebar-item]'));
  const items: SidebarItemInfo[] = [];
  for (const el of elements) {
    const id = el.getAttribute('data-item-id');
    const type = el.getAttribute('data-item-type') as 'codebase' | 'chat';
    if (id && type) {
      items.push({ id, type, element: el });
    }
  }
  return items;
}

/**
 * Find the closest parent codebase item for a given item index.
 * Walks backwards through the items array to find the nearest codebase.
 */
function findParentCodebase(
  items: SidebarItemInfo[],
  currentIndex: number,
): SidebarItemInfo | null {
  for (let i = currentIndex - 1; i >= 0; i--) {
    if (items[i].type === 'codebase') {
      return items[i];
    }
  }
  return null;
}

export function useSidebarNavigation(
  containerRef: React.RefObject<HTMLDivElement | null>,
  callbacks: SidebarNavigationCallbacks,
) {
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
  // Keep a ref in sync so the keydown handler reads the latest value
  // without needing to be recreated on every focusedItemId change.
  const focusedItemIdRef = useRef(focusedItemId);
  focusedItemIdRef.current = focusedItemId;

  // Cached items list — invalidated by MutationObserver on DOM changes
  const cachedItemsRef = useRef<SidebarItemInfo[] | null>(null);

  // Ref to the previously focused element for imperative ring removal
  const prevFocusedElRef = useRef<HTMLElement | null>(null);

  const { onSelectChat, onToggleCodebase, isCodebaseExpanded, isDragging, selectedChatId } =
    callbacks;
  const onSelectionKeyRef = useRef(callbacks.onSelectionKey);
  onSelectionKeyRef.current = callbacks.onSelectionKey;

  /** Get items from cache or re-query the DOM. */
  const getItems = useCallback((): SidebarItemInfo[] => {
    const container = containerRef.current;
    if (!container) return [];
    if (!cachedItemsRef.current) {
      cachedItemsRef.current = getVisibleItems(container);
    }
    return cachedItemsRef.current;
  }, [containerRef]);

  // ── Imperative focus ring ──────────────────────────────────────────
  // Apply/remove ring classes directly on the DOM element to avoid
  // threading focusedItemId through props and causing React re-renders.
  useEffect(() => {
    // Remove ring from previous element
    if (prevFocusedElRef.current) {
      prevFocusedElRef.current.classList.remove(...FOCUS_RING_CLASSES);
      prevFocusedElRef.current = null;
    }

    // Apply ring to new element
    if (focusedItemId) {
      const container = containerRef.current;
      if (container) {
        const el = container.querySelector<HTMLElement>(
          `[data-item-id="${CSS.escape(focusedItemId)}"]`,
        );
        if (el) {
          el.classList.add(...FOCUS_RING_CLASSES);
          prevFocusedElRef.current = el;
        }
      }
    }

    // Cleanup on unmount
    return () => {
      if (prevFocusedElRef.current) {
        prevFocusedElRef.current.classList.remove(...FOCUS_RING_CLASSES);
        prevFocusedElRef.current = null;
      }
    };
  }, [focusedItemId, containerRef]);

  // Keep a ref so the focus handler reads the latest selectedChatId without re-registering.
  const selectedChatIdRef = useRef(selectedChatId);
  selectedChatIdRef.current = selectedChatId;

  // Highlight the active chat (or first visible item) on an explicit sidebar focus (Cmd+;). Not a
  // focus listener: dialogs restoring focus here after a delete must not scroll the tree.
  const focusActiveItem = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    container.focus();
    if (focusedItemIdRef.current) return;

    const items = getVisibleItems(container);
    if (items.length === 0) return;

    const activeId = selectedChatIdRef.current;
    const targetItem = (activeId && items.find((item) => item.id === activeId)) || items[0];
    setFocusedItemId(targetItem.id);
    scrollTreeItemIntoView(targetItem.element);
  }, [containerRef]);

  // Invalidate cached items and clear focusedItemId when DOM changes.
  // Only observes while keyboard nav is active (focusedItemId !== null) to reduce
  // background callback overhead when sidebar is idle.
  const isNavigating = focusedItemId !== null;
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isNavigating) return;

    // Invalidate cache when re-entering navigation mode (DOM may have changed while idle)
    cachedItemsRef.current = null;

    const observer = new MutationObserver(() => {
      // Invalidate cached items on any structural DOM change
      cachedItemsRef.current = null;

      const currentId = focusedItemIdRef.current;
      if (!currentId) return;
      if (!container.querySelector(`[data-item-id="${CSS.escape(currentId)}"]`)) {
        setFocusedItemId(null);
      }
    });

    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [containerRef, isNavigating]);

  // Clear focus when container loses focus
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleBlur = (e: FocusEvent) => {
      // Only clear if focus leaves the container entirely
      if (!container.contains(e.relatedTarget as Node)) {
        setFocusedItemId(null);
      }
    };

    container.addEventListener('focusout', handleBlur);
    return () => container.removeEventListener('focusout', handleBlur);
  }, [containerRef]);

  // Keep a ref so the keydown handler reads the latest value without recreating
  const isDraggingRef = useRef(isDragging);
  isDraggingRef.current = isDragging;

  // biome-ignore lint/correctness/useExhaustiveDependencies: containerRef is a stable ref, focusedItemIdRef avoids re-creating handler
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const container = containerRef.current;
      if (!container) return;

      // Suppress keyboard nav during drag-and-drop to avoid confusing focus moves
      if (isDraggingRef.current) return;

      // Don't handle if target is an input element (e.g. search)
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      const selectionAction =
        e.key === 'Escape'
          ? 'clear'
          : e.key === 'Delete' || e.key === 'Backspace'
            ? 'delete'
            : null;
      if (selectionAction && onSelectionKeyRef.current?.(selectionAction)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      const items = getItems();
      if (items.length === 0) return;

      const currentFocusId = focusedItemIdRef.current;
      const currentIndex = currentFocusId
        ? items.findIndex((item) => item.id === currentFocusId)
        : -1;

      /** Focus a sidebar item by index and scroll it into view. */
      const focusItemAt = (index: number) => {
        const item = items[index];
        if (!item) return;
        setFocusedItemId(item.id);
        scrollTreeItemIntoView(item.element);
      };

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          e.stopPropagation();
          if (currentIndex + 1 < items.length) {
            focusItemAt(currentIndex + 1);
          } else if (currentIndex === -1) {
            focusItemAt(0);
          }
          return;
        }

        case 'ArrowUp': {
          e.preventDefault();
          e.stopPropagation();
          if (currentIndex - 1 >= 0) {
            focusItemAt(currentIndex - 1);
          } else if (currentIndex === -1) {
            focusItemAt(items.length - 1);
          }
          return;
        }

        case 'Enter': {
          if (currentIndex === -1) return;
          e.preventDefault();
          e.stopPropagation();
          const item = items[currentIndex];
          if (item.type === 'chat') {
            onSelectChat(item.id);
          } else {
            onToggleCodebase(item.id);
          }
          return;
        }

        case 'ArrowRight': {
          if (currentIndex === -1) return;
          const item = items[currentIndex];
          if (item.type !== 'codebase') return;
          e.preventDefault();
          e.stopPropagation();
          if (!isCodebaseExpanded(item.id)) {
            onToggleCodebase(item.id);
          } else if (currentIndex + 1 < items.length) {
            focusItemAt(currentIndex + 1);
          }
          return;
        }

        case 'ArrowLeft': {
          if (currentIndex === -1) return;
          e.preventDefault();
          e.stopPropagation();
          const currentItem = items[currentIndex];
          if (currentItem.type === 'codebase' && isCodebaseExpanded(currentItem.id)) {
            onToggleCodebase(currentItem.id);
          } else {
            const parent = findParentCodebase(items, currentIndex);
            if (parent) {
              const parentIndex = items.indexOf(parent);
              focusItemAt(parentIndex);
            }
          }
          return;
        }

        case 'Home': {
          e.preventDefault();
          e.stopPropagation();
          focusItemAt(0);
          return;
        }

        case 'End': {
          e.preventDefault();
          e.stopPropagation();
          focusItemAt(items.length - 1);
          return;
        }

        case 'Escape': {
          e.preventDefault();
          e.stopPropagation();
          setFocusedItemId(null);
          // Hand focus back to the chat input, searching only the chat surface: an unscoped
          // lookup falls through to any <input> on screen, which on the Flows dashboard is the
          // flow-search box. Destinations that unmount that surface have no target at all, and
          // dropping focus to <body> would let the next Escape reach their own close handler — so
          // keep focus here instead.
          requestAnimationFrame(() => {
            const chatSurface = document.querySelector(CHAT_SURFACE_SELECTOR);
            if (chatSurface && focusChatInput(chatSurface)) container.blur();
          });
          return;
        }
      }
    },
    [onSelectChat, onToggleCodebase, isCodebaseExpanded, getItems],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('keydown', handleKeyDown);
    return () => container.removeEventListener('keydown', handleKeyDown);
  }, [containerRef, handleKeyDown]);

  return { focusedItemId, focusActiveItem };
}
