import { atom } from 'jotai';

type PaneHistory = Readonly<Record<string, readonly string[]>>;

/** Chats each split pane showed before clicks replaced them, oldest first. Keyed by the chat the
 *  pane shows now, so a pane's history moves with it when panes are swapped. */
export const paneHistoryAtom = atom<PaneHistory>({});

/** Drops the history of chats no longer shown in a pane; returns `history` itself when none go. */
export function pruneUnshownPaneHistory(
  history: PaneHistory,
  shownChatIds: readonly (string | null)[],
): PaneHistory {
  const kept = Object.keys(history).filter((chatId) => shownChatIds.includes(chatId));
  if (kept.length === Object.keys(history).length) return history;
  return Object.fromEntries(kept.map((chatId) => [chatId, history[chatId] ?? []]));
}
