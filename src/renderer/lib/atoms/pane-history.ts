import { atom } from 'jotai';

export type PaneNavDirection = 'back' | 'forward';

/** Chats a pane can step back or forward to; the nearest is last in each list. */
export type PaneHistoryEntry = { back: readonly string[]; forward: readonly string[] };

type PaneHistory = Readonly<Record<string, PaneHistoryEntry>>;

const MAX_PANE_HISTORY = 5;

/** Each split pane's Back/Forward history, keyed by the chat the pane shows now, so a pane's
 *  history moves with it when panes are swapped. */
export const paneHistoryAtom = atom<PaneHistory>({});

/** Drops the history of chats no longer shown in a pane; returns `history` itself when none go. */
export function pruneUnshownPaneHistory(
  history: PaneHistory,
  shownChatIds: readonly (string | null)[],
): PaneHistory {
  const kept = Object.keys(history).filter((chatId) => shownChatIds.includes(chatId));
  if (kept.length === Object.keys(history).length) return history;
  return Object.fromEntries(
    kept.flatMap((chatId) => (history[chatId] ? [[chatId, history[chatId]]] : [])),
  );
}

function capWithout(chatIds: readonly string[], excluded: string): string[] {
  return chatIds.filter((id) => id !== excluded).slice(-MAX_PANE_HISTORY);
}

/** The history `target` takes over when it replaces `current` in a pane. Opening a new chat pushes
 *  `current` onto Back and clears Forward; stepping moves `current`, and any chats skipped, across. */
export function nextPaneHistory(
  entry: PaneHistoryEntry | undefined,
  current: string | null,
  target: string,
  direction?: PaneNavDirection,
): PaneHistoryEntry {
  const back = entry?.back ?? [];
  const forward = entry?.forward ?? [];
  const toward = direction === 'forward' ? forward : back;
  const index = direction ? toward.indexOf(target) : -1;
  if (index === -1) {
    return { back: capWithout(current ? [...back, current] : back, target), forward: [] };
  }
  const passed = [...(current ? [current] : []), ...toward.slice(index + 1).reverse()];
  const stepped = capWithout(toward.slice(0, index), target);
  const away = capWithout([...(direction === 'forward' ? back : forward), ...passed], target);
  return direction === 'forward'
    ? { back: away, forward: stepped }
    : { back: stepped, forward: away };
}
