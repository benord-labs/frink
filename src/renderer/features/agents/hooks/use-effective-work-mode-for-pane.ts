/**
 * Effective work mode for the current pane: global lastSelectedWorkModeAtom in single-pane,
 * per-pane map entry in split view.
 */

import { useAtom, useAtomValue } from 'jotai';
import { useCallback } from 'react';
import type { WorkMode } from '../atoms';
import {
  lastSelectedWorkModeAtom,
  newChatPaneWorkModeMapAtom,
  splitViewChatIdsAtom,
} from '../atoms';

export function useEffectiveWorkModeForPane(splitPaneIndex: number | undefined) {
  const [globalWorkMode, setGlobalWorkMode] = useAtom(lastSelectedWorkModeAtom);
  const [paneMap, setPaneMap] = useAtom(newChatPaneWorkModeMapAtom);
  const chatIds = useAtomValue(splitViewChatIdsAtom);
  const isSplitActive = chatIds.length >= 2;

  const workMode: WorkMode =
    splitPaneIndex !== undefined && isSplitActive && splitPaneIndex in paneMap
      ? paneMap[splitPaneIndex]
      : globalWorkMode;

  const setWorkMode = useCallback(
    (value: WorkMode) => {
      if (splitPaneIndex === undefined || !isSplitActive) {
        if (globalWorkMode === value) return;
        setGlobalWorkMode(value);
        return;
      }
      if (paneMap[splitPaneIndex] === value) return;
      setPaneMap((prev) => ({ ...prev, [splitPaneIndex]: value }));
    },
    [splitPaneIndex, isSplitActive, globalWorkMode, paneMap, setGlobalWorkMode, setPaneMap],
  );

  return { workMode, setWorkMode };
}
