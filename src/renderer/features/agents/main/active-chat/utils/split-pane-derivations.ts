import type { SplitViewState } from '../../../atoms';
import type { SubChatMeta } from '../../../stores/sub-chat-store';

/**
 * In split view each pane derives its "active" subchat from the tRPC query
 * (first subchat of this chat) instead of the global store which is not per-pane.
 * Single-pane mode just passes through the store's activeSubChatId.
 */
export function getEffectiveActiveSubChatId(
  isSplitActive: boolean,
  agentSubChats: SubChatMeta[],
  storeActiveSubChatId: string | null | undefined,
): string | null {
  return isSplitActive ? (agentSubChats[0]?.id ?? null) : (storeActiveSubChatId ?? null);
}

/**
 * "Any visible pane" visibility test. In split view a chat counts as visible when it
 * occupies any pane; single-pane mode just compares against the selected chat. (chatIds
 * may hold null / the NEW_CHAT_PANE sentinel — includes() with a real id is safe.)
 */
export function isChatVisibleInPanes(
  splitView: SplitViewState,
  selectedChatId: string | null,
  chatId: string,
): boolean {
  return splitView.chatIds.length >= 2
    ? splitView.chatIds.includes(chatId)
    : selectedChatId === chatId;
}
