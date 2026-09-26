/**
 * Effective model id for new-chat: global lastSelectedModelIdAtom in single-pane,
 * per-pane map entry in split view.
 */

import type { Getter } from 'jotai';
import { useAtom, useAtomValue } from 'jotai';
import { useCallback, useMemo, useRef } from 'react';
import { lastSelectedModelIdAtom, newChatPaneModelMapAtom, splitViewChatIdsAtom } from '../atoms';

/** Shared read rule for `useEffectiveModelForPane` and `getEffectiveModelIdForPane`. */
function resolveEffectiveModelId(
  paneIndex: number | null,
  isSplitActive: boolean,
  globalModelId: string,
  paneMap: Record<number, string>,
): string {
  if (paneIndex === null) return globalModelId;
  if (!isSplitActive) return globalModelId;
  if (paneIndex in paneMap) return paneMap[paneIndex];
  return globalModelId;
}

/**
 * Imperative read: use inside callbacks or non-React code with a Jotai `Getter`.
 */
export function getEffectiveModelIdForPane(get: Getter, paneIndex: number | null): string {
  const globalModelId = get(lastSelectedModelIdAtom);
  if (paneIndex === null) return globalModelId;
  const chatIds = get(splitViewChatIdsAtom);
  const isSplitActive = chatIds.length >= 2;
  const paneMap = get(newChatPaneModelMapAtom);
  return resolveEffectiveModelId(paneIndex, isSplitActive, globalModelId, paneMap);
}

export function useEffectiveModelForPane(splitPaneIndex: number | undefined) {
  const [globalModelId, setGlobalModelId] = useAtom(lastSelectedModelIdAtom);
  const [paneMap, setPaneMap] = useAtom(newChatPaneModelMapAtom);
  const chatIds = useAtomValue(splitViewChatIdsAtom);
  const isSplitActive = chatIds.length >= 2;

  const paneIndexForRead = splitPaneIndex === undefined ? null : splitPaneIndex;
  const globalModelIdRef = useRef(globalModelId);
  const paneMapRef = useRef(paneMap);
  // Mirror atom values into refs each render so the stable setter below always compares
  // against the latest state (effect-only updates can lag one commit behind).
  globalModelIdRef.current = globalModelId;
  paneMapRef.current = paneMap;

  const lastSelectedModelId = useMemo(
    () => resolveEffectiveModelId(paneIndexForRead, isSplitActive, globalModelId, paneMap),
    [paneIndexForRead, isSplitActive, globalModelId, paneMap],
  );

  const setLastSelectedModelId = useCallback(
    (value: string) => {
      if (splitPaneIndex === undefined || !isSplitActive) {
        if (globalModelIdRef.current === value) return;
        setGlobalModelId(value);
        return;
      }
      if (paneMapRef.current[splitPaneIndex] === value) return;
      setPaneMap((prev) => ({ ...prev, [splitPaneIndex]: value }));
    },
    [splitPaneIndex, isSplitActive, setGlobalModelId, setPaneMap],
  );

  return { lastSelectedModelId, setLastSelectedModelId };
}
