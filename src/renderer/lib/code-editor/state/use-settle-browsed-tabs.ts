import { useSetAtom } from 'jotai';
import { useEffect, useRef } from 'react';
import { settleBrowsedTabsAtom } from './browsed-tabs';

/** The fields of a loaded chat that decide which of another project's tabs stay */
type SettleChat = {
  id: string;
  worktreePath?: string | null;
  project?: { path: string } | null;
};

type UseSettleBrowsedTabsInput = {
  /** The chat single view shows, once its data has loaded; null or undefined otherwise */
  chat: SettleChat | null | undefined;
  isSplitActive: boolean;
};

/**
 * Single view: settles another project's tabs whenever the chat or the folder it works in (its
 * worktree, else its project) changes, even when the project stays the same. Split view keeps
 * every pane's tabs, and so does the one pass that ends it, whether or not a chat has loaded, as
 * the project sync does.
 */
export function useSettleBrowsedTabs({ chat, isSplitActive }: UseSettleBrowsedTabsInput): void {
  const settle = useSetAtom(settleBrowsedTabsAtom);
  const wasSplitRef = useRef(isSplitActive);
  const chatId = chat?.id ?? null;
  const mainProjectPath = chat?.worktreePath ?? chat?.project?.path ?? null;

  useEffect(() => {
    const isSplitExit = wasSplitRef.current && !isSplitActive;
    wasSplitRef.current = isSplitActive;
    if (isSplitActive || isSplitExit || !chatId) return;
    settle({ chatId, mainProjectPath, keepProjectPaths: [] });
  }, [chatId, mainProjectPath, isSplitActive, settle]);
}
