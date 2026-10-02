/* eslint-disable max-lines, max-lines-per-function */
/**
 * Split view write actions only — does not subscribe to `splitViewAtom` (no re-render on layout/ratios).
 */
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback } from 'react';
import {
  addPaneRatio,
  getDefaultGridRatios,
  getDefaultLayout,
  getDefaultRatios,
  getNextLayout,
  getValidLayouts,
  isFillablePane,
  NEW_CHAT_PANE,
  removePaneRatio,
  type SplitLayout,
  type SplitViewState,
  selectedAgentChatIdAtom,
  splitViewAtom,
  swapAllPaneStateAtom,
} from '../atoms';
import { adjustActivePaneSplitRatios } from './split-view-active-pane-resize';

export const MAX_PANES = 4;

/** Whether an existing chat can open in a new pane: there's room for one, or a fillable placeholder
 *  (empty / new-chat) is waiting that it can drop into without exceeding MAX_PANES. Single source of
 *  truth for `openChatInNewPane`'s capability so the menu gate and the action never disagree. */
export function canOpenChatInNewPane(chatIds: (string | null)[]): boolean {
  return chatIds.length < MAX_PANES || chatIds.some(isFillablePane);
}

const PANE_ZOOM_STEP = 0.1;
const PANE_ZOOM_MIN = 0.5;
const PANE_ZOOM_MAX = 2;

function isGridLayout(layout: SplitLayout): boolean {
  return layout === 'three-bottom' || layout === 'three-right' || layout === 'grid';
}

/**
 * Build the next split state with `value` appended as a new focused pane. `value` is the cell to
 * append (a chatId, a `null` placeholder, or `NEW_CHAT_PANE`); `firstPaneChatId` seeds pane 0 when
 * starting a fresh split from no panes. Callers guard MAX_PANES / placeholder rules beforehand.
 */
function appendPane(
  prev: SplitViewState,
  value: string | null,
  firstPaneChatId: string | null,
): SplitViewState {
  if (prev.chatIds.length === 0) {
    return {
      chatIds: [firstPaneChatId, value],
      ratios: getDefaultRatios(2),
      activePaneIndex: 1, // focus the new pane
      layout: getDefaultLayout(2),
      paneZoomFactors: [1, 1],
    };
  }

  const newCount = prev.chatIds.length + 1;
  // Preserve the current layout if it's still valid for the new pane count; only fall back to the
  // default when there's no equivalent (e.g. 3-pane tile layouts have no 4-pane form). Mirrors
  // removeFromSplit's preserve-if-valid behaviour so add/remove stay symmetric.
  const validLayouts = getValidLayouts(newCount);
  const nextLayout = validLayouts.includes(prev.layout) ? prev.layout : getDefaultLayout(newCount);
  const baseZooms = prev.paneZoomFactors ?? prev.chatIds.map(() => 1);
  return {
    chatIds: [...prev.chatIds, value],
    ratios: addPaneRatio(
      prev.ratios.length === prev.chatIds.length
        ? prev.ratios
        : getDefaultRatios(prev.chatIds.length),
    ),
    activePaneIndex: prev.chatIds.length, // focus the new pane
    layout: nextLayout,
    gridRatios: isGridLayout(nextLayout) ? getDefaultGridRatios() : prev.gridRatios,
    paneZoomFactors: [...baseZooms, 1],
  };
}

export function useSplitViewActions() {
  const setSplitView = useSetAtom(splitViewAtom);
  const selectedChatId = useAtomValue(selectedAgentChatIdAtom);
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom);

  const addPane = useCallback(
    (asNewChat = false) => {
      const sentinel = asNewChat ? NEW_CHAT_PANE : null;

      setSplitView((prev: SplitViewState) => {
        // Block if there's already an unfilled empty placeholder (null).
        // NEW_CHAT_PANE panes are considered "active" and don't block.
        if (prev.chatIds.includes(null)) return prev;

        // Starting a split: use null (not NEW_CHAT_PANE) for the new pane when no chat is selected
        // yet so Pane 0 shows the non-interactive empty placeholder while a chat creation is in flight.
        if (prev.chatIds.length === 0) {
          return appendPane(
            prev,
            selectedChatId !== null ? sentinel : null,
            selectedChatId ?? null,
          );
        }

        if (prev.chatIds.length >= MAX_PANES) return prev;
        return appendPane(prev, sentinel, selectedChatId ?? null);
      });
    },
    [setSplitView, selectedChatId],
  );

  /** Open an existing chat in a new pane: focus it if already shown, fill a waiting placeholder,
   *  else append a pane (starting a 2-pane split from the current chat when none exists yet). */
  const openChatInNewPane = useCallback(
    (chatId: string) => {
      setSplitView((prev: SplitViewState) => {
        // Already in a pane → just focus it.
        const existingIdx = prev.chatIds.indexOf(chatId);
        if (existingIdx !== -1) {
          return existingIdx === prev.activePaneIndex
            ? prev
            : { ...prev, activePaneIndex: existingIdx };
        }

        // Single view already shows this chat (pane 0 is the implicit selected chat, and chatIds is
        // empty so the indexOf dedup above can't see it) → opening it beside itself would duplicate
        // it. No-op, consistent with the dedup-focus path.
        if (prev.chatIds.length === 0 && chatId === selectedChatId) return prev;

        // A fillable placeholder is waiting → fill it (valid even at MAX) rather than growing past it.
        const emptyIdx = prev.chatIds.findIndex(isFillablePane);
        if (emptyIdx !== -1) {
          const newChatIds = [...prev.chatIds];
          newChatIds[emptyIdx] = chatId;
          return { ...prev, chatIds: newChatIds, activePaneIndex: emptyIdx };
        }

        // Full → no-op (the menu item is disabled in this state).
        if (prev.chatIds.length >= MAX_PANES) return prev;
        return appendPane(prev, chatId, selectedChatId ?? null);
      });
    },
    [setSplitView, selectedChatId],
  );

  /** Add an empty placeholder pane (inactive state - "select a chat"). Used by the split pane button. */
  const addEmptyPane = useCallback(() => addPane(false), [addPane]);

  /** Add a new-chat pane (active state - NewChatForm). Used by "New Pane" in the New Chat dropdown. */
  const addNewChatPane = useCallback(() => addPane(true), [addPane]);

  /** Show a chat in the active pane, replacing whatever it holds — even when another pane is an
   *  empty / new-chat placeholder. A chat already open in some pane is focused, not duplicated. */
  const fillActivePane = useCallback(
    (chatId: string) => {
      setSplitView((prev: SplitViewState) => {
        const existingIdx = prev.chatIds.indexOf(chatId);
        if (existingIdx !== -1) {
          return existingIdx === prev.activePaneIndex
            ? prev
            : { ...prev, activePaneIndex: existingIdx };
        }

        const activeIdx = prev.activePaneIndex;
        if (activeIdx >= 0 && activeIdx < prev.chatIds.length) {
          const newChatIds = [...prev.chatIds];
          newChatIds[activeIdx] = chatId;
          return { ...prev, chatIds: newChatIds };
        }

        return prev;
      });
    },
    [setSplitView],
  );

  /** Set which pane is active (receives sidebar clicks). */
  const setActivePaneIndex = useCallback(
    (index: number) => {
      setSplitView((prev: SplitViewState) => {
        if (index < 0 || index >= prev.chatIds.length) return prev;
        if (index === prev.activePaneIndex) return prev;
        return { ...prev, activePaneIndex: index };
      });
    },
    [setSplitView],
  );

  /** Remove a single pane. If only 1 remains, exits split mode. */
  const removeFromSplit = useCallback(
    (_paneId: string | null, paneIndex: number) => {
      setSplitView((prev: SplitViewState) => {
        if (paneIndex < 0 || paneIndex >= prev.chatIds.length) return prev;

        const newChatIds = prev.chatIds.filter((_, i) => i !== paneIndex);
        const newRatios = removePaneRatio(prev.ratios, paneIndex);

        if (newChatIds.length < 2) {
          // Exit split, keep remaining real chat as selected
          const remaining = newChatIds[0];
          if (remaining && remaining !== NEW_CHAT_PANE) {
            setSelectedChatId(remaining);
          } else {
            setSelectedChatId(null); // No real chat — show NewChatForm
          }
          return { chatIds: [], ratios: [], activePaneIndex: 0, layout: prev.layout };
        }

        // Adjust activePaneIndex if needed
        let newActiveIndex = prev.activePaneIndex;
        if (paneIndex <= newActiveIndex) {
          newActiveIndex = Math.max(0, newActiveIndex - 1);
        }
        newActiveIndex = Math.min(newActiveIndex, newChatIds.length - 1);

        const newPaneZoomFactors =
          prev.paneZoomFactors && prev.paneZoomFactors.length === prev.chatIds.length
            ? prev.paneZoomFactors.filter((_, i) => i !== paneIndex)
            : undefined;

        // Auto-adjust layout for the new pane count
        const validLayouts = getValidLayouts(newChatIds.length);
        const newLayout = validLayouts.includes(prev.layout)
          ? prev.layout
          : getDefaultLayout(newChatIds.length);

        return {
          chatIds: newChatIds,
          ratios: newRatios,
          activePaneIndex: newActiveIndex,
          layout: newLayout,
          paneZoomFactors: newPaneZoomFactors,
        };
      });
    },
    [setSplitView, setSelectedChatId],
  );

  /** Clear a specific pane's chat by index (set to null), showing the empty placeholder.
   *  Also sets activePaneIndex to the cleared pane so that the next sidebar click fills it. */
  const clearPaneAt = useCallback(
    (index: number) => {
      setSplitView((prev: SplitViewState) => {
        if (index < 0 || index >= prev.chatIds.length) return prev;
        if (prev.chatIds[index] === null) return prev;
        const newChatIds = [...prev.chatIds];
        newChatIds[index] = null;
        return { ...prev, chatIds: newChatIds, activePaneIndex: index };
      });
    },
    [setSplitView],
  );

  /** Restore a failed deletion only if the user has not reused the cleared pane. */
  const restorePaneAt = useCallback(
    (index: number, chatId: string) => {
      setSplitView((prev: SplitViewState) => {
        if (index < 0 || index >= prev.chatIds.length || prev.chatIds[index] !== null) return prev;
        if (prev.chatIds.includes(chatId)) return prev;
        const newChatIds = [...prev.chatIds];
        newChatIds[index] = chatId;
        return { ...prev, chatIds: newChatIds, activePaneIndex: index };
      });
    },
    [setSplitView],
  );

  /** Replace a specific pane with the new-chat form (set to NEW_CHAT_PANE).
   *  Unlike clearPaneAt (which shows the empty placeholder), this goes straight to NewChatForm. */
  const newChatAtPane = useCallback(
    (index: number) => {
      setSplitView((prev: SplitViewState) => {
        if (index < 0 || index >= prev.chatIds.length) return prev;
        const newChatIds = [...prev.chatIds];
        newChatIds[index] = NEW_CHAT_PANE;
        return { ...prev, chatIds: newChatIds, activePaneIndex: index };
      });
    },
    [setSplitView],
  );

  /** Close all splits, revert to single view with the first pane's chat selected. */
  const closeSplit = useCallback(() => {
    setSplitView((prev: SplitViewState) => {
      if (prev.chatIds.length === 0) {
        return prev;
      }

      const focusedPaneChatId = prev.chatIds[prev.activePaneIndex];
      if (focusedPaneChatId && focusedPaneChatId !== NEW_CHAT_PANE) {
        setSelectedChatId(focusedPaneChatId);
      } else {
        const first = prev.chatIds.find((id) => id !== null && id !== NEW_CHAT_PANE);
        if (first) {
          setSelectedChatId(first);
        } else {
          setSelectedChatId(null); // No real chat — show NewChatForm
        }
      }
      return { chatIds: [], ratios: [], activePaneIndex: 0, layout: prev.layout };
    });
  }, [setSplitView, setSelectedChatId]);

  /** Update pane size ratios during/after resize (linear layouts: 2+ panes). */
  const setRatios = useCallback(
    (ratios: number[]) => {
      setSplitView((prev: SplitViewState) => ({ ...prev, ratios }));
    },
    [setSplitView],
  );

  /** Swap two panes by index. Atomically remaps all pane-index-dependent state
   *  (chatIds, ratios, activePaneIndex, file trees, last-active tabs, editor tab associations). */
  const swapAll = useSetAtom(swapAllPaneStateAtom);
  const swapPanes = useCallback(
    (fromIndex: number, toIndex: number) => swapAll({ from: fromIndex, to: toIndex }),
    [swapAll],
  );

  /** Cycle through valid layouts for the current pane count. */
  const cycleLayout = useCallback(() => {
    setSplitView((prev: SplitViewState) => {
      const n = prev.chatIds.length;
      const nextLayout = getNextLayout(prev.layout, n);
      if (nextLayout === prev.layout) return prev;
      return {
        ...prev,
        layout: nextLayout,
        ratios: getDefaultRatios(n),
        gridRatios: isGridLayout(nextLayout) ? getDefaultGridRatios() : prev.gridRatios,
      };
    });
  }, [setSplitView]);

  /** Update grid row/column ratios (for 3/4-pane resizable grid). */
  const setGridRatios = useCallback(
    (rows: number[], cols: number[]) => {
      setSplitView((prev: SplitViewState) => ({ ...prev, gridRatios: { rows, cols } }));
    },
    [setSplitView],
  );
  const resetPaneSizes = useCallback(() => {
    setSplitView((prev: SplitViewState) => {
      if (prev.chatIds.length < 2) return prev;
      const n = prev.chatIds.length;
      return {
        ...prev,
        ratios: getDefaultRatios(n),
        gridRatios: isGridLayout(prev.layout) ? getDefaultGridRatios() : prev.gridRatios,
        paneZoomFactors: prev.chatIds.map(() => 1),
      };
    });
  }, [setSplitView]);

  /** Zoom in the active pane only (per-pane scale). */
  const zoomPaneIn = useCallback(() => {
    setSplitView((prev: SplitViewState) => {
      if (prev.chatIds.length < 2) return prev;
      const zooms = prev.paneZoomFactors ?? prev.chatIds.map(() => 1);
      if (zooms.length !== prev.chatIds.length) return prev;
      const active = prev.activePaneIndex;
      const next = [...zooms];
      const v = Math.min(PANE_ZOOM_MAX, (next[active] ?? 1) + PANE_ZOOM_STEP);
      next[active] = v;
      return { ...prev, paneZoomFactors: next };
    });
  }, [setSplitView]);

  /** Zoom out the active pane only. */
  const zoomPaneOut = useCallback(() => {
    setSplitView((prev: SplitViewState) => {
      if (prev.chatIds.length < 2) return prev;
      const zooms = prev.paneZoomFactors ?? prev.chatIds.map(() => 1);
      if (zooms.length !== prev.chatIds.length) return prev;
      const active = prev.activePaneIndex;
      const next = [...zooms];
      const v = Math.max(PANE_ZOOM_MIN, (next[active] ?? 1) - PANE_ZOOM_STEP);
      next[active] = v;
      return { ...prev, paneZoomFactors: next };
    });
  }, [setSplitView]);

  /** Reset all pane zoom factors to 1x. */
  const resetPaneZoom = useCallback(() => {
    setSplitView((prev: SplitViewState) => {
      if (prev.chatIds.length < 2) return prev;
      return { ...prev, paneZoomFactors: prev.chatIds.map(() => 1) };
    });
  }, [setSplitView]);

  /** Reset zoom of a single pane to 1x. */
  const resetPaneZoomAt = useCallback(
    (paneIndex: number) => {
      setSplitView((prev: SplitViewState) => {
        if (prev.chatIds.length < 2 || paneIndex < 0 || paneIndex >= prev.chatIds.length)
          return prev;
        const zooms = prev.paneZoomFactors ?? prev.chatIds.map(() => 1);
        if (zooms.length !== prev.chatIds.length) return prev;
        const next = [...zooms];
        next[paneIndex] = 1;
        return { ...prev, paneZoomFactors: next };
      });
    },
    [setSplitView],
  );

  const growActivePane = useCallback(() => {
    setSplitView((prev: SplitViewState) => adjustActivePaneSplitRatios(prev, 'grow'));
  }, [setSplitView]);

  const shrinkActivePane = useCallback(() => {
    setSplitView((prev: SplitViewState) => adjustActivePaneSplitRatios(prev, 'shrink'));
  }, [setSplitView]);

  return {
    addEmptyPane,
    addNewChatPane,
    openChatInNewPane,
    fillActivePane,
    setActivePaneIndex,
    removeFromSplit,
    clearPaneAt,
    restorePaneAt,
    newChatAtPane,
    closeSplit,
    setRatios,
    swapPanes,
    cycleLayout,
    setGridRatios,
    resetPaneSizes,
    zoomPaneIn,
    zoomPaneOut,
    resetPaneZoom,
    resetPaneZoomAt,
    growActivePane,
    shrinkActivePane,
  };
}
