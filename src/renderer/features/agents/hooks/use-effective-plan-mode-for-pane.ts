/**
 * Effective chat mode for the current pane: global chatModeAtom in single-pane,
 * per-pane map entry in split view.
 */

import type { Getter } from 'jotai';
import { useAtom, useAtomValue, useStore } from 'jotai';
import { useCallback, useMemo } from 'react';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import { chatModeAtom, newChatPaneChatModeMapAtom, splitViewChatIdsAtom } from '../atoms';

/** Single read rule for both `useEffectiveChatModeForPane` and `getEffectiveChatModeForPane`. */
export function resolveEffectiveChatMode(
  paneIndex: number | null,
  isSplitActive: boolean,
  globalChatMode: ChatMode,
  paneMap: Record<number, ChatMode>,
): ChatMode {
  if (paneIndex === null) return globalChatMode;
  if (!isSplitActive) return globalChatMode;
  if (paneIndex in paneMap) return paneMap[paneIndex];
  return globalChatMode;
}

/**
 * Imperative read: use inside callbacks or non-React code with a Jotai `Getter`.
 * The hook uses the same rule via `resolveEffectiveChatMode` on subscribed atom values.
 */
export function getEffectiveChatModeForPane(get: Getter, paneIndex: number | null): ChatMode {
  const globalChatMode = get(chatModeAtom);
  if (paneIndex === null) return globalChatMode;
  const chatIds = get(splitViewChatIdsAtom);
  const isSplitActive = chatIds.length >= 2;
  const paneMap = get(newChatPaneChatModeMapAtom);
  return resolveEffectiveChatMode(paneIndex, isSplitActive, globalChatMode, paneMap);
}

export const CHAT_MODE_CYCLE: ChatMode[] = ['agent', 'plan', 'debug'];

export type UseEffectiveChatModeForPaneOptions = {
  /** When false, Shift+Tab cycle omits `debug` (matches chat-input without `projectId`). */
  hasProject: boolean;
};

export function useEffectiveChatModeForPane(
  splitPaneIndex: number | undefined,
  options: UseEffectiveChatModeForPaneOptions,
) {
  const store = useStore();
  const [globalChatMode, setGlobalChatMode] = useAtom(chatModeAtom);
  const [paneMap, setPaneMap] = useAtom(newChatPaneChatModeMapAtom);
  const chatIds = useAtomValue(splitViewChatIdsAtom);
  const isSplitActive = chatIds.length >= 2;

  const paneIndexForRead = splitPaneIndex === undefined ? null : splitPaneIndex;
  // Derive from subscribed atoms so the label always matches store state (avoids stale render).
  const chatMode = useMemo(
    () => resolveEffectiveChatMode(paneIndexForRead, isSplitActive, globalChatMode, paneMap),
    [paneIndexForRead, isSplitActive, globalChatMode, paneMap],
  );

  const setChatMode = useCallback(
    (value: ChatMode) => {
      if (splitPaneIndex === undefined || !isSplitActive) {
        if (globalChatMode === value) return;
        setGlobalChatMode(value);
        return;
      }
      if (paneMap[splitPaneIndex] === value) return;
      setPaneMap((prev) => ({ ...prev, [splitPaneIndex]: value }));
    },
    [splitPaneIndex, isSplitActive, globalChatMode, paneMap, setGlobalChatMode, setPaneMap],
  );

  /** Cycles modes; omits `debug` when `hasProject` is false (avoids stale closure via store.get). */
  const { hasProject } = options;
  const cycleChatMode = useCallback(() => {
    const cycle = hasProject ? CHAT_MODE_CYCLE : CHAT_MODE_CYCLE.filter((m) => m !== 'debug');
    const current = getEffectiveChatModeForPane(store.get, paneIndexForRead);
    const idx = cycle.indexOf(current);
    const safeIdx = idx >= 0 ? idx : 0;
    const next = cycle[(safeIdx + 1) % cycle.length];
    setChatMode(next);
  }, [store, paneIndexForRead, setChatMode, hasProject]);

  return { chatMode, setChatMode, cycleChatMode };
}
