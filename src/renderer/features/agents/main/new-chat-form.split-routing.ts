import { isFillablePane, NEW_CHAT_PANE, type SplitViewState } from '../atoms';

/**
 * Computes the pane index that will receive a new chat in split view.
 *
 * Priority 1: the pane showing the NewChatForm (NEW_CHAT_PANE sentinel) — user submitted from there.
 * Priority 2: the first fillable pane (null empty placeholder).
 *
 * Used by onSuccess to snapshot filledPaneIndex before setSplitView fires (needed for seeding
 * per-chat atoms at the right pane index before the pane map is cleaned up).
 */
export function resolveFillPaneIndex(chatIds: (string | null)[], newChatId: string): number | null {
  if (chatIds.length < 2 || chatIds.includes(newChatId)) return null;

  const newChatPaneIdx = chatIds.indexOf(NEW_CHAT_PANE);
  if (newChatPaneIdx !== -1) return newChatPaneIdx;

  const emptyIdx = chatIds.findIndex(isFillablePane);
  return emptyIdx !== -1 ? emptyIdx : null;
}

/**
 * Produces the updated split state when a new chat is created via NewChatForm.
 * Mirrors resolveFillPaneIndex — used as the setSplitView functional updater in onSuccess.
 */
export function fillNewChatInSplitState(prev: SplitViewState, newChatId: string): SplitViewState {
  if (prev.chatIds.length < 2 || prev.chatIds.includes(newChatId)) return prev;

  const newChatPaneIdx = prev.chatIds.indexOf(NEW_CHAT_PANE);
  if (newChatPaneIdx !== -1) {
    const newChatIds = [...prev.chatIds];
    newChatIds[newChatPaneIdx] = newChatId;
    return { ...prev, chatIds: newChatIds, activePaneIndex: newChatPaneIdx };
  }

  const emptyIdx = prev.chatIds.findIndex(isFillablePane);
  if (emptyIdx !== -1) {
    const newChatIds = [...prev.chatIds];
    newChatIds[emptyIdx] = newChatId;
    return { ...prev, chatIds: newChatIds, activePaneIndex: emptyIdx };
  }

  return prev;
}
