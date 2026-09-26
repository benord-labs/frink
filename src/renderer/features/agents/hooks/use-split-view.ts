/**
 * Hook for managing top-level chat split view state.
 * Operates on chat IDs from the unified sidebar (not sub-chats).
 *
 * Flow:
 * 1. User clicks [+] split button → addEmptyPane() creates a null slot
 * 2. Empty pane shows placeholder "Load a project to start chatting"
 * 3. User clicks a chat in sidebar → fillActivePane(chatId) fills the null slot
 * 4. Clicking a pane sets it as active via setActivePaneIndex()
 */

import { useAtomValue } from 'jotai';
import { useMemo } from 'react';
import {
  getDefaultGridRatios,
  getValidLayouts,
  NEW_CHAT_PANE,
  type SplitViewState,
  splitViewActivePaneIndexAtom,
  splitViewChatIdsAtom,
  splitViewGridRatiosAtom,
  splitViewHasNonDefaultPaneSizing,
  splitViewHasNonDefaultPaneZoom,
  splitViewLayoutAtom,
  splitViewPaneZoomFactorsAtom,
  splitViewRatiosAtom,
} from '../atoms';
import { canOpenChatInNewPane, useSplitViewActions } from './use-split-view-actions';

export { canOpenChatInNewPane, MAX_PANES, useSplitViewActions } from './use-split-view-actions';

export function useSplitView() {
  const actions = useSplitViewActions();
  const chatIds = useAtomValue(splitViewChatIdsAtom);
  const activePaneIndex = useAtomValue(splitViewActivePaneIndexAtom);
  const layout = useAtomValue(splitViewLayoutAtom);
  const ratios = useAtomValue(splitViewRatiosAtom);
  const gridRatios = useAtomValue(splitViewGridRatiosAtom);
  const paneZoomFactors = useAtomValue(splitViewPaneZoomFactorsAtom);

  const splitView = useMemo(
    (): SplitViewState => ({
      chatIds,
      activePaneIndex,
      layout,
      ratios,
      gridRatios,
      paneZoomFactors,
    }),
    [chatIds, activePaneIndex, layout, ratios, gridRatios, paneZoomFactors],
  );

  const isSplitActive = chatIds.length >= 2;
  const hasEmptyPane = chatIds.includes(null);
  const paneCount = chatIds.length;
  const canOpenInNewPane = canOpenChatInNewPane(chatIds);

  const canCycleLayout = useMemo(() => getValidLayouts(paneCount).length > 1, [paneCount]);

  const chatPaneMap = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < chatIds.length; i++) {
      const id = chatIds[i];
      if (id !== null && id !== NEW_CHAT_PANE) {
        map.set(id, i + 1);
      }
    }
    return map;
  }, [chatIds]);

  const gridRatiosForUi = gridRatios ?? getDefaultGridRatios();

  const hasNonDefaultPaneSizes = useMemo(
    () => splitViewHasNonDefaultPaneSizing(splitView),
    [splitView],
  );
  const hasNonDefaultPaneZoom = useMemo(
    () => splitViewHasNonDefaultPaneZoom(splitView),
    [splitView],
  );

  return {
    splitView,
    isSplitActive,
    hasEmptyPane,
    canOpenInNewPane,
    activePaneIndex,
    paneCount,
    layout,
    canCycleLayout,
    chatPaneMap,
    gridRatios: gridRatiosForUi,
    hasNonDefaultPaneSizes,
    hasNonDefaultPaneZoom,
    ...actions,
  };
}
